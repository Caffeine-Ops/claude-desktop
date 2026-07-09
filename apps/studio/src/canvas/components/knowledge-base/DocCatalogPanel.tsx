/*
 * DocCatalogPanel —— 知识库页「文档识别 / 图片识别」共用内容区（domain prop 选域）：
 * 读该域索引（KB-INDEX.json / KB-IMAGE-INDEX.json），按自定义类别渲染分类卡片
 * （类别名 + 计数 + 文件列表）；「更新知识库」按钮触发 main 侧后台任务（扫授权
 * 目录 → SDK 无头归类 → 全量重写该域索引），进度经 KB_CATALOG_STATUS 推送
 * （payload 带 domain，本组件只消费自己域的推送）驱动按钮态与进度文案。
 *
 * 数据流约定：
 *  - mount 拉一次 getKbCatalog({domain})（catalog + 当前任务状态，覆盖「页面在
 *    任务中途打开」的场景）；此后 status 全靠订阅推送。
 *  - 推送到 success 时重拉 catalog——索引文件刚被 main 重写，本地副本已旧。
 *  - catalog 为 null 且无任务在跑 = 从没建过索引 → 居中 CTA 空态。
 *  - 图片域额外批量拉 160px 缩略图（KB_IMAGE_THUMBS，只拉各卡片可见行）；
 *    拉不到的（损坏/svg）回落文件图标占位——预览是装饰不是数据。
 *
 * 样式纪律同 AllFilesPanel 头注释（纯 shadcn + utility；头部工具行 no-drag）。
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, FolderKanban, Images, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/src/components/ui/button';
import { cn } from '@/src/lib/utils';
import {
  DEFAULT_KB_CATEGORIES,
  DEFAULT_KB_IMAGE_CATEGORIES,
  type KbCatalog,
  type KbCatalogDomain,
  type KbCatalogEntry,
  type KbCatalogStatus,
} from '@desktop-shared/kbCatalog';
import { FileGlyph } from './FileGlyph';

/** 每张类别卡片最多直接列出的文件数，其余折叠成「还有 N 个」。 */
const CARD_MAX_ROWS = 8;

function openDoc(absPath: string): void {
  void window.chatApi?.openPath({ absPath }).then((r) => {
    if (r?.error) console.warn('[kb-catalog] openPath failed:', r.error);
  });
}

function fmtUpdatedAt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function isRunning(s: KbCatalogStatus): boolean {
  return s.phase === 'scanning' || s.phase === 'classifying';
}

function runningLabel(s: KbCatalogStatus): string {
  if (s.phase === 'scanning') return '正在扫描授权文件夹…';
  if (s.phase === 'classifying') return `正在归类 ${s.done}/${s.total}…`;
  return '';
}

function CategoryCard({
  category,
  entries,
  thumbs,
}: {
  category: string;
  entries: KbCatalogEntry[];
  /** 图片域的 path→缩略图 data URL；docs 域恒空 map。 */
  thumbs: ReadonlyMap<string, string>;
}): React.JSX.Element {
  const shown = entries.slice(0, CARD_MAX_ROWS);
  const rest = entries.length - shown.length;
  return (
    <section className="flex flex-col rounded-2xl border border-border/60 bg-card p-4 shadow-xs">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-baseline gap-1.5">
          <h2 className="text-[15px] font-semibold text-foreground">{category}</h2>
          <span className="text-xs text-muted-foreground">{entries.length}</span>
        </div>
        <ChevronRight className="size-4 text-muted-foreground/50" aria-hidden="true" />
      </div>
      <div className="flex flex-col">
        {shown.map((e) => {
          const thumb = thumbs.get(e.path);
          return (
            <div
              key={e.path}
              role="button"
              tabIndex={0}
              // summary 是 agent 单文件添加时写的一句话概览——有就随 tooltip 带出。
              title={e.summary ? `${e.path}\n${e.summary}` : e.path}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none transition-colors hover:bg-secondary/70 focus-visible:bg-secondary/70"
              onClick={() => openDoc(e.path)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  openDoc(e.path);
                }
              }}
            >
              {thumb ? (
                // 缩略图钉浅色底：透明 png 在暗档下不至于糊成一团黑。
                <img
                  src={thumb}
                  alt=""
                  className="size-7 shrink-0 rounded-md border border-border/50 bg-white object-cover"
                />
              ) : (
                <FileGlyph ext={e.ext} className="h-7 w-6 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">
                {e.name}
              </span>
            </div>
          );
        })}
        {rest > 0 && (
          <div className="px-2 pt-1.5 text-xs text-muted-foreground">还有 {rest} 个…</div>
        )}
      </div>
    </section>
  );
}

export function DocCatalogPanel({
  title,
  domain = 'docs',
}: {
  title: string;
  domain?: KbCatalogDomain;
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<KbCatalog | null>(null);
  const [status, setStatus] = useState<KbCatalogStatus>({ phase: 'idle' });
  const [loaded, setLoaded] = useState(false);
  // 卡片顺序 = 分类管理页维护的自定义集合（末位恒「其他」）。拉到前先用该域
  // 出厂默认顶着——首帧顺序偶有跳变可接受，比空白等待强。
  const [categories, setCategories] = useState<readonly string[]>(
    domain === 'images' ? DEFAULT_KB_IMAGE_CATEGORIES : DEFAULT_KB_CATEGORIES,
  );
  /** 图片域缩略图池（path → data URL）。docs 域恒空。 */
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());

  const pull = useCallback(async (): Promise<void> => {
    try {
      const r = await window.chatApi?.getKbCatalog({ domain });
      if (r) {
        setCatalog(r.catalog);
        setStatus(r.status);
      }
    } catch (err) {
      console.warn('[kb-catalog] load failed:', err);
    } finally {
      setLoaded(true);
    }
  }, [domain]);

  useEffect(() => {
    void pull();
    void window.chatApi
      ?.getKbCategories({ domain })
      .then((r) => setCategories(r.categories))
      .catch((err) => console.warn('[kb-catalog] categories load failed:', err));
    // 任务状态实时推送（带 domain，只消费本域的）；success 说明索引刚被
    // 重写，本地 catalog 已旧 → 重拉。
    const off = window.chatApi?.onKbCatalogStatus((p) => {
      if (p.domain !== domain) return;
      setStatus(p.status);
      if (p.status.phase === 'success') void pull();
    });
    return () => off?.();
  }, [pull, domain]);

  const rebuild = (): void => {
    // 立即置本地 running 态：广播推送有一拍延迟，不抢这拍会看到按钮闪一下。
    setStatus({ phase: 'scanning' });
    void window.chatApi?.rebuildKbCatalog({ domain }).catch((err) => {
      console.warn('[kb-catalog] rebuild trigger failed:', err);
      setStatus({ phase: 'error', message: '任务启动失败，请重试', at: Date.now() });
    });
  };

  /** 按自定义类别顺序分组；空类别不出卡片。索引里出现但不在集合的孤儿类别
   *  （只可能来自 agent 越界自造——管理页的删改都会迁移存量）追加在末尾诚实
   *  展示，不静默吞进「其他」（吞了计数就跟索引对不上）。 */
  const groups = useMemo(() => {
    const byCat = new Map<string, KbCatalogEntry[]>();
    for (const e of catalog?.entries ?? []) {
      const list = byCat.get(e.category);
      if (list) list.push(e);
      else byCat.set(e.category, [e]);
    }
    const known = new Set(categories);
    const ordered = categories.map((c) => ({ category: c, entries: byCat.get(c) ?? [] }));
    const orphans = [...byCat.entries()]
      .filter(([c]) => !known.has(c))
      .map(([category, entries]) => ({ category, entries }));
    return [...ordered, ...orphans].filter((g) => g.entries.length > 0);
  }, [catalog, categories]);

  // 图片域：对各卡片「可见行」批量拉缩略图（≤60/次，分批直到覆盖）。只在
  // 分组结果变化后跑；已拉到的路径不重复请求。
  useEffect(() => {
    if (domain !== 'images') return;
    const wanted: string[] = [];
    for (const g of groups) {
      for (const e of g.entries.slice(0, CARD_MAX_ROWS)) {
        if (!thumbs.has(e.path)) wanted.push(e.path);
      }
    }
    if (wanted.length === 0) return;
    let cancelled = false;
    void (async () => {
      const merged = new Map(thumbs);
      for (let i = 0; i < wanted.length; i += 60) {
        try {
          const r = await window.chatApi?.getKbImageThumbs({ paths: wanted.slice(i, i + 60) });
          if (!r) break;
          for (const [p, url] of Object.entries(r.thumbs)) merged.set(p, url);
        } catch (err) {
          console.warn('[kb-catalog] thumbs load failed:', err);
          break;
        }
      }
      if (!cancelled) setThumbs(merged);
    })();
    return () => {
      cancelled = true;
    };
    // thumbs 不进 deps：effect 本身写 thumbs，进了会自触发循环；wanted 的
    // 去重逻辑已保证收敛（第二轮 wanted 为空直接 return）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, groups]);

  const running = isRunning(status);
  const EmptyIcon = domain === 'images' ? Images : FolderKanban;

  return (
    <div>
      {/* 头部工具行落在 46px 拖拽带下缘，交互元素统一 no-drag 挖洞。 */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 [-webkit-app-region:no-drag]">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[26px] font-semibold tracking-[-0.015em] text-foreground">
            {title}
          </h1>
          {catalog && (
            <span className="text-sm text-muted-foreground">({catalog.entries.length})</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {running && (
            <span className="text-xs text-muted-foreground">{runningLabel(status)}</span>
          )}
          {!running && catalog && catalog.updatedAt > 0 && (
            <span className="text-xs text-muted-foreground">
              更新于 {fmtUpdatedAt(catalog.updatedAt)}
            </span>
          )}
          <Button size="sm" className="gap-1.5" disabled={running} onClick={rebuild}>
            <RefreshCw className={cn('size-3.5', running && 'animate-spin')} />
            更新知识库
          </Button>
        </div>
      </div>

      {status.phase === 'error' && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[13px] leading-relaxed text-destructive">
          更新失败：{status.message}——原有索引未受影响，可点「更新知识库」重试。
        </div>
      )}

      {!loaded ? (
        <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
          <Loader2 className="size-6 animate-spin" />
        </div>
      ) : groups.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] items-start gap-4">
          {groups.map((g) => (
            <CategoryCard
              key={g.category}
              category={g.category}
              entries={g.entries}
              thumbs={thumbs}
            />
          ))}
        </div>
      ) : (
        // 空态：没建过索引（或索引为空）。任务在跑时给进度而不是 CTA。
        <div className="flex flex-col items-center gap-4 py-24 text-center">
          <EmptyIcon className="size-10 text-muted-foreground/40" aria-hidden="true" />
          {running ? (
            <span className="text-sm text-muted-foreground">{runningLabel(status)}</span>
          ) : (
            <>
              <div className="max-w-[420px] text-sm leading-relaxed text-muted-foreground">
                还没有建立{domain === 'images' ? '图片' : '文档'}索引。点「更新知识库」，AI
                会把授权文件夹里的{domain === 'images' ? '图片' : '文档'}自动归入{' '}
                {categories.slice(0, -1).join(' / ')} 等类别（可在「分类管理」自定义）。
              </div>
              <Button className="gap-1.5" onClick={rebuild}>
                <RefreshCw className="size-4" />
                更新知识库
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
