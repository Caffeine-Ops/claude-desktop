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
 *   ☐ language / about（SettingsDialog.tsx 内联，小）
 *   ☐ AppearanceSection      ☐ NotificationsSection   ☐ CritiqueTheaterSection
 *   ☐ MediaProvidersSection  ☐ IntegrationsSection    ☐ McpClientSection
 *   ☐ SkillsSection          ☐ PrivacySection         ☐ LogAnalysisSection
 *   ☐ ConnectorSection       ☐ OrbitSection           ☐ memory / instructions /
 *     pet / designSystems（各自组件）  ☐ MemoryModelInline（不在 @source 内，
 *     迁时要么挪目录要么给它所在目录也加 @source）
 *   全部打勾后：删 .sv2 兼容类、settings-v2.css、settings-modal.css 及
 *   settings-orbit.css 里 agent- 与 field- 两族选择器段；var(--green) 等状态
 *   色在 design-tokens 转正（见 SettingsDialog.tsx 顶部 TEST_STATUS_TONES
 *   注释）。（这里不能写「星号斜杠」连排——会提前闭合本块注释，07-04 CSS
 *   注释同款事故。）
 */

import { useState } from 'react';
import {
  ArrowLeft,
  Bell,
  Blocks,
  Eye,
  Flag,
  Folder,
  History,
  Image,
  Languages,
  LayoutGrid,
  Link,
  MessageSquare,
  Palette,
  Pencil,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SunMoon,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/src/components/ui/button';
import { cn } from '@/src/lib/utils';
import { useI18n } from '../../i18n';
import { SettingsDialog } from '../SettingsDialog';
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
};
type NavGroup = { titleKey: string; fallback: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    titleKey: 'settingsV2.groupGeneral',
    fallback: '通用',
    items: [
      { id: 'execution', labelKey: 'settings.execution', fallback: '执行模式', icon: SlidersHorizontal },
      { id: 'instructions', labelKey: 'settings.instructions', fallback: 'Instructions / Rules', icon: Pencil },
      { id: 'memory', labelKey: 'settings.memory', fallback: '记忆', icon: History },
      { id: 'language', labelKey: 'settings.language', fallback: '界面语言', icon: Languages },
      { id: 'appearance', labelKey: 'settings.appearance', fallback: '外观', icon: SunMoon },
      { id: 'notifications', labelKey: 'settings.notifications', fallback: '通知', icon: Bell },
      { id: 'appUpdate', labelKey: 'settings.appUpdate', fallback: '更新应用', icon: RefreshCw },
    ],
  },
  {
    // 「工作区」组（2026-07-04）：原首页 EntryNavRail 的 项目/自动化/插件
    // 迁入设置页（设计系统/连接器本就有 section，rail 侧只删图标）。内容
    // 宿主见 WorkspaceSections.tsx，数据经 workspaceHost prop 由 App 注入。
    titleKey: 'settingsV2.groupWorkspace',
    fallback: '工作区',
    items: [
      { id: 'projects', labelKey: 'settingsV2.workspaceProjects', fallback: '项目', icon: Folder },
      { id: 'automations', labelKey: 'settingsV2.workspaceAutomations', fallback: '自动化', icon: Flag },
      { id: 'plugins', labelKey: 'settingsV2.workspacePlugins', fallback: '插件', icon: Blocks },
    ],
  },
  {
    titleKey: 'settingsV2.groupExtensions',
    fallback: '扩展与集成',
    items: [
      { id: 'media', labelKey: 'settings.media', fallback: '媒体生成提供商', icon: Image },
      { id: 'skills', labelKey: 'settings.skills', fallback: '技能', icon: LayoutGrid },
      { id: 'composio', labelKey: 'settings.composio', fallback: '外部 MCP', icon: Sparkles },
      { id: 'integrations', labelKey: 'settings.integrations', fallback: '连接器', icon: SlidersHorizontal },
      { id: 'mcpClient', labelKey: 'settings.mcpClient', fallback: 'MCP 服务器', icon: Link },
    ],
  },
  {
    titleKey: 'settingsV2.groupAdvanced',
    fallback: '高级设置',
    items: [
      { id: 'critiqueTheater', labelKey: 'settings.critiqueTheater', fallback: '设计评审团', icon: MessageSquare },
      { id: 'pet', labelKey: 'settings.pet', fallback: '宠物', icon: Sparkles },
      { id: 'designSystems', labelKey: 'settings.designSystems', fallback: '设计系统', icon: Palette },
      { id: 'privacy', labelKey: 'settings.privacy', fallback: '隐私', icon: Eye },
      { id: 'logAnalysis', labelKey: 'settings.logAnalysis', fallback: '日志分析', icon: History },
      { id: 'about', labelKey: 'settings.about', fallback: '关于', icon: Settings },
    ],
  },
];

export function SettingsDialogV2(props: SettingsDialogV2Props): React.JSX.Element {
  const { initialSection = 'appearance', onClose } = props;
  const { t } = useI18n();
  // tt: translate with a literal fallback so a not-yet-added i18n key shows
  // the Chinese label instead of the raw key.
  const tt = (key: string, fallback: string): string => {
    const v = t(key as Parameters<typeof t>[0]);
    return v === key ? fallback : v;
  };

  // V2 owns the active section (its sidebar drives it); the embedded
  // SettingsDialog reads it via `controlledSection` and reports in-panel
  // jumps (e.g. Memory → Connectors) back through `onSectionChange`.
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);

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
          <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3.5 pt-1">
            {NAV_GROUPS.map((group) => (
              <div key={group.titleKey} className="pt-4 first:pt-1.5">
                <div className="px-3 pb-1.5 text-[11.5px] font-semibold tracking-[0.04em] text-muted-foreground">
                  {tt(group.titleKey, group.fallback)}
                </div>
                {group.items.map((item) => {
                  const active = activeSection === item.id;
                  return (
                    <Button
                      key={item.id}
                      variant="ghost"
                      onClick={() => setActiveSection(item.id)}
                      /* Selected row tints with the app accent（--accent-soft/
                         --accent-strong 来自共享 design-tokens，非 canvas 私有），
                         matches the chat sidebar's selected pill，跟随用户主题色。
                         inactive 态照抄 RailProjectList 的行 idiom。 */
                      className={cn(
                        'h-9 w-full justify-start gap-[11px] px-3 font-normal text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-foreground',
                        active &&
                          'bg-[var(--accent-soft)] font-semibold text-[var(--accent-strong)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]',
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
            ))}
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
            <div className="mb-[26px]">
              <h1 className="text-[26px] font-semibold tracking-[-0.015em] text-foreground">
                {activeLabel}
              </h1>
            </div>

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
