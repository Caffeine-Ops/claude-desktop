import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useT } from '../../i18n';
import type { AppConfig, DesignSystemSummary } from '../../types';
import {
  fetchDesignSystems,
  importGitHubDesignSystem,
  importLocalDesignSystem,
} from '../../providers/registry';
import { DesignSystemPreviewModal } from './DesignSystemPreviewModal';
// P2 迁移（2026-07-14）：与 SkillsSection 共享的 .library-filter-select 筛选下拉
// 整组迁 Radix Select——原生 select 的操作系统弹层换成 chat 的统一弹层，搜索框
// 换 shadcn Input（透明底 + 柔光 ring）。原语自带 data-slot 豁免 canvas reset。
import { Input } from '@/src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/src/components/ui/select';
// P3 迁移（2026-07-21）：卡片本体换 shadcn Switch + Tailwind utility——
// design-system/ 目录已在 chat/styles/index.css 的 scoped @source 里
// （2026-07-14 加入），可以放心用。.ds-grid/.library-ds-card 系列 legacy
// 类整体退役，避免 .ds-grid 的双重定义撞名坑（design-system-flow.css 与
// new-project-connectors.css 各有一份，此组件实际吃的是后者）。
import { Switch } from '@/src/components/ui/switch';
import { cn } from '@/src/lib/utils';

// Sibling Settings section that hosts the design-systems registry.
// Lifted out of the previous LibrarySection so each surface (functional
// skills vs. design systems) gets its own dedicated nav entry instead of
// sharing a sub-tab toggle. See specs/current/skills-and-design-templates.md.

interface Props {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}

function toggleCraftSlug(current: string[], slug: string, enabled: boolean): string[] {
  const next = new Set(current);
  if (enabled) next.add(slug);
  else next.delete(slug);
  return Array.from(next);
}

// swatches 是 daemon 端 pickSwatchRow() 的产物（apps/daemon/src/design-systems.ts），
// 固定 4 元语义顺序 [bg, support, fg, accent]，长度只会是 0 或 4——不需要在前端
// 用亮度/饱和度启发式去猜色板角色，直接按位取用即可。
function hexToAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// 卡片顶部的迷你预览——用该设计系统自己的色板渲染一个示意小场景，替代旧版
// 四个色点（.library-ds-swatch）。数据缺失（极少数 DESIGN.md 一个颜色 token
// 都提取不出来）时不编造色板，退化成中性占位块。
function DesignSystemMiniPreview({ swatches }: { swatches?: string[] }) {
  if (!swatches || swatches.length < 4) {
    return <div className="m-2 h-[104px] rounded-lg bg-muted shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]" />;
  }
  const [bg, support, fg, accent] = swatches;
  return (
    <div
      className="relative m-2 h-[104px] overflow-hidden rounded-lg shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]"
      style={{ background: bg }}
    >
      <div className="absolute left-3 top-2.5 flex gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="block h-1 w-1 rounded-full" style={{ background: hexToAlpha(fg, 0.3) }} />
        ))}
      </div>
      <span className="absolute right-3 top-2.5 h-2 w-6 rounded-full" style={{ background: accent }} />
      <div
        className="absolute inset-x-3 top-7 bottom-2.5 flex flex-col gap-1.5 rounded-md p-2.5"
        style={{ background: support }}
      >
        <span className="h-1.5 w-3/5 rounded-full" style={{ background: hexToAlpha(fg, 0.85) }} />
        <span className="h-1 w-4/5 rounded-full" style={{ background: hexToAlpha(fg, 0.28) }} />
        <span className="mt-auto h-2.5 w-9 rounded-full" style={{ background: accent }} />
      </div>
    </div>
  );
}

export function DesignSystemsSection({ cfg, setCfg }: Props) {
  const t = useT();
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[]>([]);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [previewSystem, setPreviewSystem] = useState<DesignSystemSummary | null>(null);
  const [importPath, setImportPath] = useState('');
  const [importSource, setImportSource] = useState<'local' | 'github'>('local');
  const [packageImportMode, setPackageImportMode] = useState<'normalized' | 'hybrid' | 'verbatim'>('hybrid');
  const [craftApplies, setCraftApplies] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [showOnlyHidden, setShowOnlyHidden] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importedDesignSystem, setImportedDesignSystem] = useState<DesignSystemSummary | null>(null);
  const [highlightedDesignSystemId, setHighlightedDesignSystemId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    fetchDesignSystems().then(setDesignSystems);
  }, []);

  const disabledDS = useMemo(
    () => new Set(cfg.disabledDesignSystems ?? []),
    [cfg.disabledDesignSystems],
  );
  const hiddenDesignSystemCount = useMemo(
    () => designSystems.filter((system) => disabledDS.has(system.id)).length,
    [designSystems, disabledDS],
  );

  const categories = useMemo(() => {
    const cats = new Set(designSystems.map((d) => d.category));
    return ['All', ...Array.from(cats).sort()];
  }, [designSystems]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return designSystems.filter((d) => {
      if (showOnlyHidden && !disabledDS.has(d.id)) return false;
      if (categoryFilter !== 'All' && d.category !== categoryFilter) return false;
      if (
        q &&
        !d.title.toLowerCase().includes(q) &&
        !d.summary.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [designSystems, categoryFilter, disabledDS, search, showOnlyHidden]);

  const grouped = useMemo(() => {
    const groups = new Map<string, DesignSystemSummary[]>();
    for (const d of filtered) {
      const list = groups.get(d.category) ?? [];
      list.push(d);
      groups.set(d.category, list);
    }
    return groups;
  }, [filtered]);

  useEffect(() => {
    if (!highlightedDesignSystemId) return;
    const raf = window.requestAnimationFrame(() => {
      cardRefs.current.get(highlightedDesignSystemId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    });
    const timeout = window.setTimeout(() => {
      setHighlightedDesignSystemId((current) =>
        current === highlightedDesignSystemId ? null : current,
      );
    }, 2200);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timeout);
    };
  }, [filtered, highlightedDesignSystemId]);

  useEffect(() => {
    if (hiddenDesignSystemCount === 0) setShowOnlyHidden(false);
  }, [hiddenDesignSystemCount]);

  function toggleDSDisabled(id: string, enabled: boolean) {
    setCfg((c) => {
      const set = new Set(c.disabledDesignSystems ?? []);
      if (enabled) set.delete(id);
      else set.add(id);
      return { ...c, disabledDesignSystems: [...set] };
    });
  }

  function clearImportFeedback() {
    setImportError(null);
    setImportMessage(null);
    setImportedDesignSystem(null);
  }

  async function handleLocalImport(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const importTarget = importPath.trim();
    if (!importTarget || importing) return;
    setImporting(true);
    setImportError(null);
    setImportMessage(null);
    setImportedDesignSystem(null);
    const importOptions = {
      importMode: packageImportMode,
      craftApplies,
    };
    const result =
      importSource === 'github'
        ? await importGitHubDesignSystem({ githubUrl: importTarget, ...importOptions })
        : await importLocalDesignSystem({ baseDir: importTarget, ...importOptions });
    setImporting(false);
    if ('error' in result) {
      setImportError(result.error.message);
      return;
    }
    setDesignSystems((current) => {
      const withoutDuplicate = current.filter((system) => system.id !== result.designSystem.id);
      return [...withoutDuplicate, result.designSystem].sort((a, b) => a.title.localeCompare(b.title));
    });
    setPreviewSystem(null);
    setImportPath('');
    setImportedDesignSystem(result.designSystem);
    setImportMessage(result.designSystem.title);
  }

  function viewImportedDesignSystem() {
    if (!importedDesignSystem) return;
    setSearch('');
    setShowOnlyHidden(false);
    setCategoryFilter(importedDesignSystem.category);
    setPreviewSystem(null);
    setHighlightedDesignSystemId(importedDesignSystem.id);
  }

  function toggleShowOnlyHidden() {
    setShowOnlyHidden((current) => {
      const next = !current;
      if (next) {
        setSearch('');
        setCategoryFilter('All');
      }
      return next;
    });
  }

  return (
    <section className="settings-section settings-design-systems">
      <div className="library-section-header">
        <h4 className="library-section-title">
          {t('settings.designSystemsInstalled')}{' '}
          <span className="library-section-count">{designSystems.length}</span>
        </h4>
        <button
          type="button"
          className="primary-ghost library-add-btn"
          aria-expanded={addOpen}
          onClick={() => setAddOpen((v) => !v)}
        >
          <span aria-hidden="true" className="library-add-btn-icon">+</span>
          <span>{t('settings.designSystemsAdd')}</span>
        </button>
      </div>
      {hiddenDesignSystemCount > 0 ? (
        <div className="library-hidden-banner">
          <span>
            {t('settings.designSystemsHiddenCount', { count: hiddenDesignSystemCount })}
          </span>
          <button
            type="button"
            className="library-hidden-banner-link"
            onClick={toggleShowOnlyHidden}
          >
            {showOnlyHidden
              ? t('settings.designSystemsShowAll')
              : t('settings.designSystemsShowHidden')}
          </button>
        </div>
      ) : null}

      <div className={`accordion-collapsible library-add-panel${addOpen ? ' open' : ''}`}>
        <div className="accordion-collapsible-inner">
          <form className="library-install-form" onSubmit={handleLocalImport}>
            <div className="library-import-controls">
              <div className="library-import-row">
                <span className="library-import-option-label">
                  {t('settings.designSystemsSource')}
                </span>
                <div className="seg-control library-import-source-control">
                  <button
                    type="button"
                    className={importSource === 'local' ? 'active' : ''}
                    onClick={() => {
                      setImportSource('local');
                      clearImportFeedback();
                    }}
                  >
                    {t('settings.designSystemsSourceLocal')}
                  </button>
                  <button
                    type="button"
                    className={importSource === 'github' ? 'active' : ''}
                    onClick={() => {
                      setImportSource('github');
                      clearImportFeedback();
                    }}
                  >
                    {t('settings.designSystemsSourceGithub')}
                  </button>
                </div>
              </div>
              <div className="library-import-row">
                <span className="library-import-option-label">
                  {t('settings.designSystemsStructure')}
                </span>
                <div className="seg-control library-import-mode-control">
                  <button
                    type="button"
                    className={packageImportMode === 'hybrid' ? 'active' : ''}
                    onClick={() => setPackageImportMode('hybrid')}
                  >
                    {t('settings.designSystemsModeHybrid')}
                  </button>
                  <button
                    type="button"
                    className={packageImportMode === 'normalized' ? 'active' : ''}
                    onClick={() => setPackageImportMode('normalized')}
                  >
                    {t('settings.designSystemsModeNormalized')}
                  </button>
                  <button
                    type="button"
                    className={packageImportMode === 'verbatim' ? 'active' : ''}
                    onClick={() => setPackageImportMode('verbatim')}
                  >
                    {t('settings.designSystemsModeVerbatim')}
                  </button>
                </div>
              </div>
              <div className="library-import-row">
                <span className="library-import-option-label">
                  {t('settings.designSystemsCraft')}
                </span>
                <div className="library-import-checkboxes">
                  <label className="library-import-checkbox">
                    <input
                      type="checkbox"
                      checked={craftApplies.includes('color')}
                      onChange={(e) =>
                        setCraftApplies((current) =>
                          toggleCraftSlug(current, 'color', e.target.checked),
                        )
                      }
                    />
                    <span>{t('settings.designSystemsCraftColor')}</span>
                  </label>
                  <label className="library-import-checkbox">
                    <input
                      type="checkbox"
                      checked={craftApplies.includes('accessibility-baseline')}
                      onChange={(e) =>
                        setCraftApplies((current) =>
                          toggleCraftSlug(current, 'accessibility-baseline', e.target.checked),
                        )
                      }
                    />
                    <span>{t('settings.designSystemsCraftAccessibility')}</span>
                  </label>
                </div>
              </div>
              <div className="library-import-row">
                <span className="library-import-option-label">
                  {importSource === 'github'
                    ? t('settings.designSystemsGithubUrl')
                    : t('settings.designSystemsProjectPath')}
                </span>
                <div className="library-install-row">
                  <input
                    type="text"
                    className="library-import-input"
                    placeholder={importSource === 'github' ? 'https://github.com/owner/repo' : '/path/to/project'}
                    value={importPath}
                    onChange={(e) => {
                      setImportPath(e.target.value);
                      clearImportFeedback();
                    }}
                  />
                  <button
                    type="submit"
                    className="library-install-submit"
                    disabled={importing || importPath.trim().length === 0}
                  >
                    {importing
                      ? t('settings.libraryLoading')
                      : importSource === 'github'
                        ? t('settings.designSystemsImportGithub')
                        : t('settings.designSystemsImportProject')}
                  </button>
                </div>
              </div>
            </div>
            {importError ? <p className="library-install-error">{importError}</p> : null}
            {importMessage ? (
              <p className="library-install-status">
                <span>{t('settings.designSystemsImportedStatus', { title: importMessage })}</span>
                {importedDesignSystem ? (
                  <button
                    type="button"
                    className="library-install-status-link"
                    onClick={viewImportedDesignSystem}
                  >
                    {t('settings.designSystemsViewImported')}
                  </button>
                ) : null}
              </p>
            ) : null}
          </form>
        </div>
      </div>

      {/* 筛选栏（P2 迁移）：搜索 Input + 分类 Radix Select，flex 行用 utility 重建
          （取代 legacy .library-toolbar / .library-search / .library-filter-select）。 */}
      <div className="flex items-center gap-2">
        <Input
          type="search"
          placeholder={t('settings.librarySearch')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1"
        />
        <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v)}>
          <SelectTrigger
            aria-label={t('settings.designSystemsCategory')}
            data-active={categoryFilter !== 'All' ? 'true' : undefined}
            className="w-[180px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {categories.map((cat) => {
              const count =
                cat === 'All'
                  ? designSystems.length
                  : designSystems.filter((d) => d.category === cat).length;
              return (
                <SelectItem key={cat} value={cat}>
                  {cat === 'All' ? t('settings.designSystemsAllCategories') : cat} ({count})
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      <div className="library-content">
        {filtered.length === 0 ? (
          <p className="library-empty">{t('settings.libraryNoResults')}</p>
        ) : (
          <>
            {Array.from(grouped.entries()).map(([category, items]) => (
              <div key={category} className="library-group">
                {categoryFilter === 'All' ? (
                  <h4 className="library-group-title">
                    {category}{' '}
                    <span className="library-group-count">{items.length}</span>
                  </h4>
                ) : null}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
                  {items.map((ds) => {
                    const isOff = disabledDS.has(ds.id);
                    const isHighlighted = highlightedDesignSystemId === ds.id;
                    return (
                      <div
                        key={ds.id}
                        ref={(node) => {
                          if (node) cardRefs.current.set(ds.id, node);
                          else cardRefs.current.delete(ds.id);
                        }}
                        className={cn(
                          'relative flex flex-col rounded-xl border bg-card shadow-sm transition-all duration-200',
                          !isHighlighted && 'border-border',
                          isOff ? 'opacity-45' : 'hover:-translate-y-0.5 hover:shadow-md',
                          isHighlighted && 'border-accent bg-accent/5 ring-2 ring-accent/20',
                        )}
                      >
                        <div
                          className="flex flex-1 cursor-pointer flex-col rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                          role="button"
                          tabIndex={0}
                          aria-haspopup="dialog"
                          onClick={() => setPreviewSystem(ds)}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter' && e.key !== ' ') return;
                            e.preventDefault();
                            setPreviewSystem(ds);
                          }}
                        >
                          <DesignSystemMiniPreview swatches={ds.swatches} />
                          <div className="flex items-start gap-2.5 px-3.5 pb-3 pt-1">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13.5px] font-semibold text-foreground">
                                {ds.title}
                              </div>
                              <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
                                {ds.summary}
                              </p>
                            </div>
                            <Switch
                              size="sm"
                              className="mt-0.5 shrink-0"
                              checked={!isOff}
                              // 开关坐在外层 role="button" 卡片内部（点卡片开预览、点开关只切
                              // 显隐两件事互不干扰）——click 和 keydown 都要挡，否则 Tab 到开关
                              // 按空格会同时把开关切了又把预览模态弹出来。
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                              onCheckedChange={(checked) => toggleDSDisabled(ds.id, checked)}
                              aria-label={t('settings.designSystemsShowInHomeGallery')}
                              title={t('settings.designSystemsShowInHomeGallery')}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      {previewSystem ? (
        <DesignSystemPreviewModal
          system={previewSystem}
          onClose={() => setPreviewSystem(null)}
        />
      ) : null}
    </section>
  );
}
