/*
 * AllFilesPanel —— 知识库页「全部文件」内容区：扫描授权目录里的文档文件，按月
 * 分组展示，支持 网格/列表 双视图、文件名搜索、筛选（时间范围 / 格式 / 来源）、
 * 扫描目录管理（预设 下载/桌面 可开关 + 任意文件夹可添加/移除）。数据源是
 * main 侧的 KB_LOCAL_DOCS_SCAN（元数据-only，见通道注释）。
 *
 * 交互契约：
 *  - 单击文件 = 交系统默认应用打开（SHELL_OPEN_PATH）；hover 浮出「在 Finder
 *    中显示」小按钮（SHELL_REVEAL_PATH）。不做应用内预览——那是聊天面板的领域。
 *  - 「授权」两条路：预设目录（下载/桌面）首扫触发 macOS TCC 系统弹窗，被拒
 *    落 deniedDirs、顶部横幅指路系统设置；自定义目录经 OS 文件夹选择器添加，
 *    「用户主动选中」本身即授权，选完即可读。
 *  - 目录清单任何变动（开关/增删）后立即 force 重扫——清单即视图数据源。
 *
 * 样式纪律（同 KnowledgeBaseDialog 头注释）：纯 shadcn 原语 + Tailwind utility，
 * 不复用任何 legacy 类。本目录已在 chat 链 @source 白名单内（styles/index.css）。
 * 两条历史教训在此显式遵守：
 *  - useState 初始化器不分支 typeof window（SSR hydration mismatch）——视图偏好
 *    在挂载 effect 里回读 localStorage；
 *  - 头部工具行落在根 layout `.window-drag-strip`（46px drag 带）的下缘，交互
 *    元素一律 [-webkit-app-region:no-drag] 挖洞。
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Filter,
  FolderCog,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  List,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';

import { Button } from '@/src/components/ui/button';
import { Checkbox } from '@/src/components/ui/checkbox';
import { Input } from '@/src/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/src/components/ui/popover';
import { Switch } from '@/src/components/ui/switch';
import { cn } from '@/src/lib/utils';
import { FileGlyph } from './FileGlyph';
import type {
  LocalDocEntry,
  LocalDocsDir,
  LocalDocsScanResult,
} from '@desktop-shared/ipc-channels';

/* ───────────────────────── 常量与工具 ───────────────────────── */

/** 与 main 侧 LOCAL_DOC_EXTS（electron/main/core/localDocsScan.ts）保持一致的
 *  格式清单——renderer 不能 import main 文件，人工镜像并以注释锚定同步义务。 */
const FORMAT_OPTIONS = [
  'doc',
  'docx',
  'txt',
  'md',
  'pdf',
  'xlsx',
  'xls',
  'csv',
  'ppt',
  'pptx',
  'html',
] as const;

const VIEW_STORAGE_KEY = 'kb-all-files:view';

type ViewMode = 'grid' | 'list';

/** 已生效的筛选条件。exts 空数组 = 不限格式；source = 'all' 或目录绝对路径。 */
interface DocFilters {
  exts: string[];
  source: 'all' | string;
  /** yyyy-mm-dd（native date input 值），空串 = 不限。 */
  from: string;
  to: string;
}

const EMPTY_FILTERS: DocFilters = { exts: [], source: 'all', from: '', to: '' };

function isFilterActive(f: DocFilters): boolean {
  return f.exts.length > 0 || f.source !== 'all' || f.from !== '' || f.to !== '';
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function monthLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

/** 展示用路径缩略：macOS 上把 /Users/<name> 折成 ~。其它平台原样（无碍）。 */
function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}

/* 文件类型图标：共用 FileGlyph（与「文档识别」面板同一份，见 FileGlyph.tsx）。 */

/* ───────────────────────── 扫描目录管理弹层 ───────────────────────── */

function DirsPopover({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  // null = 尚未拉取（打开时惰加载——清单可能被别的窗口改过，不缓存跨开合）。
  const [dirs, setDirs] = useState<LocalDocsDir[] | null>(null);
  const [busy, setBusy] = useState(false);

  const mutate = async (run: () => Promise<{ dirs: LocalDocsDir[] } | undefined>): Promise<void> => {
    setBusy(true);
    try {
      const r = await run();
      if (r) {
        setDirs(r.dirs);
        onChanged();
      }
    } catch (err) {
      console.warn('[kb-files] dirs mutation failed:', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) {
          setDirs(null);
          void window.chatApi
            ?.getLocalDocsDirs()
            .then((r) => setDirs(r.dirs))
            .catch((err) => console.warn('[kb-files] dirs load failed:', err));
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          title="扫描目录"
          aria-label="扫描目录"
        >
          <FolderCog className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-4">
        <div className="text-sm font-semibold text-foreground">扫描目录</div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
          从这些文件夹里收集文档。添加新文件夹时在系统选择框里选中即完成授权。
        </div>

        <div className="mt-3 flex flex-col">
          {dirs === null ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : (
            dirs.map((d) => (
              <div key={d.path} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-secondary/50">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[13px] text-foreground">
                    <span className={cn(!d.enabled && 'text-muted-foreground')}>{d.label}</span>
                    {d.preset && (
                      <span className="rounded bg-secondary px-1 py-px text-[10px] leading-4 text-muted-foreground">
                        预设
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground" title={d.path}>
                    {shortPath(d.path)}
                  </div>
                </div>
                {d.preset ? (
                  // 预设目录：开关（停用后仍留在清单里可再开）。
                  <Switch
                    checked={d.enabled}
                    disabled={busy}
                    onCheckedChange={(v) =>
                      void mutate(() =>
                        window.chatApi?.setLocalDocsDir({ path: d.path, enabled: v === true }) ??
                        Promise.resolve(undefined),
                      )
                    }
                    aria-label={`${d.label}参与扫描`}
                  />
                ) : (
                  // 自定义目录：移除（只从清单删掉，不撤销系统层授权）。
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    title="移除此目录"
                    aria-label="移除此目录"
                    disabled={busy}
                    onClick={() =>
                      void mutate(() =>
                        window.chatApi?.setLocalDocsDir({ path: d.path, enabled: false }) ??
                        Promise.resolve(undefined),
                      )
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            ))
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full gap-1.5"
          disabled={busy}
          onClick={() =>
            void mutate(async () => {
              const r = await window.chatApi?.pickLocalDocsDir();
              if (!r) return undefined;
              // 取消选择器（added:null 且清单没变）也刷新本地列表，代价为零；
              // 但只有真正有变化才值得让父组件重扫——added 才是变化信号。
              setDirs(r.dirs);
              return r.added ? { dirs: r.dirs } : undefined;
            })
          }
        >
          <FolderPlus className="size-4" />
          添加文件夹…
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/* ───────────────────────── 筛选弹层 ───────────────────────── */

function FilterPopover({
  applied,
  sourceDirs,
  onApply,
}: {
  applied: DocFilters;
  /** 来源选项 = 本次扫描参与的目录（scan.dirs）。 */
  sourceDirs: LocalDocsDir[];
  onApply: (next: DocFilters) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DocFilters>(applied);
  const active = isFilterActive(applied);

  const toggleExt = (ext: string): void => {
    setDraft((d) => {
      const next = d.exts.includes(ext)
        ? d.exts.filter((e) => e !== ext)
        : [...d.exts, ext];
      // 逐个勾满 = 语义上等于「全部」，收敛回空数组，让「全部」框亮起。
      return { ...d, exts: next.length === FORMAT_OPTIONS.length ? [] : next };
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        // 每次打开以「已生效条件」播种草稿——上次点「取消」丢弃的改动不残留。
        if (v) setDraft(applied);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="relative size-8"
          title="筛选"
          aria-label="筛选"
        >
          <Filter className="size-4" />
          {active && (
            <span className="absolute right-1 top-1 size-1.5 rounded-full bg-[var(--accent-strong)]" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-4">
        <div className="text-sm font-semibold text-foreground">添加筛选条件</div>

        <div className="mt-3 text-xs font-medium text-muted-foreground">按时间</div>
        <div className="mt-1.5 flex items-center gap-2">
          <Input
            type="date"
            value={draft.from}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
            className="h-8 flex-1 text-[13px]"
            aria-label="开始时间"
          />
          <span className="text-muted-foreground">–</span>
          <Input
            type="date"
            value={draft.to}
            onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
            className="h-8 flex-1 text-[13px]"
            aria-label="结束时间"
          />
        </div>

        <div className="mt-4 text-xs font-medium text-muted-foreground">按格式</div>
        <div className="mt-1.5 grid grid-cols-3 gap-x-2 gap-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground">
            <Checkbox
              checked={draft.exts.length === 0}
              onCheckedChange={() => setDraft((d) => ({ ...d, exts: [] }))}
            />
            全部
          </label>
          {FORMAT_OPTIONS.map((ext) => (
            <label
              key={ext}
              className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground"
            >
              <Checkbox checked={draft.exts.includes(ext)} onCheckedChange={() => toggleExt(ext)} />
              {ext}
            </label>
          ))}
        </div>

        <div className="mt-4 text-xs font-medium text-muted-foreground">按来源</div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground">
            {/* 单选语义（来源互斥）但沿用 Checkbox 观感，与参考交互一致。 */}
            <Checkbox
              checked={draft.source === 'all'}
              onCheckedChange={() => setDraft((d) => ({ ...d, source: 'all' }))}
            />
            全部
          </label>
          {sourceDirs.map((dir) => (
            <label
              key={dir.path}
              className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground"
              title={dir.path}
            >
              <Checkbox
                checked={draft.source === dir.path}
                onCheckedChange={() => setDraft((d) => ({ ...d, source: dir.path }))}
              />
              {dir.label}
            </label>
          ))}
        </div>

        <div className="mt-5 flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 px-2 text-muted-foreground"
            onClick={() => setDraft(EMPTY_FILTERS)}
          >
            <RotateCcw className="size-3.5" />
            重置
          </Button>
          <div className="flex-1" />
          <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onApply(draft);
              setOpen(false);
            }}
          >
            确定
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ───────────────────────── 文件项（网格 / 列表） ───────────────────────── */

function openDoc(absPath: string): void {
  void window.chatApi?.openPath({ absPath }).then((r) => {
    if (r?.error) console.warn('[kb-files] openPath failed:', r.error);
  });
}

function revealDoc(absPath: string): void {
  void window.chatApi?.revealPath({ absPath }).then((r) => {
    if (r?.error) console.warn('[kb-files] revealPath failed:', r.error);
  });
}

/** hover 才浮现的「在 Finder 中显示」角标。外层是可点击 div（非 button），
 *  避免 button 嵌套非法 DOM；本体用 shadcn Button 天然带 data-slot。 */
function RevealButton({ absPath, className }: { absPath: string; className?: string }): React.JSX.Element {
  return (
    <Button
      variant="secondary"
      size="icon"
      title="在 Finder 中显示"
      aria-label="在 Finder 中显示"
      className={cn(
        'size-6 rounded-md opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
        className,
      )}
      onClick={(e) => {
        e.stopPropagation();
        revealDoc(absPath);
      }}
    >
      <FolderOpen className="size-3.5" />
    </Button>
  );
}

function GridCard({ file }: { file: LocalDocEntry }): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      title={`${file.absPath}\n${fmtTime(file.mtimeMs)} · ${fmtSize(file.size)}`}
      className="group relative flex cursor-pointer flex-col items-center gap-1.5 rounded-xl p-2.5 outline-none transition-colors hover:bg-secondary/70 focus-visible:bg-secondary/70"
      onClick={() => openDoc(file.absPath)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDoc(file.absPath);
        }
      }}
    >
      <FileGlyph ext={file.ext} className="h-14 w-12" />
      <span className="line-clamp-2 w-full break-all text-center text-xs leading-snug text-foreground/85">
        {file.name}
      </span>
      <RevealButton absPath={file.absPath} className="absolute right-1 top-1" />
    </div>
  );
}

function ListRow({ file, sourceLabel }: { file: LocalDocEntry; sourceLabel: string }): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      title={file.absPath}
      className="group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 outline-none transition-colors hover:bg-secondary/70 focus-visible:bg-secondary/70"
      onClick={() => openDoc(file.absPath)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDoc(file.absPath);
        }
      }}
    >
      <FileGlyph ext={file.ext} className="h-9 w-[30px] shrink-0" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{file.name}</span>
      <RevealButton absPath={file.absPath} className="shrink-0" />
      <span className="max-w-[110px] shrink-0 truncate text-xs text-muted-foreground">
        {sourceLabel}
      </span>
      <span className="w-[118px] shrink-0 text-xs tabular-nums text-muted-foreground">
        {fmtTime(file.mtimeMs)}
      </span>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {fmtSize(file.size)}
      </span>
    </div>
  );
}

/* ───────────────────────── 面板本体 ───────────────────────── */

export function AllFilesPanel({ title }: { title: string }): React.JSX.Element {
  const [scan, setScan] = useState<LocalDocsScanResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<DocFilters>(EMPTY_FILTERS);
  // 初始值恒 'grid'（不读 localStorage）——useState 初始化器分支 window 会
  // hydration mismatch（2026-07-04 教训），偏好在挂载 effect 里回读。
  const [view, setView] = useState<ViewMode>('grid');

  useEffect(() => {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === 'list' || stored === 'grid') setView(stored);
  }, []);

  const changeView = (v: ViewMode): void => {
    setView(v);
    window.localStorage.setItem(VIEW_STORAGE_KEY, v);
  };

  const load = useCallback(async (force: boolean): Promise<void> => {
    if (force) setRefreshing(true);
    try {
      const result = await window.chatApi?.scanLocalDocs(force ? { force: true } : undefined);
      if (result) setScan(result);
    } catch (err) {
      // scanLocalDocs 契约上不 reject；这里兜 IPC 层面的意外（窗口销毁竞态等）。
      console.warn('[kb-files] scan failed:', err);
      setScan({
        ok: false,
        files: [],
        total: 0,
        truncated: false,
        dirs: [],
        deniedDirs: [],
        scannedAt: Date.now(),
        error: '扫描请求失败，请重试',
      });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  /** 目录路径 → 展示名。denied 横幅、列表来源列、（间接）筛选选项共用。 */
  const dirLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of scan?.dirs ?? []) m.set(d.path, d.label);
    return m;
  }, [scan]);

  // 来源筛选指向的目录被停用/移除后自动复位——否则视图静默变空还找不到原因。
  useEffect(() => {
    if (filters.source === 'all' || !scan?.ok) return;
    if (!scan.dirs.some((d) => d.path === filters.source)) {
      setFilters((f) => ({ ...f, source: 'all' }));
    }
  }, [scan, filters.source]);

  const filtered = useMemo(() => {
    const files = scan?.files ?? [];
    const q = query.trim().toLowerCase();
    const fromMs = filters.from ? new Date(`${filters.from}T00:00:00`).getTime() : null;
    const toMs = filters.to ? new Date(`${filters.to}T23:59:59.999`).getTime() : null;
    return files.filter((f) => {
      if (q && !f.name.toLowerCase().includes(q)) return false;
      if (filters.exts.length > 0 && !filters.exts.includes(f.ext)) return false;
      if (filters.source !== 'all' && f.source !== filters.source) return false;
      if (fromMs !== null && f.mtimeMs < fromMs) return false;
      if (toMs !== null && f.mtimeMs > toMs) return false;
      return true;
    });
  }, [scan, query, filters]);

  /** 按月分组。files 已 mtime 降序，单趟线性切段即可，无需二次排序。 */
  const groups = useMemo(() => {
    const out: Array<{ label: string; items: LocalDocEntry[] }> = [];
    for (const f of filtered) {
      const label = monthLabel(f.mtimeMs);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(f);
      else out.push({ label, items: [f] });
    }
    return out;
  }, [filtered]);

  const loading = scan === null;
  const hasAnyDoc = (scan?.files.length ?? 0) > 0;
  const filterActive = isFilterActive(filters) || query.trim() !== '';
  const noDirEnabled = scan?.ok === true && scan.dirs.length === 0;

  return (
    <div>
      {/* 头部工具行落在 46px 拖拽带下缘，交互元素统一 no-drag 挖洞。 */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 [-webkit-app-region:no-drag]">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[26px] font-semibold tracking-[-0.015em] text-foreground">
            {title}
          </h1>
          {scan?.ok && (
            <span className="text-sm text-muted-foreground">({filtered.length})</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索文件名"
              className="h-8 w-48 pl-8 text-[13px]"
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            title="重新扫描"
            aria-label="重新扫描"
            disabled={refreshing}
            onClick={() => void load(true)}
          >
            <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
          </Button>
          <DirsPopover onChanged={() => void load(true)} />
          <FilterPopover applied={filters} sourceDirs={scan?.dirs ?? []} onApply={setFilters} />
          {/* 网格 / 列表切换：分段控件观感，选中格吃 secondary 底。 */}
          <div className="flex items-center rounded-lg border border-border/70 p-0.5">
            <Button
              variant="ghost"
              size="icon"
              className={cn('size-7 rounded-md', view === 'grid' && 'bg-secondary')}
              title="网格视图"
              aria-label="网格视图"
              onClick={() => changeView('grid')}
            >
              <LayoutGrid className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn('size-7 rounded-md', view === 'list' && 'bg-secondary')}
              title="列表视图"
              aria-label="列表视图"
              onClick={() => changeView('list')}
            >
              <List className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* TCC 被拒横幅：假空态是最坑用户的形态，明确指路系统设置。 */}
      {scan && scan.deniedDirs.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-[13px] leading-relaxed text-amber-700 dark:text-amber-400">
          未获得「
          {scan.deniedDirs.map((p) => dirLabel.get(p) ?? shortPath(p)).join('」「')}
          」文件夹的访问权限——请在 系统设置 → 隐私与安全性 → 文件与文件夹
          中允许本应用访问后，点上方「重新扫描」。
        </div>
      )}

      {loading ? (
        <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
          <Loader2 className="size-6 animate-spin" />
          <span className="text-sm">正在扫描授权文件夹…</span>
        </div>
      ) : !scan.ok ? (
        <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
          <span className="text-sm">{scan.error ?? '扫描失败'}</span>
          <Button variant="secondary" size="sm" onClick={() => void load(true)}>
            重试
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
          <span className="text-sm">
            {noDirEnabled
              ? '没有启用中的扫描目录——点上方「扫描目录」添加或打开一个'
              : hasAnyDoc
                ? '没有符合条件的文档'
                : '授权文件夹里还没有可识别的文档文件'}
          </span>
          {hasAnyDoc && filterActive && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setQuery('');
              }}
            >
              清除筛选
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-7">
          {groups.map((g) => (
            <section key={g.label}>
              <div className="mb-2.5 text-[13px] font-medium text-muted-foreground">
                {g.label}
              </div>
              {view === 'grid' ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-x-2 gap-y-4">
                  {g.items.map((f) => (
                    <GridCard key={f.absPath} file={f} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col">
                  {g.items.map((f) => (
                    <ListRow
                      key={f.absPath}
                      file={f}
                      sourceLabel={dirLabel.get(f.source) ?? shortPath(f.source)}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}
          {scan.truncated && (
            <div className="pb-2 text-center text-xs text-muted-foreground">
              文档较多，仅显示最近 {scan.files.length} 个
            </div>
          )}
        </div>
      )}
    </div>
  );
}
