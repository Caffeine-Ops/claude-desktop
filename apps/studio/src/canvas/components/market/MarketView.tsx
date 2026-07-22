import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/src/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/src/components/ui/alert-dialog';
import { useMarket } from './useMarket';
import { PluginsTab } from './PluginsTab';
import { SkillsTab } from './SkillsTab';
import { SkillModal } from './SkillModal';
import { contentEaseOut, toastSpring } from './motion';

// 插件市场主页。UI 规格 = docs/ui-prototype-plugins.html：插件/技能双 tab、
// 吸顶搜索 + 渐进模糊、已安装区、分类分区、安装三态。数据全走 daemon
// /api/skills-market/*。本目录在 chat 链 scoped @source 名单里
// （src/chat/styles/index.css）——新 markup 一律 shadcn 原语 + Tailwind
// utility，禁 legacy 类。
//
// **宿主中立（2026-07-17）**：进详情页靠 onOpenDetail 注入，本组件不碰
// canvas router。当前唯一宿主是 MarketSurface（SurfaceHost 的第三个面，
// ?market=1 → rail 常驻 + 右侧内容区换成市场），回调 = 宿主本地 state 切
// 两级视图。
//
// 为什么中立而不是直接 import navigate：早期版本这么干过，导致聊天面点
// 「插件」被拽走 pathname、SurfaceHost 随之翻到画布面（用户实锤的「点插件
// 跳工作画布」）。宿主中立后换壳零成本——中途还试过 radix 弹窗宿主，
// 换成第三个面时本组件一行没改。
//
// 本树整体是 **portal-safe** 的（万一将来又被塞进 portal 出去的宿主、脱离
// .chat-app 的 canvas reset 豁免）：全 shadcn 原语自带 data-slot，唯一的
// 裸 <button>（MarketDetailPage 的 prompt pill）显式挂了 data-slot，
// EntryRow 用 div 而非 button。新增裸交互元素务必照此办理。

export function MarketView({ onOpenDetail }: { onOpenDetail: (id: string) => void }) {
  const reduce = useReducedMotion();
  const market = useMarket();
  const [tab, setTab] = useState<'plugins' | 'skills'>('plugins');
  const [query, setQuery] = useState('');
  const [openSkillId, setOpenSkillId] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<string | null>(null);

  const openSkillEntry = market.registry?.entries.find((e) => e.id === openSkillId) ?? null;

  return (
    <div className="relative h-full">
      {/* 顶栏（46px，原型 .topbar 的位置/内边距）——**浮在滚动区之上**而不是
        * 做它的 flex 兄弟：内容要能滚到它下面被磨砂糊住（对齐 Codex 实拍的
        * 观感，2026-07-17 用户指定）。做成兄弟的话内容永远滚不进这 46px，
        * backdrop-filter 没有任何东西可糊，等于白挂。
        *
        * **拖拽**：这条落在根 layout 的 .window-drag-strip 带内。整条挖
        * no-drag 会把 strip 的拖拽压死（顶部空白拖不动窗口，用户实锤）——
        * 按 CLAUDE.md 的铁律，**只有交互元素挖洞**，容器自身不声明
        * app-region（不声明=不注册矩形=strip 的 drag 照常生效），组件顶栏
        * 也绝不自带 drag（唯一写手永远是 strip）。 */}
      <div className="absolute inset-x-0 top-0 z-30 flex h-[46px] items-center gap-2 bg-card/70 px-3.5 backdrop-blur-xl">
        <div className="[-webkit-app-region:no-drag]">
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'plugins' | 'skills')}>
            <TabsList>
              <TabsTrigger value="plugins">插件</TabsTrigger>
              <TabsTrigger value="skills">技能</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="ml-auto [-webkit-app-region:no-drag]">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground"
            title="刷新市场清单"
            onClick={() => void market.refreshRegistry({ refresh: true })}
          >
            <RefreshCw className={`size-3.5 ${market.loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* 滚动区（原型 .scroll）+ 内容列（原型 .page-col：max-width 880、
        * padding 40 横 / 80 底）。顶部内边距 = 46（浮起顶栏）+ 28（原型
        * page-col 的 padding-top），这样首屏内容不被顶栏压住，滚起来才钻到
        * 它下面。 */}
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-[880px] px-10 pb-20 pt-[74px]">
        <div>
          {/* 原型 .hero h1：30px / 650 / -0.02em。650 不是 Tailwind 档位，
            * 用任意值——原型的 --fw-strong 全站统一 650，别退回 600。 */}
          <h1 className="text-[30px] font-[650] tracking-[-0.02em]">
            {tab === 'plugins' ? '插件' : '技能'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {tab === 'plugins' ? '在你常用的工具中与 AI 协作' : '通过任务专用技能扩展 AI 的能力'}
          </p>
        </div>

        {/* 吸顶搜索 + 渐进模糊纱（原型 .search-sticky / .search-veil：
          * margin-top 24、padding 10 0、veil 左右各 -40（顶满 page-col 的
          * 40px 内边距）、高 52）。
          *
          * 底色是与原型的**唯一有意偏差**：原型独立页的底是 --background
          * （浅灰 #f5f5f7），而市场面住在共享的白色 shell-content-card 上，
          * 照搬会在白底上显出一条浅灰色带（vault 2026-07-14 底色一致性教训）。
          * 故 --background → --card，其余（渐变止点/模糊半径/mask 衰减）逐字
          * 照原型。
          *
          * 材质改毛玻璃（2026-07-19 用户实锤壁纸开启时这条纯色 bg-card 是一块
          * 生硬的实心矩形——外层 workspace-split-panel 与顶栏都已经是半透明+
          * 模糊，就这条吸顶栏满宽实底，跟上下文断层）：改成跟正上方顶栏同款
          * 配方（bg-card/70 + backdrop-blur-xl，见本文件顶栏 className），
          * 吸顶栏与顶栏视觉上连成一整块磨砂玻璃，滚动内容钻进去时的模糊/半透
          * 观感也统一。壁纸关闭时 bg-card/70 叠在不透明的 --card 面上，
          * 70% 不透明度视觉上跟原来的纯色几乎无差——不引入回归。 */}
        {/* top-[46px] 而非 0：顶栏是浮起的（absolute z-30），搜索吸到 0 会被它
          * 盖住。吸在它正下方，hero 向上滚时先钻进顶栏那 46px 被磨砂糊掉、
          * 再被搜索栏挡住——两段过渡衔接，正是 Codex 那个观感。 */}
        <div className="sticky top-[46px] z-20 -mx-10 mt-6 px-10 py-2.5 ">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-[15px] -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tab === 'plugins' ? '搜索插件' : '搜索技能'}
              // 原型 .search-input：h40 / radius 11 / 13.5px。**md:text-[13.5px]
              // 不能省**——shadcn Input 基件自带 `text-base md:text-sm`，媒体
              // 查询里的 md:text-sm 特异性压过裸 text-[13.5px]，只写后者在
              // ≥768px 时会被静默改回 14px（实测）。
              // focus 边框/光晕钉品牌绿：Input 基件默认 focus-visible 用 --ring
              // （跟用户主题色走），本表面身份色一律品牌绿不跟主题（2026-07-20
              // 用户实锤，同 CanvasQuestionnaire）。cn/tailwind-merge 里 className
              // 后置，focus-visible:border/ring-brand 覆盖基件的 -ring。注：market
              // 目录经 chat 链 scoped @source 扫描，brand utility 在此可用。
              className="h-10 rounded-[11px] pl-10 text-[13.5px] md:text-[13.5px] focus-visible:border-brand focus-visible:ring-brand/15 backdrop-blur-xl"
            />
          </div>
          {/* <div
            className="pointer-events-none absolute inset-x-0 top-full h-[52px]"
            style={{
              background: 'linear-gradient(to bottom, hsl(var(--card)) 8%, transparent)',
              backdropFilter: 'blur(5px)',
              WebkitBackdropFilter: 'blur(5px)',
              maskImage: 'linear-gradient(to bottom, black 25%, transparent)',
              WebkitMaskImage: 'linear-gradient(to bottom, black 25%, transparent)',
            }}
          /> */}
        </div>

        {market.loading && !market.registry ? (
          <div className="flex items-center gap-2 pt-14 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 正在拉取市场清单…
          </div>
        ) : market.registryError && !market.registry ? (
          <div className="mt-12 rounded-2xl border border-dashed border-border p-12 text-center">
            <p className="text-sm font-medium">市场清单拉取失败</p>
            <p className="mt-1.5 text-xs text-muted-foreground">{market.registryError}</p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-5 rounded-full"
              onClick={() => void market.refreshRegistry({ refresh: true })}
            >
              重试
            </Button>
          </div>
        ) : market.registry ? (
          // 换 tab 时整块淡入（key 一变就重放）。mode="wait" 会让旧内容先淡出
          // 再淡入新的，切换手感变拖沓——这里两块内容高度相近，直接叠着换更利落。
          <motion.div
            key={tab}
            initial={reduce ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={contentEaseOut}
          >
            {tab === 'plugins' ? (
              <PluginsTab
                registry={market.registry}
                installed={market.installed}
                bundledIds={market.bundledIds}
                installingIds={market.installingIds}
                query={query}
                onInstall={(id) => void market.install(id)}
                onRequestUninstall={setPendingUninstall}
                onOpenDetail={onOpenDetail}
              />
            ) : (
              <SkillsTab
                registry={market.registry}
                installed={market.installed}
                bundledIds={market.bundledIds}
                installingIds={market.installingIds}
                query={query}
                onInstall={(id) => void market.install(id)}
                onRequestUninstall={setPendingUninstall}
                onOpenSkill={setOpenSkillId}
              />
            )}
          </motion.div>
        ) : null}
        </div>
      </div>

      {/* toast：从下方浮起。此前是裸条件渲染——出现和消失都是瞬变，安装成功
        * 的反馈「啪」地闪一下就没了，正是最该有过渡的一处。
        * 水平居中交给外层 flex，**不能**用 -translate-x-1/2：那会和 motion 的
        * y/scale 抢同一个 transform 属性，动画一跑 toast 就飞到右边去。 */}
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
        <AnimatePresence>
          {market.notice ? (
            <motion.div
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
              transition={toastSpring}
              className="rounded-full bg-foreground px-4 py-2 text-xs text-background shadow-lg"
            >
              {market.notice}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <SkillModal
        entry={openSkillEntry}
        installed={openSkillEntry ? market.installed.some((i) => i.name === openSkillEntry.id) : false}
        installing={openSkillEntry ? market.installingIds.has(openSkillEntry.id) : false}
        builtin={openSkillEntry ? market.bundledIds.has(openSkillEntry.id) : false}
        onInstall={(id) => void market.install(id)}
        onRequestUninstall={(name) => {
          setOpenSkillId(null);
          setPendingUninstall(name);
        }}
        onClose={() => setOpenSkillId(null)}
      />

      <AlertDialog open={pendingUninstall !== null} onOpenChange={(o) => !o && setPendingUninstall(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移除「{pendingUninstall}」？</AlertDialogTitle>
            <AlertDialogDescription>
              移除后新会话不再加载它；进行中的会话不受影响。之后可以随时重新安装。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingUninstall) void market.uninstall(pendingUninstall);
                setPendingUninstall(null);
              }}
            >
              移除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
