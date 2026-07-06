/**
 * 内容级召回（#2）的纯核心：分词 / 分块 / BM25 排序，全部无 fs / electron 依赖，可在
 * `bun test` 里直接单测。proposalRetrieve.ts 负责读镜像文件、调本核心、渲染注入块。
 *
 * 选关键词/BM25（离线、无模型）：方案立身于「忠实搬运」，正文与原文词面高度重合，关键词
 * 召回足以拿下多数场景。已知局限：词汇不匹配（需求说「问诊」、文件写「预诊流程」）召回不
 * 到——那是 embedding 的活，列为后续升级（见 #2 spec Out of Scope）。
 */

/** 一个待排序的文本块 + 它的来源（文件 title / 镜像路径）。 */
export interface RetrievalChunk {
  text: string
  title: string
  mirrorPath: string
}

/** 一条召回命中：块 + 来源 + BM25 分。 */
export interface RetrievedPassage extends RetrievalChunk {
  score: number
}

export interface RetrieveOpts {
  /** 取前 K 条，默认 5。 */
  topK?: number
  /** 最低分阈值（严格大于才保留），默认 0——只滤掉零命中噪声。 */
  minScore?: number
}

/** 单块长度上限（字符）：超长块按窗口切，避免一个巨块吃满注入预算。 */
export const CHUNK_MAX = 600

/**
 * 单条召回片段【注入提示词】的字符硬上限。远大于 {@link CHUNK_MAX}：普通块（≤600）从不触及，
 * 给整块表格留足空间。设它是因为表格块在 chunkText 里【整块保形、绕过 CHUNK_MAX】（见那里
 * 注释），而下游 rankChunks 只按 topK 截【条数】、无 per-passage 字节上限——一个 xlsx/spec 转
 * 出的病态巨表（几十 KB）会成单个无界块，进 top-K 后被原样拼进用户回合，独占注入预算、挤掉
 * 其它召回甚至撑爆提示词（评审发现）。故在注入收口按行边界把单片段截到此上限。
 */
export const PASSAGE_MAX_CHARS = 4000

/**
 * 把单条召回片段截到 {@link PASSAGE_MAX_CHARS} 以内再注入。未超限 → 原样。超限 → 截到上限内
 * 的【最后一个换行边界】（保完整行、不切碎表格最后一行），尾部补省略标记。纯函数、可单测。
 * 只影响【注入呈现】，不改 chunkText 的块（BM25 仍对整块打分）——保形与防爆两者兼得。
 */
export function clampPassageText(text: string): string {
  if (text.length <= PASSAGE_MAX_CHARS) return text
  const head = text.slice(0, PASSAGE_MAX_CHARS)
  const lastNl = head.lastIndexOf('\n')
  const kept = lastNl > 0 ? head.slice(0, lastNl) : head
  return `${kept}\n…（片段过长，余下已省略）`
}
/** 合并短块的下限：连续短段拼到 ≥ 此长度再断，避免一句一块的碎片。 */
export const CHUNK_MIN = 80

/**
 * 中文按字符 bigram、ASCII 按词（小写）分词。带重复（用于 tf 统计）。
 * - ASCII：按非字母数字切，小写。
 * - CJK：连续汉字段内取 2-gram；单字段（长度 1）退化为该单字本身。
 * 其它字符（标点/空白）作为分隔，不产 term。
 */
export function tokenize(s: string): string[] {
  if (!s) return []
  const terms: string[] = []
  for (const w of s.toLowerCase().match(/[a-z0-9]+/g) ?? []) terms.push(w)
  for (const run of s.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) {
      terms.push(run)
      continue
    }
    for (let i = 0; i + 2 <= run.length; i++) terms.push(run.slice(i, i + 2))
  }
  return terms
}

/**
 * 判定一个块是否为 GFM 表格：存在一行「分隔行」——只由 | : - 空白组成、含至少一段 ≥3 个
 * 连字符、且含管道符 `|`。要求含 `|` 是为把表格分隔行与普通水平分割线 `---`（thematicBreak，
 * 无管道符）区分开，后者不该被当表格、仍走窗口硬切。
 */
function isTableBlock(block: string): boolean {
  return block
    .split('\n')
    .some((line) => line.includes('|') && /^\s*\|?[\s|:-]*-{3,}[\s|:-]*\|?\s*$/.test(line))
}

/** 一个检索块 + 它在原文中的字符区间（用于 RRF 行号对齐：离线 embed 与查询共用同一套块）。 */
export interface TextChunk {
  text: string
  charStart: number
  charEnd: number
}

/**
 * 与 {@link chunkText} 同算法，但额外返回每块在【原文】中的字符区间 [charStart,charEnd)。
 * 区间对齐到 trim 前的边界：slice(charStart,charEnd).trim() === text。offset 让离线向量化
 * 与查询期 BM25 落到同一套块、用行号对齐 RRF（见 proposalSemantic.core.ts）。
 */
export function chunkTextWithOffsets(text: string): TextChunk[] {
  if (!text) return []
  const out: TextChunk[] = []
  // 用带捕获的分隔正则切段，同时累计绝对偏移。\n\s*\n 作为段分隔（与 chunkText 同义）。
  const sep = /\n\s*\n/g
  const segs: { raw: string; start: number }[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = sep.exec(text)) !== null) {
    segs.push({ raw: text.slice(last, m.index), start: last })
    last = m.index + m[0].length
  }
  segs.push({ raw: text.slice(last), start: last })

  // 把 raw 段 trim 成块；短段合并、超长段按 CHUNK_MAX 窗口/表格保形——与 chunkText 一致，
  // 但携带绝对偏移。合并块的区间取 [首段trim起点, 末段trim终点)。
  type Pending = { text: string; start: number; end: number }
  let buf: Pending | null = null
  const push = (p: Pending): void => { out.push({ text: p.text, charStart: p.start, charEnd: p.end }) }
  const flush = (): void => {
    if (buf) { push(buf); buf = null }
  }
  const trimRange = (raw: string, base: number): { t: string; s: number; e: number } => {
    const lead = raw.length - raw.trimStart().length
    const t = raw.trim()
    return { t, s: base + lead, e: base + lead + t.length }
  }
  for (const seg of segs) {
    const { t, s, e } = trimRange(seg.raw, seg.start)
    if (!t) continue
    if (t.length >= CHUNK_MAX) {
      flush()
      // 表格保形：大表整块保留，绝不按定长窗口硬切（那会把行/单元格/分隔行劈碎，召回片段
      // 里表格就不成形了）。代价是单个巨表块可能超 CHUNK_MAX——可接受：上游 retrievePassages
      // 还有 MAX_FILES / MAX_TOTAL_BYTES 兜注入预算，且巨表本就该整块呈现。
      if (isTableBlock(t)) push({ text: t, start: s, end: e })
      else for (let i = 0; i < t.length; i += CHUNK_MAX)
        push({ text: t.slice(i, i + CHUNK_MAX), start: s + i, end: s + Math.min(i + CHUNK_MAX, t.length) })
      continue
    }
    if (!buf) { buf = { text: t, start: s, end: e } }
    else {
      const merged = `${buf.text}\n\n${t}`
      if (merged.length > CHUNK_MAX) { flush(); buf = { text: t, start: s, end: e } }
      else { buf.text = merged; buf.end = e }
    }
    // 累计到下限即断：只把【过短的碎段】粘在一起，buf 一旦够长就成块，避免把整篇文档
    // 合并成一个巨块（那样 BM25 失去区分度）。典型段落（≥CHUNK_MIN）因此各自成块。
    if (buf && buf.text.length >= CHUNK_MIN) flush()
  }
  flush()
  return out
}

/**
 * 把一篇文本切成检索块：先按空行切段，连续短段合并到 ≥ {@link CHUNK_MIN}（但不超
 * {@link CHUNK_MAX}），单段超 CHUNK_MAX 的按定长窗口硬切。返回非空块数组。
 * 实现为 {@link chunkTextWithOffsets} 的 text 投影——两者使用同一套分块边界，
 * 保证 BM25 与向量检索跑同一套块（RRF 行号对齐前提）。
 */
export function chunkText(text: string): string[] {
  return chunkTextWithOffsets(text).map((c) => c.text)
}

/**
 * BM25 给 chunks 按 query 打分，返回 score 严格大于 minScore 的 top-K（降序）。
 * 标准参数 k1=1.5、b=0.75。corpus = 传入的全部 chunks（即时扫的几个产品文件分块）。
 * query / chunk 同法 {@link tokenize}。query 无 term 或 chunks 为空 → []。
 */
export function rankChunks(
  query: string,
  chunks: RetrievalChunk[],
  opts?: RetrieveOpts
): RetrievedPassage[] {
  const topK = opts?.topK ?? 5
  const minScore = opts?.minScore ?? 0
  const qTerms = [...new Set(tokenize(query))]
  if (qTerms.length === 0 || chunks.length === 0) return []

  const k1 = 1.5
  const b = 0.75
  const tfMaps = chunks.map((c) => {
    const m = new Map<string, number>()
    for (const t of tokenize(c.text)) m.set(t, (m.get(t) ?? 0) + 1)
    return m
  })
  const lens = tfMaps.map((m) => {
    let n = 0
    for (const v of m.values()) n += v
    return n
  })
  const N = chunks.length
  const avgdl = lens.reduce((s, n) => s + n, 0) / N || 1
  // df：含某 query term 的块数。
  const df = new Map<string, number>()
  for (const qt of qTerms) {
    let d = 0
    for (const m of tfMaps) if (m.has(qt)) d++
    df.set(qt, d)
  }

  const scored: RetrievedPassage[] = chunks.map((c, i) => {
    const dl = lens[i] || 1
    let score = 0
    for (const qt of qTerms) {
      const n = df.get(qt)!
      if (n === 0) continue
      const tf = tfMaps[i].get(qt) ?? 0
      if (tf === 0) continue
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgdl)))
    }
    return { ...c, score }
  })

  return scored
    .filter((s) => s.score > minScore)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, topK)
}
