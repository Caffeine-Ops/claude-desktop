/**
 * 设置页「使用帮助」分区（2026-09-04）。
 *
 * 内容全部来自 src/chat/lib/helpContent.ts，这里只管渲染：一组一张组卡
 * （SettingGroup + SettingCard），卡内每条是一个原生 <details> 折叠块，点问题
 * 展开回答，回答末尾按 action 渲染一颗「去看看」按钮。
 *
 * 为什么用原生 <details> 而不是引 accordion 组件：执行模式页已经在用同一套
 * <details> 写法（SettingsDialog.tsx 的 MemoryModelInline 折叠块），开合状态交给
 * 浏览器，零 state、零依赖；本仓库的 components/ui 里也没有 accordion 原语。
 *
 * 三种动作为什么这样实现：
 * - section：切设置分区，走父组件的 setActiveSection（embedded 模式下会经
 *   onSectionChange 回报给 V2 壳，与「记忆 → 连接器」的既有面内跳转同一条路）。
 * - surface：设置页是盖住 rail 的全屏 overlay，必须**先关设置再开面**，否则面
 *   开了也被设置页盖着看不见。openSurfaceOverlay 来自根层 store（src/stores/surfaceOverlay.ts），
 *   chat 树的 FusionRuntimeProvider.tsx（/plugins 斜杠命令）已有同样的跨树调用先例。
 * - feedback：与关于分区「问题反馈」行同一调用（useDialogStore.openDialog）。
 *
 * 样式纪律（CLAUDE.md）：只用 shadcn 原语 + Tailwind utility；裸 <details>/<summary>
 * 带 data-slot 逃逸 canvas 的裸元素 reset。
 */

import { ChevronRight } from 'lucide-react';

import { Button } from '@/src/components/ui/button';
import { HELP_GROUPS, type HelpAction, type HelpItem } from '@/src/chat/lib/helpContent';
import { useDialogStore } from '@/src/chat/stores/dialogs';
import { openSurfaceOverlay } from '@/src/stores/surfaceOverlay';

import type { SettingsSection } from '../SettingsDialog/settingsHelpers';
import { SettingCard, SettingGroup } from './SettingPrimitives';

interface HelpSectionProps {
  /** 切到设置页的另一个分区（设置页保持打开） */
  onSelectSection: (section: SettingsSection) => void;
  /** 关闭设置页；跳侧栏面之前必须先调它 */
  onClose: () => void;
}

const DEFAULT_ACTION_LABEL = '去看看';

export function HelpSection({ onSelectSection, onClose }: HelpSectionProps): React.JSX.Element {
  const runAction = (action: HelpAction): void => {
    if (action.kind === 'section') {
      onSelectSection(action.section);
      return;
    }
    if (action.kind === 'surface') {
      onClose();
      openSurfaceOverlay(action.surface);
      return;
    }
    useDialogStore.getState().openDialog('feedback');
  };

  return (
    <section>
      {HELP_GROUPS.map((group) => (
        <SettingGroup key={group.id} label={group.title}>
          <SettingCard>
            {group.items.map((item) => (
              <HelpItemRow key={item.id} item={item} onAction={runAction} />
            ))}
          </SettingCard>
        </SettingGroup>
      ))}
    </section>
  );
}

function HelpItemRow({
  item,
  onAction,
}: {
  item: HelpItem;
  onAction: (action: HelpAction) => void;
}): React.JSX.Element {
  return (
    <details data-slot="help-item" className="group">
      <summary
        data-slot="help-item-summary"
        className="flex cursor-pointer select-none list-none items-center gap-2 px-3.5 py-3 transition-colors hover:bg-secondary/50 [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span className="text-[13px] font-medium text-foreground">{item.question}</span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-border/50 px-3.5 pb-4 pt-3 pl-[2.375rem]">
        {item.answer.map((paragraph, index) => (
          <p key={index} className="text-[13px] leading-relaxed text-muted-foreground">
            {paragraph}
          </p>
        ))}
        {item.action ? (
          <div className="mt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onAction(item.action as HelpAction)}
            >
              {item.action.label ?? DEFAULT_ACTION_LABEL}
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
