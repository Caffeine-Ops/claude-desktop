/**
 * 设置页「使用记录」面——对接 sub2api `/api/v1/usage*`，内容层完全复用
 * `src/components/usage/` 下的展示组件（统计卡片/4 图表/筛选器/分页
 * 表格），本文件只是把它们从「全屏 overlay」（2026-07-21 首版 UsageScreen.tsx，
 * 已删除）改嫁到设置页内容面——用户明确要求「加到设置页面做一个菜单
 * 不要弹窗」。挂载点即打开信号：`{activeSection==='usage' ? <UsageSection/> :
 * null}` 本身就是 open/close，不需要再自己维护一份 open 状态或 Esc 处理
 * （设置页自己的返回/Esc 已经覆盖）。
 *
 * 视觉从「HUD 玻璃」的 --lg-* token 系统改回本页统一的 shadcn 语义 token
 * （bg-card/border-border/text-foreground/text-muted-foreground），跟
 * AccountSection 同一套语言；图表强调色从固定品牌绿改成
 * hsl(var(--primary))（随用户主题色走）。布局改单列——设置内容面固定
 * max-w-[760px]（见 SettingsDialogV2 头注释），装不下原来 overlay 版的
 * 2 列图表网格与 4 列统计卡片（分组/Endpoint 分布也不例外，别在这基础上
 * 重新试 2 列——这行是踩过的教训，不是随手写的限制）。
 *
 * 数据抓取沿用 UsageScreen 的「显式命令式函数」纪律：见各 handle* 的
 * 注释，理由不再重复。
 *
 * Sticky 标题栏（2026-07-22，用户拿设计稿要求「滚动时始终看到顶部标题」）：
 * 本 section 自己接管标题渲染，SettingsDialogV2 对 'usage' 跳过它共享的
 * 全局 <h1>（见该文件对应注释）——两个标题分别 sticky 需要精确对齐两者
 * 高度差，脆弱且没必要，不如让这一个 section 自己独占标题位。下方
 * sentinel + IntersectionObserver 是标准「探测 sticky 元素是否已贴顶」
 * 手法：sentinel 是紧贴在 header 前面的 1px 哨兵，一旦它被滚出视口
 * （root 留空即视口——本页是 App 的 fixed inset-0 全屏 overlay，唯一会
 * 滚动的祖先就是这个内容面，没有更外层页面滚动会导致 viewport-root 失真），
 * 就说明 header 已经贴到容器顶部，切换到「贴顶」态（标题缩小 + 出现统计
 * 摘要 + 底部发丝线），逻辑与 HTML 原型（usage-redesign-v0.html）一致。
 */

import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  UsageFilterOptions,
  UsageGroupStat,
  UsageListData,
  UsageModelStat,
  UsageQueryFilters,
  UsageStats,
  UsageTrendPoint,
} from '@desktop-shared/ipc-channels';
import { exportUsageCsv } from '@/src/components/usage/csvExport';
import {
  computeDateRange,
  getGranularityForRange,
  resolveTimezone,
  type UsageDateRange,
  type UsageDateRangePresetKey,
} from '@/src/components/usage/dateRangePresets';
import { UsageDateRangeControls } from '@/src/components/usage/UsageDateRangeControls';
import { UsageFilters, type UsageFilterValues } from '@/src/components/usage/UsageFilters';
import { formatCost, formatCount, UsageStatsCards } from '@/src/components/usage/UsageStatsCards';
import { UsageTable } from '@/src/components/usage/UsageTable';
import { ModelDistributionChart } from '@/src/components/usage/charts/ModelDistributionChart';
import { GroupDistributionChart } from '@/src/components/usage/charts/GroupDistributionChart';
import { EndpointDistributionChart } from '@/src/components/usage/charts/EndpointDistributionChart';
import { TokenUsageTrendChart } from '@/src/components/usage/charts/TokenUsageTrendChart';
import { loadVisibleColumns, saveVisibleColumns } from '@/src/components/usage/usageTableColumns';
import { cn } from '@/src/lib/utils';

const EMPTY_FILTERS: UsageFilterValues = {
  apiKeyId: null,
  model: null,
  groupId: null,
  requestType: null,
  billingType: null,
  billingMode: null,
};

const PAGE_SIZE_STORAGE_KEY = 'claude-desktop:usage-page-size';
const VALID_PAGE_SIZES = [20, 50, 100];

function loadPersistedPageSize(): number {
  if (typeof window === 'undefined') return 20;
  const raw = Number(window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
  return VALID_PAGE_SIZES.includes(raw) ? raw : 20;
}

function persistPageSize(n: number): void {
  try {
    window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(n));
  } catch {
    // 存储失败不影响功能
  }
}

const EMPTY_LIST: UsageListData = { items: [], total: 0, page: 1, pageSize: 20, pages: 1 };

export function UsageSection(): React.JSX.Element {
  const timezone = useMemo(() => resolveTimezone(), []);

  const [presetKey, setPresetKey] = useState<UsageDateRangePresetKey | 'custom'>('last24Hours');
  const [range, setRange] = useState<UsageDateRange>(() => computeDateRange('last24Hours'));
  const [granularityOverride, setGranularityOverride] = useState<'day' | 'hour' | null>(null);
  const granularity = granularityOverride ?? getGranularityForRange(range.startDate, range.endDate);

  const [filterValues, setFilterValues] = useState<UsageFilterValues>(EMPTY_FILTERS);
  const [filterOptions, setFilterOptions] = useState<UsageFilterOptions | null>(null);

  const [stats, setStats] = useState<UsageStats | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [models, setModels] = useState<UsageModelStat[]>([]);
  const [trend, setTrend] = useState<UsageTrendPoint[]>([]);
  const [groups, setGroups] = useState<UsageGroupStat[]>([]);

  const [list, setList] = useState<UsageListData>(EMPTY_LIST);
  const [listLoading, setListLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize());
  const [sortBy, setSortBy] = useState('created_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(() => loadVisibleColumns());
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // sticky 标题栏「是否已贴顶」——见文件头注释的 sentinel 手法。
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function buildQueryFilters(fv: UsageFilterValues, r: UsageDateRange): UsageQueryFilters {
    return {
      startDate: r.startDate,
      endDate: r.endDate,
      timezone,
      apiKeyId: fv.apiKeyId ?? undefined,
      groupId: fv.groupId ?? undefined,
      model: fv.model ?? undefined,
      requestType: fv.requestType ?? undefined,
      billingType: fv.billingType ?? undefined,
      billingMode: fv.billingMode ?? undefined,
    };
  }

  async function fetchDashboard(qf: UsageQueryFilters, gran: 'day' | 'hour') {
    const api = window.chatApi;
    if (!api) return;
    setDashboardLoading(true);
    const [statsRes, modelsRes, snapshotRes] = await Promise.all([
      api.getUsageStats(qf),
      api.getUsageModels(qf),
      api.getUsageSnapshot(qf, gran),
    ]);
    setDashboardLoading(false);
    if (statsRes.ok) setStats(statsRes.data);
    else setError(statsRes.error);
    if (modelsRes.ok) setModels(modelsRes.data.models);
    if (snapshotRes.ok) {
      setTrend(snapshotRes.data.trend);
      setGroups(snapshotRes.data.groups);
    }
  }

  async function fetchList(
    qf: UsageQueryFilters,
    pageArg: number,
    pageSizeArg: number,
    sortByArg: string,
    sortOrderArg: 'asc' | 'desc',
  ) {
    const api = window.chatApi;
    if (!api) return;
    setListLoading(true);
    const res = await api.getUsageList({
      ...qf,
      page: pageArg,
      pageSize: pageSizeArg,
      sortBy: sortByArg,
      sortOrder: sortOrderArg,
    });
    setListLoading(false);
    if (res.ok) setList(res.data);
    else setError(res.error);
  }

  function reloadAll(fv: UsageFilterValues, r: UsageDateRange, gran: 'day' | 'hour') {
    const qf = buildQueryFilters(fv, r);
    setPage(1);
    void fetchDashboard(qf, gran);
    void fetchList(qf, 1, pageSize, sortBy, sortOrder);
  }

  // 挂载即「打开」（本组件只在 activeSection==='usage' 时被渲染，见调用处），
  // 拉一次筛选器下拉数据源 + 当前筛选条件下的全部数据。只在挂载时跑一次
  // ——筛选态变化由各自的 handle* 显式触发 reloadAll。
  useEffect(() => {
    const api = window.chatApi;
    if (!api) return;
    let alive = true;
    void api.getUsageFilterOptions().then((res) => {
      if (alive && res.ok) setFilterOptions(res.data);
    });
    reloadAll(filterValues, range, granularity);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const modelOptions = useMemo(() => {
    const names = Array.from(new Set(models.map((m) => m.model))).sort();
    return names.map((name) => ({ value: name, label: name }));
  }, [models]);
  const apiKeyOptions = useMemo(
    () => (filterOptions?.apiKeys ?? []).map((k) => ({ value: String(k.id), label: k.name })),
    [filterOptions],
  );
  const groupOptions = useMemo(
    () => (filterOptions?.groups ?? []).map((g) => ({ value: String(g.id), label: g.name })),
    [filterOptions],
  );

  const handlePresetChange = (key: UsageDateRangePresetKey | 'custom') => {
    // 'custom' 不是真预设，computeDateRange 的 switch 里没有它的分支
    // （由设计如此，'custom' 无法「算出」范围）——只切态，range 保持当前
    // 值不变，交给下面两个日期输入框（UsageDateRangeControls 的
    // onChangeCustomRange）接手编辑；之前这里把 'custom' 也硬转发进
    // computeDateRange，取到 undefined 后立刻读 .startDate 崩溃。
    if (key === 'custom') {
      setPresetKey('custom');
      setGranularityOverride(null);
      return;
    }
    const nextRange = computeDateRange(key);
    const nextGranularity = getGranularityForRange(nextRange.startDate, nextRange.endDate);
    setPresetKey(key);
    setRange(nextRange);
    setGranularityOverride(null);
    reloadAll(filterValues, nextRange, nextGranularity);
  };

  const handleCustomRangeChange = (nextRange: UsageDateRange) => {
    setPresetKey('custom');
    setRange(nextRange);
    const nextGranularity = granularityOverride ?? getGranularityForRange(nextRange.startDate, nextRange.endDate);
    reloadAll(filterValues, nextRange, nextGranularity);
  };

  const handleGranularityChange = (g: 'day' | 'hour') => {
    setGranularityOverride(g);
    reloadAll(filterValues, range, g);
  };

  const handleFiltersChange = (next: UsageFilterValues) => {
    setFilterValues(next);
    reloadAll(next, range, granularity);
  };

  const handleRefresh = () => reloadAll(filterValues, range, granularity);

  const handleReset = () => {
    const key: UsageDateRangePresetKey = 'last24Hours';
    const nextRange = computeDateRange(key);
    setPresetKey(key);
    setRange(nextRange);
    setGranularityOverride(null);
    setFilterValues(EMPTY_FILTERS);
    reloadAll(EMPTY_FILTERS, nextRange, getGranularityForRange(nextRange.startDate, nextRange.endDate));
  };

  const handlePageChange = (nextPage: number) => {
    setPage(nextPage);
    void fetchList(buildQueryFilters(filterValues, range), nextPage, pageSize, sortBy, sortOrder);
  };

  const handlePageSizeChange = (nextPageSize: number) => {
    setPageSize(nextPageSize);
    setPage(1);
    persistPageSize(nextPageSize);
    void fetchList(buildQueryFilters(filterValues, range), 1, nextPageSize, sortBy, sortOrder);
  };

  const handleSortChange = (nextSortBy: string, nextSortOrder: 'asc' | 'desc') => {
    setSortBy(nextSortBy);
    setSortOrder(nextSortOrder);
    void fetchList(buildQueryFilters(filterValues, range), page, pageSize, nextSortBy, nextSortOrder);
  };

  const handleToggleColumn = (key: string, visible: boolean) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (visible) next.add(key);
      else next.delete(key);
      saveVisibleColumns(next);
      return next;
    });
  };

  const handleExportCsv = async () => {
    setExporting(true);
    const result = await exportUsageCsv(buildQueryFilters(filterValues, range));
    setExporting(false);
    if (!result.ok) setError(result.error);
  };

  return (
    <section className="flex flex-col gap-5">
      {/* 1px 哨兵——不占版面（h-0 即可，配 aria-hidden 排除出无障碍树），
          唯一作用是给下面的 IntersectionObserver 一个「header 是否已滚出
          初始位置」的探测点。必须紧贴在 sticky header 前面，不能挪到别处。 */}
      <div ref={sentinelRef} aria-hidden="true" className="h-0" />

      {/* 只有标题贴顶——时间范围/粒度控件跟着内容正常滚走（用户明确要求，
          2026-07-22）。之前把控件也塞进这个 sticky header 是过度设计：控件
          不需要「随时可见」，标题才是原始诉求。 */}
      <header
        className={cn(
          'sticky top-0 z-10 flex min-w-0 items-baseline gap-3 bg-card transition-[padding,border-color] duration-200 ease-out',
          // 上下内边距必须同步变——之前只覆盖 pb-3 漏了 pt，贴顶态变成上 4px
          // 下 12px 的不对称间距。
          scrolled ? 'border-b border-border py-3' : 'border-b border-transparent py-1',
        )}
      >
        <h1
          className={cn(
            'shrink-0 font-semibold tracking-[-0.015em] text-foreground transition-[font-size] duration-200 ease-out',
            scrolled ? 'text-[15.5px]' : 'text-[26px]',
          )}
        >
          使用记录
        </h1>
        {/* 贴顶后用一句 mono 摘要顶替被压缩掉的大标题留白，呼应统计卡片里
            的数字——纯装饰性信息，stats 未就绪（首帧/切换范围中）就不显示，
            避免闪一下「0 次 · $0.0000」。 */}
        {scrolled && stats ? (
          <span className="truncate font-mono text-[11.5px] text-muted-foreground">
            {formatCount(stats.totalRequests)} 次 · {formatCost(stats.totalActualCost)}
          </span>
        ) : null}
      </header>

      <UsageDateRangeControls
        presetKey={presetKey}
        range={range}
        granularity={granularity}
        onChangePreset={handlePresetChange}
        onChangeCustomRange={handleCustomRangeChange}
        onChangeGranularity={handleGranularityChange}
      />

      {error ? (
        <div className="flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="opacity-70 hover:opacity-100">
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      <UsageStatsCards stats={stats} loading={dashboardLoading} />

      {/* 单列堆叠：设置内容面固定 max-w-[760px]，装不下 overlay 版的 2 列
          图表网格（见文件头注释）。 */}
      <div className="flex flex-col gap-3">
        <ModelDistributionChart models={models} loading={dashboardLoading} />
        <GroupDistributionChart groups={groups} loading={dashboardLoading} />
        <EndpointDistributionChart endpoints={stats?.endpoints ?? []} loading={dashboardLoading} />
        <TokenUsageTrendChart trend={trend} loading={dashboardLoading} />
      </div>

      <UsageFilters
        apiKeyOptions={apiKeyOptions}
        modelOptions={modelOptions}
        groupOptions={groupOptions}
        values={filterValues}
        onChange={handleFiltersChange}
        visibleColumns={visibleColumns}
        onToggleColumn={handleToggleColumn}
        onRefresh={handleRefresh}
        onReset={handleReset}
        onExportCsv={() => void handleExportCsv()}
        exporting={exporting}
      />

      <UsageTable
        items={list.items}
        total={list.total}
        page={list.page}
        pageSize={list.pageSize}
        loading={listLoading}
        visibleColumns={visibleColumns}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onSortChange={handleSortChange}
        onPageChange={handlePageChange}
        onPageSizeChange={handlePageSizeChange}
      />
    </section>
  );
}
