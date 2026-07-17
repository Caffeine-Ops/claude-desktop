import { useState } from 'react';
import { MarketDetailPage } from './MarketDetailPage';
import { MarketView } from './MarketView';

// 插件市场面的内容容器 —— SurfaceHost 里与 chat/canvas 平级的第三个面
// （`?market=1`，见 src/stores/surfaceOverlay.ts 的机制说明）。rail 常驻在
// 左侧，本组件只占右侧内容区。
//
// 两级视图（列表 ↔ 详情）由本地 state 承担、**不进 URL**：market=1 是个
// 「开关」而非路由树，详情深链没有需求（市场是浏览面，装完就走）。这也是
// 市场组件树宿主中立的意义——MarketView/MarketDetailPage 只认 props 回调，
// 换宿主不用改它们。
//
// 本面**不常驻**（SurfaceHost 里条件渲染，关掉即卸载）：与 chat/canvas 两棵
// 重型树不同，市场是轻量临时目的地，卸载重挂的成本远低于常驻的内存/recalc
// 开销；顺带保证每次打开都回到干净的列表页、且已安装状态是刚拉的（装完插件
// 关掉再开能看到最新态，不用手动刷新）。

export function MarketSurface() {
  const [detailId, setDetailId] = useState<string | null>(null);

  return detailId ? (
    <MarketDetailPage entryId={detailId} onBack={() => setDetailId(null)} />
  ) : (
    <MarketView onOpenDetail={setDetailId} />
  );
}
