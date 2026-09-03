/*
 * SettingsDialogV2 — the redesigned skin for the Settings page.
 * -----------------------------------------------------------
 * WHY THIS EXISTS
 *   The original SettingsDialog.tsx is a ~2.9k-line component that owns the
 *   navigation + all ~18 panels + autosave + per-section state. Rather than
 *   fork all of that, V2 is a thin SHELL hosting the EXACT same section logic
 *   by rendering SettingsDialog in its `embedded` mode. In embedded mode
 *   SettingsDialog drops its own chrome (backdrop, frame, back button, header,
 *   sidebar, footer) and renders only the section content pane, driven by a
 *   CONTROLLED `activeSection` that V2's sidebar owns. Result: one
 *   implementation of every panel + autosave, zero drift between V1 and V2.
 *
 *   App.tsx picks V1 vs V2 behind `settingsV2Enabled()`, so the classic dialog
 *   is one flag away during rollout.
 *
 * TECH-STACK MIGRATION (2026-07-04 起，进行中)
 *   本壳已从手写 .sv2-* CSS 迁到 chat 面技术栈：shadcn Button + lucide-react
 *   + Tailwind utility（settings 目录已加进 chat 链的 @source 扫描）。但根节点
 *   保留 `sv2` 类作为**过渡期兼容层**：settings-v2.css 里 `.sv2 .settings-*`
 *   系列选择器还在给未迁移的 embedded 面板（SettingsDialog 内的各 section）
 *   补 V2 皮肤。等全部 section 换完 shadcn，settings-v2.css / settings-modal.css
 *   一起退役，这个类和这段注释一并删除。
 *
 *   期间注意：canvas 链的 CSS 未分层（unlayered），同名属性会压过 Tailwind
 *   @layer utilities——所以本文件新增的元素**不得复用任何 .sv2-* / .settings-*
 *   类名**，布局全靠 utility + shadcn 原语（自带 data-slot，天然豁免 canvas
 *   裸元素 reset）。
 *
 *   迁移进度（✓=已迁 shadcn；其余仍靠 .sv2 reskin 撑着，按用户可见频率排序）：
 *   ✓ V2 壳（本文件）        ✓ execution（SettingsDialog.tsx 内联，含 BYOK）
 *   ✓ AppearanceSection      ✓ MediaProvidersSection（2026-07-14：27 个裸 input
 *                              → shadcn Input 透明底 + 柔光 ring，眼睛/清除按钮
 *                              → shadcn Button，退役 .media-provider-secret-field /
 *                              .secret-visibility-button）
 *   ✓ NotificationsSection   ✓ CritiqueTheaterSection ✓ IntegrationsSection
 *   ✓ McpClientSection       ✓ PrivacySection         ✓ LogAnalysisSection
 *   ✓ ConnectorSection       ✓ OrbitSection           ✓ MemoryModelInline
 *   ✓ MemorySection（以上 10 个 2026-07-14 并行 workflow 迁完 markup：裸
 *     input/select/button → shadcn Input/Radix Select/Button + Switch，utility
 *     重建布局，typecheck 全绿、目视无回归。memory/ 目录已加 @source。）
 *   ✓ SkillsSection / DesignSystemsSection 的筛选下拉（2026-07-14：二者共享的
 *     4 个原生 .library-filter-select select 整组迁 Radix Select（不造新割裂）+
 *     搜索框 → shadcn Input；已退役 quick-switcher.css 的 library-filter-select
 *     与 library-toolbar-row 全段 73 行死代码 CSS——这是本轮唯一「共享类全消费者
 *     迁完、CSS 真能退役」的例子）。两 section 的其余 button 未迁，仍待收尾。
 *   ☐ language / about（SettingsDialog.tsx 内联，小）
 *   ☐ instructions / pet
 *   ⚠️ 退役 legacy CSS 的纪律（2026-07-14 实测）：上面 10 个 section 腾出的
 *     legacy 类（field/hint/ghost/primary/settings-section/seg-btn 等）**几乎全是
 *     跨 section/跨视图共享类，实测仍有大量其它消费者（hint 67、ghost 70、
 *     primary 31 处…）**，现在删 CSS 会破坏未迁组件。退役判据是「该类全 canvas
 *     零消费者」，共享类要等最后一个消费者也迁完才能删——markup 迁完 ≠ CSS 能退。
 *   全部打勾后：删 .sv2 兼容类、settings-v2.css、settings-modal.css 及
 *   settings-orbit.css 里 agent- 与 field- 两族选择器段；var(--green) 等状态
 *   色在 design-tokens 转正（见 SettingsDialog.tsx 顶部 TEST_STATUS_TONES
 *   注释）。（这里不能写「星号斜杠」连排——会提前闭合本块注释，07-04 CSS
 *   注释同款事故。）
 */

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BarChart3,
  Bell,
  Blocks,
  CircleUserRound,
  Eye,
  FileText,
  Flag,
  Folder,
  History,
  Image,
  Info,
  LayoutGrid,
  Library,
  Link,
  MessageSquare,
  Package,
  Palette,
  PawPrint,
  Pencil,
  Plug,
  Search,
  SlidersHorizontal,
  SunMoon,
  X,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { cn } from '@/src/lib/utils';
import { SettingsDialog, useTt } from '../SettingsDialog';
import type { SettingsDialogProps, SettingsSection } from '../SettingsDialog';

/* V2 takes the SAME props as SettingsDialog (it forwards them straight into
   the embedded instance), so App.tsx hands V1 and V2 identical objects. */
type SettingsDialogV2Props = SettingsDialogProps;

/* ── Sidebar model. Grouped to match the prototype's three buckets.
   `icon` 直接引用 lucide-react 组件（chat 栈 idiom，同 AppRail），不再走
   canvas 的 <Icon name> 间接层；labels go through i18n with a literal
   fallback so a missing key never blanks a row. ── */
type NavItem = {
  id: SettingsSection;
  labelKey: string;
  fallback: string;
  icon: LucideIcon;
  /* 搜索词表：让**面板内部**的控件名（「主题色」「密钥」「提示音」）也能
     命中这一项。导航标题只有 2~4 个字，而用户搜的往往是他记得的那个控件
     叫什么、而不是它被归在哪一区——只匹配标题的搜索基本等于没有。
     空格分隔，匹配时统一小写化后做子串包含；中英文都放，英文界面下用户
     多半仍按英文控件名搜。 */
  keywords: string;
};
type NavGroup = { titleKey: string; fallback: string; items: NavItem[] };

/* ── 信息架构（2026-09-02 重设计）──────────────────────────────────
   改前是 4 组 24 项，其中「通用」9 项、「高级设置」6 项是两个杂物抽屉：
   前者混着身份(account)、数据(usage)、AI 行为(execution/instructions/
   memory)、外观(language/appearance)、系统(notifications/appUpdate)五类
   毫不相干的东西，后者混着功能与系统信息。判据很简单——**一个分组好不好，
   看你能不能用一句话说清它是什么**；「通用」和「高级」都说不清，所以它们
   是抽屉而不是分组。

   改后 6 组，每组的一句话定义写在下面每个 titleKey 上方，顺序按「先我是谁
   → 再 AI 怎么干活 → 再我的东西 → 再接外部 → 最后应用自身」。组数变多反而
   更好找：分组的价值来自「能一眼排除掉 5 个组」，而不是来自组少。

   本次**刻意不动任何 SettingsSection token**（不删不合并），因为该类型是
   穷举联合，被 App.tsx 的 openSettings 直达入口、stores/surfaceOverlay.ts
   的跨面直达子集、以及 SettingsDialog.tsx 的 Record<SettingsSection, …>
   同时消费——合并 section 是独立一步的改动（见文件头「后续」）。这里只重排
   分组与顺序，改动范围严格锁在本文件内。为那一步做的铺垫是：三对候选合并
   项已排成相邻位置（mcpClient↔composio、appearance↔language、
   appUpdate↔about），合并时不需要再动位置。

   图标去重：改前 execution 与 integrations 同为 SlidersHorizontal、
   composio 与 pet 同为 Sparkles、memory 与 logAnalysis 同为 History——
   三对撞车在旧分组下被距离掩盖了，重排后它们相邻或同组，一眼就能看出
   「两行长得一样」。图标在导航里承担的是「不读字先定位」，撞车等于这个
   功能失效，故一并修正。 ── */
const NAV_GROUPS: NavGroup[] = [
  {
    // 我是谁、我花了多少
    titleKey: 'settingsV2.groupAccount',
    fallback: '账户',
    items: [
      {
        id: 'account',
        labelKey: 'settingsV2.account',
        fallback: '账号',
        icon: CircleUserRound,
        keywords: '登录 退出 注销 订阅 套餐 邮箱 会员 头像 余额 login logout profile',
      },
      {
        id: 'usage',
        labelKey: 'settingsV2.usage',
        fallback: '使用记录',
        icon: BarChart3,
        keywords: '用量 花费 配额 统计 明细 账单 token usage billing quota',
      },
    ],
  },
  {
    // AI 干活时听谁的 —— 本产品最核心的一组设置，改前埋在「通用」第 3~5 位
    titleKey: 'settingsV2.groupBehavior',
    fallback: 'AI 行为',
    items: [
      {
        id: 'execution',
        labelKey: 'settings.execution',
        fallback: '执行模式',
        icon: SlidersHorizontal,
        keywords: '执行 模式 cli api 密钥 模型 后端 权限 byok fusion claude key model base url',
      },
      {
        id: 'instructions',
        labelKey: 'settings.instructions',
        fallback: '全局规则',
        icon: Pencil,
        keywords: '规则 指令 提示词 全局 system prompt instructions claude.md',
      },
      {
        id: 'memory',
        labelKey: 'settings.memory',
        fallback: '记忆',
        icon: History,
        keywords: '记忆 长期 记住 遗忘 memory',
      },
      {
        id: 'critiqueTheater',
        labelKey: 'settings.critiqueTheater',
        fallback: '设计评审团',
        icon: MessageSquare,
        keywords: '评审 评论 角色 剧场 critique review',
      },
    ],
  },
  {
    // 我攒下来的东西 —— skills/designSystems 从「扩展」「高级」搬进来：
    // 它们是用户自己的资产，不是从外部接进来的能力
    titleKey: 'settingsV2.groupWorkspace',
    fallback: '工作区',
    items: [
      {
        id: 'projects',
        labelKey: 'settingsV2.workspaceProjects',
        fallback: '项目',
        icon: Folder,
        keywords: '项目 目录 工作区 文件夹 project workspace',
      },
      {
        id: 'automations',
        labelKey: 'settingsV2.workspaceAutomations',
        fallback: '自动化',
        icon: Flag,
        keywords: '自动化 定时 触发 任务 cron routine automation',
      },
      {
        id: 'knowledgeBase',
        labelKey: 'settingsV2.workspaceKnowledgeBase',
        fallback: '知识库',
        icon: Library,
        keywords: '知识库 检索 资料 文档 向量 嵌入 rag embedding knowledge',
      },
      {
        id: 'skills',
        labelKey: 'settings.skills',
        fallback: '技能',
        icon: LayoutGrid,
        keywords: '技能 写作 审标 文档 ppt 工作流 skill',
      },
      {
        id: 'designSystems',
        labelKey: 'settings.designSystems',
        fallback: '设计系统',
        icon: Palette,
        keywords: '设计系统 品牌 配色 组件库 规范 token design system',
      },
    ],
  },
  {
    // 接进来的外部能力 —— mcpClient 与 composio 相邻，是下一步合并的候选
    titleKey: 'settingsV2.groupConnect',
    fallback: '连接',
    items: [
      /* ── 这三项的标签在 2026-09-02 前**整体错位了一圈**（既有 bug）──
         导航写「MCP 服务器」的其实是 mcpClient=外部 MCP，写「外部 MCP」的
         其实是 composio=连接器，写「连接器」的其实是 integrations=MCP 服务器。
         页面标题（SettingsDialog 的 sectionHeader）一直是**对的**，只有导航
         贴错，于是「点进去标题和刚才点的名字不一样」。这正是「三个概念分不清」
         的真病根——不是概念重叠，是名字贴错。
         顺带把 labelKey 换成字典里**真实存在**的 key：原来的
         settings.mcpClient / settings.composio / settings.integrations 三个
         key 一个都没进字典，19 种语言全靠中文 fallback 顶着；换成下面这三个
         已有 key 后，多语言一并补上。 */
      {
        id: 'mcpClient',
        labelKey: 'settings.externalMcpTitle',
        fallback: '外部 MCP',
        icon: Link,
        keywords: '外部 mcp 接入 工具 外挂 装 github higgsfield client 第三方工具',
      },
      {
        id: 'composio',
        labelKey: 'connectors.title',
        fallback: '连接器',
        icon: Package,
        keywords: '连接器 授权 集成 notion 飞书 oauth composio connector 第三方账号',
      },
      {
        id: 'integrations',
        labelKey: 'settings.mcpServerTitle',
        fallback: 'MCP 服务器',
        icon: Plug,
        keywords: 'mcp 服务器 暴露 对外 提供 cursor claude code antigravity 编码代理 server',
      },
      {
        id: 'plugins',
        labelKey: 'settingsV2.workspacePlugins',
        fallback: '插件',
        icon: Blocks,
        keywords: '插件 扩展 plugin extension',
      },
      {
        id: 'media',
        labelKey: 'settings.media',
        fallback: '媒体生成提供商',
        icon: Image,
        keywords: '媒体 出图 图片 视频 绘图 生成 提供商 image video provider',
      },
    ],
  },
  {
    // 应用长什么样、怎么提醒我 —— appearance 与 language 相邻，合并候选
    titleKey: 'settingsV2.groupApp',
    fallback: '应用',
    items: [
      {
        id: 'appearance',
        labelKey: 'settingsV2.appearanceAndLanguage',
        fallback: '外观与语言',
        icon: SunMoon,
        keywords:
          '外观 主题 深色 浅色 暗色 字号 背景 主题色 配色 语言 中文 英文 界面语言 theme dark light font language locale',
      },
      {
        id: 'pet',
        labelKey: 'settings.pet',
        fallback: '宠物',
        icon: PawPrint,
        keywords: '宠物 桌宠 伙伴 pet',
      },
      {
        id: 'notifications',
        labelKey: 'settings.notifications',
        fallback: '通知',
        icon: Bell,
        keywords: '通知 提示音 声音 桌面 铃声 notification sound',
      },
      {
        id: 'privacy',
        labelKey: 'settings.privacy',
        fallback: '隐私',
        icon: Eye,
        keywords: '隐私 遥测 数据 收集 分析 privacy telemetry analytics',
      },
    ],
  },
  {
    // 版本与排查 —— appUpdate 与 about 相邻，合并候选
    titleKey: 'settingsV2.groupAbout',
    fallback: '关于',
    items: [
      {
        id: 'about',
        labelKey: 'settingsV2.aboutAndUpdate',
        fallback: '关于与更新',
        icon: Info,
        keywords: '关于 版本 更新 升级 许可 反馈 about version update upgrade license',
      },
      {
        id: 'logAnalysis',
        labelKey: 'settings.logAnalysis',
        fallback: '日志分析',
        icon: FileText,
        keywords: '日志 诊断 排查 导出 log debug diagnostics',
      },
    ],
  },
];

export function SettingsDialogV2(props: SettingsDialogV2Props): React.JSX.Element {
  const { initialSection = 'account', onClose } = props;
  // tt：字典里没这个 key 时回落到中文字面量，界面上不会露出 `settings.foo` 这种
  // 生 key。原是本文件的局部实现，2026-08-31 提到 settingsHelpers 供新 section
  // 共用（见那边 useTt 的注释：加一个 key 要动 19 本字典 + 99KB types.ts）。
  const tt = useTt();

  // V2 owns the active section (its sidebar drives it); the embedded
  // SettingsDialog reads it via `controlledSection` and reports in-panel
  // jumps (e.g. Memory → Connectors) back through `onSectionChange`.
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);

  /* ── 搜索（2026-09-02）────────────────────────────────────────
     24 个设置项此前只能靠眼睛在侧栏里从上往下扫。搜索放在导航上方而不是
     内容区，因为它过滤的是**导航本身**。
     没做防抖也没 useMemo：一次过滤是 24 项 × 一次 toLowerCase + includes，
     比 React 自己这次重渲染便宜得多，加缓存只会多一份要维护的依赖数组。
     （tt 每次渲染都是新函数引用，useMemo 挂它当依赖等于每次都失效。） */
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const filteredGroups = q
    ? NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          `${tt(item.labelKey, item.fallback)} ${item.fallback} ${item.keywords}`
            .toLowerCase()
            .includes(q),
        ),
      })).filter((group) => group.items.length > 0)
    : NAV_GROUPS;

  /* ⌘F 聚焦搜索框。**刻意不用 ⌘K**——那个键已被会话搜索
     （chat/components/dialogs/SessionSearchDialog.tsx）全局占用，在设置页
     抢它会让用户按惯用键时弹出会话搜索。监听只在本组件挂载期间存在，
     设置页一关就解绑，不给全局留残留。 */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      /* Escape：搜索框里**有内容**时只清空搜索，不关设置页。
         必须挂在 document 的 **capture** 阶段：SettingsDialog 有一个
         document 冒泡监听「Escape 关闭整个设置页」，而 capture 早于所有
         冒泡监听，在这里 stopPropagation 才拦得住它。
         为什么不用 React 的 onKeyDown + stopPropagation（第一版这么写、
         2026-09-02 真机走查证伪）：设置页渲染在 portal 里，原生事件的冒泡
         路径不经过 React root container，合成事件那条路拦不住 document 上
         的原生监听——探针实测 Escape 仍抵达 doc-bubble，设置页照关。
         搜索框为空、或焦点不在搜索框时**故意不拦**：那时用户按 Escape 的
         意图就是退出设置页，照常放行。 */
      if (e.key === 'Escape' && query && document.activeElement === searchRef.current) {
        e.stopPropagation();
        e.preventDefault();
        setQuery('');
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [query]);

  const activeMeta = (() => {
    for (const g of NAV_GROUPS) {
      const hit = g.items.find((i) => i.id === activeSection);
      if (hit) return hit;
    }
    return null;
  })();
  const activeLabel = activeMeta ? tt(activeMeta.labelKey, activeMeta.fallback) : '';

  return (
    /* 根节点保持 static（不能成为定位上下文）：embedded 面板里的绝对定位
       后代必须解析到 .sv2-content 时代同款的「内容卡」容器（下方 relative），
       否则会铺到侧栏上偷走点击。`sv2` 类 = 未迁移面板的 reskin 兼容层。 */
    <div className="sv2 h-full w-full">
      {/* 窗口底面 = rail 灰面（bg-sidebar），与主界面 shell 同一块底。
          absolute inset-0 解析到 App 的 fixed inset-0 宿主容器。 */}
      <div className="absolute inset-0 flex overflow-hidden bg-sidebar">
        {/* ── Sidebar ──
            w-61（244px）必须 == AppRail 的 w-61：设置页是全屏 overlay、自己
            画 rail，两边宽度不同则切换设置 ↔ 聊天时内容卡左边缘会跳
            （历史值 248 = 4px 抖动实锤）。改这里必须同步改 AppRail。
            relative z-[1]：压住内容卡，防止 embedded 里超高/绝对定位元素
            盖到导航上偷点击。 */}
        <aside className="relative z-[1] flex min-h-0 w-61 shrink-0 flex-col">
          {/* macOS 红绿灯避让空隙（原生窗口按钮画在 ~(13px, 19px)）。 */}
          <div className="h-10 shrink-0" />
          <Button
            variant="ghost"
            onClick={onClose}
            className="mx-2.5 my-2 h-[34px] justify-start gap-[9px] px-[11px] font-normal text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <ArrowLeft aria-hidden="true" />
            {tt('settingsV2.back', '返回应用')}
          </Button>
          {/* 搜索框：shadcn Input + 绝对定位的图标/清除钮。这一层（设置页
              侧栏）不在 canvas 裸元素 reset 的豁免范围内，裸 <input> 会被
              填成描边卡片——所以用 shadcn 原语（自带 data-slot 逃逸）。 */}
          <div className="relative mx-2.5 mb-2.5">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tt('settingsV2.searchPlaceholder', '搜索设置')}
              aria-label={tt('settingsV2.searchPlaceholder', '搜索设置')}
              className="h-8 bg-card pl-8 pr-8 text-[13px]"
            />
            {query ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
                aria-label={tt('settingsV2.searchClear', '清除搜索')}
                className="absolute right-1 top-1/2 size-6 -translate-y-1/2 p-0 text-muted-foreground hover:text-foreground"
              >
                <X />
              </Button>
            ) : null}
          </div>

          {/* pb-16 而不是原来的 pb-3.5：AppRail 的账户头像按钮浮在设置页
              overlay **之上**（左下角常驻），导航滚到底时会把最后一项压在
              头像底下点不到——2026-09-02 真机走查实锤（改前同样存在，只是
              当时末项是「关于」；本次重排把「日志分析」换到末位后更显眼）。
              64px = 头像 36px + 上下呼吸，让最后一项能滚过它。
              这里只加底部留白、不去动那个按钮的层级：让设置页打开时隐藏
              rail 账户按钮要改 AppRail/App.tsx，属于另一件事。 */}
          <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-16 pt-1">
            {filteredGroups.map((group) => (
              <div key={group.titleKey} className="pt-4 first:pt-1.5">
                <div className="px-3 pb-1.5 text-[11.5px] font-semibold tracking-[0.04em] text-muted-foreground">
                  {tt(group.titleKey, group.fallback)}
                </div>
                {/* flex-col + gap：items 之前是裸 map 出的 <Button> 直接块级堆叠，行间距=0。
                    选中态改用中性 hover 底之后（同 diff 上一条注释）问题被放大——active
                    与相邻行的 hover 现在是同一个 bg-sidebar-accent，0 间距时两行会糊成
                    一整块看不出分界（2026-07-21 用户截图实锤）。加 gap 撑开分隔。 */}
                <div className="flex flex-col gap-1">
                  {group.items.map((item) => {
                    const active = activeSection === item.id;
                    return (
                      <Button
                        key={item.id}
                        variant="ghost"
                        onClick={() => setActiveSection(item.id)}
                        /* 选中态改用中性 hover 底（2026-07-21，设计系统设置页重设计
                           走查时用户实锤）：之前选中态跟主题 accent 色走（--accent-soft/
                           --accent-strong），但用户默认主题色是饱和绿（DEFAULT_ACCENT_COLOR
                           #059669），选中项在 rail 里显得像一枚"成功"徽章而非普通选中态。
                           改沿用行本身的 hover 处理（bg-sidebar-accent），选中即常驻这个
                           底，只加粗字重做区分——跟随用户主题色的诉求交给聊天区其它真正
                           的 accent 点位（发送按钮、composer focus ring 等），设置导航项
                           不需要。inactive 态照抄 RailProjectList 的行 idiom。 */
                        className={cn(
                          'h-9 w-full justify-start gap-[11px] px-3 font-normal text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-foreground',
                          active && 'bg-sidebar-accent font-semibold text-sidebar-foreground',
                        )}
                      >
                        <item.icon aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-left">
                          {tt(item.labelKey, item.fallback)}
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            ))}
            {filteredGroups.length === 0 ? (
              <p className="px-3 py-10 text-center text-xs text-muted-foreground">
                {tt('settingsV2.searchEmpty', '没有匹配的设置项')}
              </p>
            ) : null}
          </nav>
        </aside>

        {/* ── Content ──
            内容面：与 app/globals.css 的 .shell-content-card 配对——2026-07-08
            两处同步平铺（用户要求去掉悬浮卡效果）：无 margin 灰缝、无圆角、
            无阴影，白面与侧栏灰底同一张纸，仅靠左缘 hairline 分隔。没直接
            复用那个类是因为它 unlayered 的 height:100% + overflow:hidden 会
            压过这里的 utility（布局需要 stretch + overflow-y:auto）。改观感
            两处同步，否则设置 ↔ 聊天切换时观感跳变。relative = embedded
            绝对定位后代的收容边界。 */}
        <div
          className="relative min-w-0 flex-1 overflow-y-auto border-l border-border/50 bg-card"
        >
          <div className="mx-auto max-w-[760px] px-10 pb-15 pt-11">
            {/* 'usage' 自己接管标题（见 UsageSection.tsx 头注释）：它需要一个
                sticky 标题栏，随滚动压缩并挂靠时间范围控件，跟这里画一个
                静态 <h1> 是两份独立的标题渲染逻辑——分别做 sticky 还要对齐
                两者的高度差，脆弱且没必要，不如整段让 UsageSection 独占。 */}
            {activeSection !== 'usage' && (
              <div className="mb-[26px]">
                <h1 className="text-[26px] font-semibold tracking-[-0.015em] text-foreground">
                  {activeLabel}
                </h1>
              </div>
            )}

            {/* The shared content pane: SettingsDialog in embedded mode renders
                ONLY the active section's panel (no chrome), wired to the same
                cfg / autosave / IPC as V1. settings-v2.css re-skins the shared
                `settings-*` classes inside `.sv2` so these panels match the
                V2 look. We forward every prop straight through. */}
            <SettingsDialog
              {...props}
              embedded
              controlledSection={activeSection}
              onSectionChange={setActiveSection}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
