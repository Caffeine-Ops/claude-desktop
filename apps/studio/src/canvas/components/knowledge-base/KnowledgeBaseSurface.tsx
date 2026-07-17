/*
 * KnowledgeBaseSurface —— 知识库面的内容容器：SurfaceHost 里与 chat/canvas
 * 平级的第四个面（`?kb=1`，机制见 src/stores/surfaceOverlay.ts）。rail 常驻在
 * 左侧，本组件只占右侧内容区。**骨架与市场面（MarketView）逐条对齐**——两个
 * 面并排住在同一条 rail 右边，顶栏形态/标题起跳位置不一致会在切换时跳一下。
 *
 * ## 从「全屏 overlay」到「面」（2026-07-17 用户要求「跟插件页面交互一样，
 * 不要切换页面」）
 *
 * 前身是 KnowledgeBaseDialog：canvas App 内部 `fixed inset-0 z-50` 的全屏
 * overlay（照搬设置页 V2 骨架），逃出 shell-stage 连 rail 一起盖住，所以它
 * **必须**自画一条 w-61 左导航（宽度对齐 rail，否则切换时内容卡左缘跳动）+
 * 一颗「返回应用」（盖住 rail 后那是唯一出口）。抬成面之后这两样都没有存在
 * 理由了：
 *   - 左导航 → **顶栏 tabs**（同市场面的「插件/技能」）。不留二级左导航是
 *     用户定的：rail 已经占了 244px，再并一条窄栏，窗口小时内容区被挤得没法
 *     看文件网格。
 *   - 「返回应用」→ **删**。退出路径就是 rail 本身（点会话/切面/再点知识库），
 *     面内再放一个出口既多余又会让人以为知识库是「另一个应用」。连带把
 *     canvas App 那边的 overlayBackFiredRef 防重入、window.history.back()
 *     兜底一起消灭——那整套是「盖住 rail 的 UI 得自己管怎么回去」的产物。
 *
 * ## 分区状态不进 URL
 *
 * 四个分区由本地 state 承担，同 MarketSurface 的两级视图取舍：kb=1 是个
 * 「开关」而非路由树，分区深链没有需求。也因此本面**不常驻**（SurfaceHost
 * 条件渲染，关掉即卸载）：每次打开都回到「全部文件」，且文件是刚扫的。
 *
 * ## 样式纪律（同各面板头注释，canvas 链 CSS unlayered）
 *
 * 本文件所有元素**不复用任何 .sv2-* / .settings-* legacy 类**，布局全靠
 * utility + shadcn 原语（自带 data-slot，天然豁免 canvas 裸元素 reset）。
 * 本目录在 chat 链的 scoped @source 名单里（src/chat/styles/index.css）。
 */

import { useState } from 'react';

import { Tabs, TabsList, TabsTrigger } from '@/src/components/ui/tabs';
import { useI18n } from '../../i18n';
import { AllFilesPanel } from './AllFilesPanel';
import { DocCatalogPanel } from './DocCatalogPanel';
import { CategoryManagePanel } from './CategoryManagePanel';

/** 顶栏 tab = 一个分区。 */
type KbSection = 'all-files' | 'doc-catalog' | 'image-catalog' | 'categories';

type NavItem = {
  id: KbSection;
  labelKey: string;
  fallback: string;
};

/* i18n 走 tt 带字面量兜底——缺 key 时显示中文而非裸 key（同 SettingsDialogV2
   的 tt 约定）。图标随左导航一起退役：顶栏 tab 段里塞图标会把四段撑得过宽，
   市场面的「插件/技能」也是纯文字。 */
const NAV_ITEMS: NavItem[] = [
  { id: 'all-files', labelKey: 'knowledgeBase.allFiles', fallback: '全部文件' },
  { id: 'doc-catalog', labelKey: 'knowledgeBase.docCatalog', fallback: '文档识别' },
  { id: 'image-catalog', labelKey: 'knowledgeBase.imageCatalog', fallback: '图片识别' },
  { id: 'categories', labelKey: 'knowledgeBase.categories', fallback: '分类管理' },
];

export function KnowledgeBaseSurface(): React.JSX.Element {
  const { t } = useI18n();
  // tt: translate with a literal fallback so a not-yet-added i18n key shows
  // the Chinese label instead of the raw key（同 SettingsDialogV2）。
  const tt = (key: string, fallback: string): string => {
    const v = t(key as Parameters<typeof t>[0]);
    return v === key ? fallback : v;
  };

  const [activeSection, setActiveSection] = useState<KbSection>('all-files');
  const activeMeta = NAV_ITEMS.find((i) => i.id === activeSection) ?? NAV_ITEMS[0];
  const activeLabel = tt(activeMeta.labelKey, activeMeta.fallback);

  return (
    // 不铺自己的底：本面住在共享的 .shell-content-card 上，那层已经是
    // `hsl(var(--card))`（globals.css）。同色再铺一层是 2026-07-14
    //「canvas 内容区铺灰底盖住共享白色 shell-content-card」那条教训的形状
    // ——今天同色看不出问题，改天 card 换了色就分叉。市场面同样不铺。
    <div className="relative h-full">
      {/* 顶栏（46px）——**浮在滚动区之上**而不是做它的 flex 兄弟，逐条对齐
        * MarketView（2026-07-17 用户定的观感）：内容要能滚到它下面被磨砂糊住；
        * 做成兄弟的话内容永远滚不进这 46px，backdrop-filter 没东西可糊。
        *
        * **拖拽**：这条落在根 layout 的 .window-drag-strip 带内。整条挖
        * no-drag 会把 strip 的拖拽压死（顶部空白拖不动窗口，用户实锤）——
        * 按 CLAUDE.md 的铁律，**只有交互元素挖洞**（下面包 Tabs 的那层），
        * 容器自身不声明 app-region（不声明=不注册矩形=strip 的 drag 照常
        * 生效），组件顶栏也绝不自带 drag（唯一写手永远是 strip）。 */}
      <div className="absolute inset-x-0 top-0 z-30 flex h-[46px] items-center gap-2 bg-card/70 px-3.5 backdrop-blur-xl">
        <div className="[-webkit-app-region:no-drag]">
          <Tabs value={activeSection} onValueChange={(v) => setActiveSection(v as KbSection)}>
            <TabsList>
              {NAV_ITEMS.map((item) => (
                <TabsTrigger key={item.id} value={item.id}>
                  {tt(item.labelKey, item.fallback)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* 滚动区 + 内容列。pt-[74px] = 46（浮起顶栏）+ 28，与 MarketView 同值：
        * 首屏内容不被顶栏压住，滚起来才钻到它下面。
        * max-w-[1160px] 沿用改造前的值、不跟市场的 880：那边是单列卡片，这边
        * 是文件网格，880 会把每行压得太窄。
        * 各面板自带标题行（标题右侧挂各自的工具组/主按钮）；文档/图片识别
        * 共用 DocCatalogPanel，domain prop 选域。 */}
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-[1160px] px-10 pb-20 pt-[74px]">
          {activeSection === 'all-files' ? (
            <AllFilesPanel title={activeLabel} />
          ) : activeSection === 'doc-catalog' ? (
            <DocCatalogPanel title={activeLabel} domain="docs" />
          ) : activeSection === 'image-catalog' ? (
            <DocCatalogPanel title={activeLabel} domain="images" />
          ) : (
            <CategoryManagePanel title={activeLabel} />
          )}
        </div>
      </div>
    </div>
  );
}
