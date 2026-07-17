import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { kindFor } from './projects.js';

const execFileP = promisify(execFile);
const MAX_COMPRESSED_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_UNCOMPRESSED_PREVIEW_BYTES = 50 * 1024 * 1024;
const MAX_XML_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_PDF_PREVIEW_CONCURRENCY = 2;
const pdfPreviewQueue = createLimiter<PreviewSection[]>(MAX_PDF_PREVIEW_CONCURRENCY);

type PreviewKind = 'pdf' | 'document' | 'presentation' | 'spreadsheet';
type PreviewSection = { title: string; lines: string[] };
type PreviewFile = { name: string; buffer: Buffer };
type XmlAttrs = Record<string, string>;
type WorkbookSheet = { name: string; path: string };
type ZipEntryWithSize = JSZip.JSZipObject & {
  _data?: { uncompressedSize?: number };
};

class PreviewHttpError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'PreviewHttpError';
  }
}

type DocumentPreview = {
  kind: PreviewKind;
  title: string;
  sections: PreviewSection[];
};

// ── 预览结果缓存 ────────────────────────────────────────────────────────
// 解析一个 office 文档 = JSZip 解压 + 正则全文匹配（pdf 则 spawn
// pdftotext），同步 CPU 重活跑在 daemon 唯一的事件循环上：单文档
// 1-2.6s（2026-07-16 线上实测），期间所有并发请求排队。而触发方（文件
// 查看器 / 附件上下文）组件一 remount（切会话/切面/切 tab）就重拉同一个
// 没变过的文档——重复解析占绝大多数调用。所以：
//
//   - 由调用方组 cacheKey（路由层用 projectId + 项目内路径 + mtime +
//     size）：文件一改 mtime/size 就变、key 自然换新，无需任何主动失效
//     逻辑；旧 key 条目留在 LRU 里等挤出，不会误命中。
//   - 缓存的是 **Promise**：同一文档的并发请求合并进同一次解析。
//   - reject 时清条目——瞬时失败（损坏 zip、体积超限）不能钉死缓存。
//   - LRU 上限刻意保守：xlsx 的 sections 可能有上万行文本，别让缓存
//     本身变成内存问题。
//   - 不传 cacheKey 就直算，保持旧语义（现有测试与内部消费不受影响）。
const PREVIEW_CACHE_MAX_ENTRIES = 32;
const previewCache = new Map<string, Promise<DocumentPreview>>();

export async function buildDocumentPreview(
  file: PreviewFile,
  options: { cacheKey?: string } = {},
): Promise<DocumentPreview> {
  const { cacheKey } = options;
  if (cacheKey == null) return buildDocumentPreviewUncached(file);
  const hit = previewCache.get(cacheKey);
  if (hit != null) {
    // Map 迭代序 = 插入序；命中时删掉重插到尾部，让 keys() 头部始终是
    // 最久未用的条目——这就是整个 LRU，不需要引库。
    previewCache.delete(cacheKey);
    previewCache.set(cacheKey, hit);
    return hit;
  }
  const promise = buildDocumentPreviewUncached(file);
  previewCache.set(cacheKey, promise);
  promise.catch(() => {
    if (previewCache.get(cacheKey) === promise) previewCache.delete(cacheKey);
  });
  while (previewCache.size > PREVIEW_CACHE_MAX_ENTRIES) {
    const oldest = previewCache.keys().next().value;
    if (oldest == null) break;
    previewCache.delete(oldest);
  }
  return promise;
}

async function buildDocumentPreviewUncached(file: PreviewFile): Promise<DocumentPreview> {
  const kind = kindFor(file.name);
  if (!['pdf', 'document', 'presentation', 'spreadsheet'].includes(kind)) {
    throw new PreviewHttpError('unsupported preview type', 415);
  }
  const previewKind = kind as PreviewKind;

  if (previewKind === 'pdf') {
    return {
      kind: previewKind,
      title: path.basename(file.name),
      sections: await pdfPreviewQueue(() => previewPdf(file.buffer)),
    };
  }

  assertPreviewInputSize(file.buffer.length);
  const zip = await JSZip.loadAsync(file.buffer);
  assertZipPreviewSize(zip);
  if (previewKind === 'document') {
    return {
      kind: previewKind,
      title: path.basename(file.name),
      sections: await previewDocx(zip),
    };
  }
  if (previewKind === 'presentation') {
    return {
      kind: previewKind,
      title: path.basename(file.name),
      sections: await previewPptx(zip),
    };
  }
  return {
    kind: previewKind,
    title: path.basename(file.name),
    sections: await previewXlsx(zip),
  };
}

async function previewPdf(buffer: Buffer): Promise<PreviewSection[]> {
  assertPreviewInputSize(buffer.length);
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'od-preview-'));
  const tmpFile = path.join(tmpDir, 'input.pdf');
  await writeFile(tmpFile, buffer, { flag: 'wx' });
  try {
    const { stdout } = await execFileP('pdftotext', ['-layout', tmpFile, '-'], {
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    return [
      {
        title: 'PDF',
        lines: lines.length > 0 ? lines : ['No readable text found.'],
      },
    ];
  } catch {
    return [
      {
        title: 'PDF',
        lines: ['Text preview is unavailable. Use Open or Download to inspect the PDF.'],
      },
    ];
  } finally {
    rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function previewDocx(zip: JSZip): Promise<PreviewSection[]> {
  const xml = await readZipText(zip, 'word/document.xml');
  const paragraphs = extractParagraphs(xml, /<w:p\b[\s\S]*?<\/w:p>/g);
  return [
    {
      title: 'Document',
      lines: paragraphs.length > 0 ? paragraphs : ['No readable text found.'],
    },
  ];
}

async function previewPptx(zip: JSZip): Promise<PreviewSection[]> {
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(numericPathSort);
  const sections: PreviewSection[] = [];
  for (let i = 0; i < slideNames.length; i += 1) {
    const xml = await readZipText(zip, slideNames[i] ?? '');
    const lines = extractTextRuns(xml);
    sections.push({
      title: `Slide ${i + 1}`,
      lines: lines.length > 0 ? lines : ['No readable text found.'],
    });
  }
  return sections.length > 0
    ? sections
    : [{ title: 'Presentation', lines: ['No readable slides found.'] }];
}

async function previewXlsx(zip: JSZip): Promise<PreviewSection[]> {
  const sharedStrings = await readSharedStrings(zip);
  const workbook = await readWorkbook(zip);
  const sections: PreviewSection[] = [];
  for (const sheet of workbook) {
    const xml = await readZipText(zip, sheet.path).catch(() => '');
    const lines = extractWorksheetRows(xml, sharedStrings);
    sections.push({
      title: sheet.name,
      lines: lines.length > 0 ? lines : ['No readable cell values found.'],
    });
  }
  return sections.length > 0
    ? sections
    : [{ title: 'Spreadsheet', lines: ['No readable sheets found.'] }];
}

async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await readZipText(zip, 'xl/sharedStrings.xml').catch(() => '');
  if (!xml) return [];
  return Array.from(xml.matchAll(/<si\b[\s\S]*?<\/si>/g)).map((m) =>
    extractTextRuns(m[0]).join(''),
  );
}

async function readWorkbook(zip: JSZip): Promise<WorkbookSheet[]> {
  const workbookXml = await readZipText(zip, 'xl/workbook.xml').catch(() => '');
  const relsXml = await readZipText(zip, 'xl/_rels/workbook.xml.rels').catch(() => '');
  const rels = new Map<string, string>();
  for (const rel of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = parseAttrs(rel[1] ?? '');
    if (attrs.Id && attrs.Target) rels.set(attrs.Id, attrs.Target);
  }
  const sheets: WorkbookSheet[] = [];
  for (const sheet of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = parseAttrs(sheet[1] ?? '');
    const relId = attrs['r:id'];
    const target = relId ? rels.get(relId) : null;
    if (!target) continue;
    sheets.push({
      name: attrs.name || `Sheet ${sheets.length + 1}`,
      path: `xl/${target.replace(/^\/?xl\//, '')}`,
    });
  }
  if (sheets.length > 0) return sheets;
  return Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort(numericPathSort)
    .map((name, i) => ({ name: `Sheet ${i + 1}`, path: name }));
}

function extractWorksheetRows(xml: string, sharedStrings: string[]): string[] {
  const rows: string[] = [];
  for (const row of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
    const values: string[] = [];
    for (const cell of row[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = parseAttrs(cell[1] ?? '');
      const body = cell[2] ?? '';
      let value = '';
      if (attrs.t === 's') {
        const idx = Number(extractFirst(body, /<v>([\s\S]*?)<\/v>/));
        value = Number.isInteger(idx) ? sharedStrings[idx] ?? '' : '';
      } else if (attrs.t === 'inlineStr') {
        value = extractTextRuns(body).join('');
      } else {
        value = decodeXml(extractFirst(body, /<v>([\s\S]*?)<\/v>/));
      }
      if (value.trim()) values.push(value.trim());
    }
    if (values.length > 0) rows.push(values.join(' | '));
  }
  return rows;
}

function extractParagraphs(xml: string, paragraphPattern: RegExp): string[] {
  return Array.from(xml.matchAll(paragraphPattern))
    .map((m) => extractTextRuns(m[0]).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function extractTextRuns(xml: string): string[] {
  return Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>|<w:t[^>]*>([\s\S]*?)<\/w:t>|<t[^>]*>([\s\S]*?)<\/t>/g))
    .map((m) => decodeXml(m[1] ?? m[2] ?? m[3] ?? '').trim())
    .filter(Boolean);
}

async function readZipText(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name);
  if (!entry) throw new Error(`missing ${name}`);
  const size = (entry as ZipEntryWithSize)._data?.uncompressedSize ?? 0;
  if (size > MAX_XML_ENTRY_BYTES) {
    throw new PreviewHttpError('document section too large to preview', 413);
  }
  const xml = await entry.async('text');
  assertSafeXml(xml);
  return xml;
}

function parseAttrs(raw: string): XmlAttrs {
  const attrs: XmlAttrs = {};
  for (const m of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    const name = m[1];
    if (!name) throw new Error('XML attribute match invariant violated');
    attrs[name] = decodeXml(m[2] ?? '');
  }
  return attrs;
}

function extractFirst(raw: string, pattern: RegExp): string {
  const m = raw.match(pattern);
  return m ? m[1] ?? '' : '';
}

function decodeXml(raw: unknown): string {
  return String(raw)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function assertPreviewInputSize(size: number): void {
  if (size > MAX_COMPRESSED_PREVIEW_BYTES) {
    throw new PreviewHttpError('document too large to preview', 413);
  }
}

function assertZipPreviewSize(zip: JSZip): void {
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    total += (entry as ZipEntryWithSize)._data?.uncompressedSize ?? 0;
    if (total > MAX_UNCOMPRESSED_PREVIEW_BYTES) {
      throw new PreviewHttpError('document too large to preview', 413);
    }
  }
}

function assertSafeXml(xml: string): void {
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) {
    throw new PreviewHttpError('unsupported XML entities', 415);
  }
}

function createLimiter<T>(limit: number): (task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const pending: Array<{
    task: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  const runNext = () => {
    if (active >= limit || pending.length === 0) return;
    active += 1;
    const next = pending.shift();
    if (!next) throw new Error('preview limiter queue invariant violated');
    const { task, resolve, reject } = next;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      pending.push({ task, resolve, reject });
      runNext();
    });
}

function numericPathSort(a: string, b: string): number {
  const an = Number(a.match(/(\d+)(?=\.xml$)/)?.[1] ?? 0);
  const bn = Number(b.match(/(\d+)(?=\.xml$)/)?.[1] ?? 0);
  return an - bn || a.localeCompare(b);
}
