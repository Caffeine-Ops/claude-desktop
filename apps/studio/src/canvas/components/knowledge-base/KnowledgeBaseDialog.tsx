/*
 * KnowledgeBaseDialog —— 知识库管理页的壳，**照搬 SettingsDialogV2 的布局骨架**
 * （用户要求「跟设置页面一样」）：全屏 overlay 内 = 左侧 w-61 导航栏 + 右侧
 * border-l bg-card 内容区，同一套标题栏 / 分区 / 间距节奏。
 *
 * 与 SettingsDialogV2 的差别：
 *   - 不带 `sv2` 兼容类——那是设置页给「未迁移的 embedded 面板」补 V2 皮肤的
 *     legacy 兼容层（settings-v2.css 的 .sv2 .settings-* 系列）；知识库是全新
 *     纯 shadcn + Tailwind utility，无 legacy 面板要 reskin，加 sv2 反引入干扰。
 *   - 内容区第一版为空白（用户要求）：侧栏只有一个占位分区「全部文件」，右侧
 *     内容区仅标题 + 空白。后续把文件列表 / 上传 / 检索填进内容区即可。
 *
 * 样式纪律（同 SettingsDialogV2 头注释，canvas 链 CSS unlayered）：本文件所有
 * 元素**不复用任何 .sv2-* / .settings-* legacy 类**，布局全靠 utility + shadcn
 * 原语（自带 data-slot，天然豁免 canvas 裸元素 reset）。选中态用共享 design-
 * tokens 的 --accent-soft / --accent-strong（跟随用户主题色），同设置侧栏选中行。
 */

import { useState } from 'react';
import { ArrowLeft, Files, FolderKanban, Images, Tags, type LucideIcon } from 'lucide-react';

import { Button } from '@/src/components/ui/button';
import { cn } from '@/src/lib/utils';
import { useI18n } from '../../i18n';
import { AllFilesPanel } from './AllFilesPanel';
import { DocCatalogPanel } from './DocCatalogPanel';
import { CategoryManagePanel } from './CategoryManagePanel';

/** 侧栏分区项。 */
type KbSection = 'all-files' | 'doc-catalog' | 'image-catalog' | 'categories';

type NavItem = {
  id: KbSection;
  labelKey: string;
  fallback: string;
  icon: LucideIcon;
};

/* i18n 走 tt 带字面量兜底——缺 key 时显示中文而非裸 key（同 SettingsDialogV2
   的 tt 约定）。 */
const NAV_ITEMS: NavItem[] = [
  { id: 'all-files', labelKey: 'knowledgeBase.allFiles', fallback: '全部文件', icon: Files },
  { id: 'doc-catalog', labelKey: 'knowledgeBase.docCatalog', fallback: '文档识别', icon: FolderKanban },
  { id: 'image-catalog', labelKey: 'knowledgeBase.imageCatalog', fallback: '图片识别', icon: Images },
  { id: 'categories', labelKey: 'knowledgeBase.categories', fallback: '分类管理', icon: Tags },
];

export function KnowledgeBaseDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
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
    // 根节点 static（不成为定位上下文）：与 SettingsDialogV2 同构，absolute
    // inset-0 解析到 App 的 fixed inset-0 宿主容器。
    <div className="h-full w-full">
      {/* 窗口底面 = rail 灰面（bg-sidebar），与主界面 shell 同一块底。 */}
      <div className="absolute inset-0 flex overflow-hidden bg-sidebar">
        {/* ── Sidebar ──
            w-61（244px）== AppRail 的 w-61（同设置页纪律：宽度不一致则切换时
            内容卡左缘跳动）。relative z-[1] 压住内容卡防止越界偷点击。 */}
        <aside className="relative z-[1] flex min-h-0 w-61 shrink-0 flex-col">
          {/* macOS 红绿灯避让空隙（同 SettingsDialogV2）。 */}
          <div className="h-10 shrink-0" />
          {/* 返回应用：剥掉 ?kb=1 回原面（onClose 由 App 注入，走 back 剥参）。 */}
          <Button
            variant="ghost"
            onClick={onClose}
            className="mx-2.5 my-2 h-[34px] justify-start gap-[9px] px-[11px] font-normal text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <ArrowLeft aria-hidden="true" />
            {tt('settingsV2.back', '返回应用')}
          </Button>
          <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3.5 pt-1">
            {/* 分区标题（占位阶段单组，无组名——一项时组名多余）。 */}
            <div className="pt-1.5">
              {NAV_ITEMS.map((item) => {
                const active = activeSection === item.id;
                return (
                  <Button
                    key={item.id}
                    variant="ghost"
                    onClick={() => setActiveSection(item.id)}
                    // 选中态用共享 design-tokens 的 accent（跟随用户主题色），
                    // inactive 照抄设置侧栏行 idiom。
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
          </nav>
        </aside>

        {/* ── Content ──
            与设置页内容区同构：border-l bg-card 平铺白面，26px 标题。relative
            = 后续绝对定位后代的收容边界。两个分区都是卡片/网格形态，760px 会
            把每行压得太窄，统一放宽到 1160px。 */}
        <div className="relative min-w-0 flex-1 overflow-y-auto border-l border-border/50 bg-card">
          <div className="mx-auto max-w-[1160px] px-10 pb-15 pt-11">
            {/* 面板各自带标题行（标题右侧挂各自的工具组/主按钮）。文档/图片
                识别共用 DocCatalogPanel，domain prop 选域。 */}
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
    </div>
  );
}
