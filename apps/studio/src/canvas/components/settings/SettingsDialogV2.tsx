/*
 * SettingsDialogV2 — the redesigned skin for the Settings page.
 * -----------------------------------------------------------
 * WHY THIS EXISTS
 *   The original SettingsDialog.tsx is a ~6.7k-line component that owns the
 *   navigation + all ~18 panels + autosave + per-section state. Rather than
 *   fork all of that, V2 is a thin SHELL: it draws the prototype look
 *   (docs/ui-prototype-settings-b.html — `.sv2` chrome, grouped sidebar) and
 *   hosts the EXACT same section logic by rendering SettingsDialog in its new
 *   `embedded` mode. In embedded mode SettingsDialog drops its own chrome
 *   (backdrop, frame, back button, header, sidebar, footer) and renders only
 *   the section content pane, driven by a CONTROLLED `activeSection` that V2's
 *   sidebar owns. Result: one implementation of every panel + autosave, zero
 *   drift between V1 and V2, and V2 only has to style the shell + (via
 *   settings-v2.css) re-skin the shared content classes.
 *
 *   App.tsx picks V1 vs V2 behind `settingsV2Enabled()`, so the classic dialog
 *   is one flag away during rollout.
 */

import { useState } from 'react';

import { useI18n } from '../../i18n';
import { Icon } from '../shared/Icon';
import type { IconName } from '../shared/Icon';
import { SettingsDialog } from '../SettingsDialog';
import type { SettingsDialogProps, SettingsSection } from '../SettingsDialog';

/* V2 takes the SAME props as SettingsDialog (it forwards them straight into
   the embedded instance), so App.tsx hands V1 and V2 identical objects. */
type SettingsDialogV2Props = SettingsDialogProps;

/* ── Sidebar model. Grouped to match the prototype's three buckets.
   `icon` is a lucide name resolved by <Icon>; labels go through i18n with a
   literal fallback so a missing key never blanks a row. ── */
type NavItem = {
  id: SettingsSection;
  labelKey: string;
  fallback: string;
  icon: IconName;
};
type NavGroup = { titleKey: string; fallback: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    titleKey: 'settingsV2.groupGeneral',
    fallback: '通用',
    items: [
      { id: 'execution', labelKey: 'settings.execution', fallback: '执行模式', icon: 'sliders' },
      { id: 'instructions', labelKey: 'settings.instructions', fallback: 'Instructions / Rules', icon: 'pencil' },
      { id: 'memory', labelKey: 'settings.memory', fallback: '记忆', icon: 'history' },
      { id: 'language', labelKey: 'settings.language', fallback: '界面语言', icon: 'languages' },
      { id: 'appearance', labelKey: 'settings.appearance', fallback: '外观', icon: 'sun-moon' },
      { id: 'notifications', labelKey: 'settings.notifications', fallback: '通知', icon: 'bell' },
    ],
  },
  {
    titleKey: 'settingsV2.groupExtensions',
    fallback: '扩展与集成',
    items: [
      { id: 'media', labelKey: 'settings.media', fallback: '媒体生成提供商', icon: 'image' },
      { id: 'skills', labelKey: 'settings.skills', fallback: '技能', icon: 'grid' },
      { id: 'composio', labelKey: 'settings.composio', fallback: '外部 MCP', icon: 'sparkles' },
      { id: 'integrations', labelKey: 'settings.integrations', fallback: '连接器', icon: 'sliders' },
      { id: 'mcpClient', labelKey: 'settings.mcpClient', fallback: 'MCP 服务器', icon: 'link' },
    ],
  },
  {
    titleKey: 'settingsV2.groupAdvanced',
    fallback: '高级设置',
    items: [
      { id: 'critiqueTheater', labelKey: 'settings.critiqueTheater', fallback: '设计评审团', icon: 'comment' },
      { id: 'pet', labelKey: 'settings.pet', fallback: '宠物', icon: 'sparkles' },
      { id: 'designSystems', labelKey: 'settings.designSystems', fallback: '设计系统', icon: 'palette' },
      { id: 'privacy', labelKey: 'settings.privacy', fallback: '隐私', icon: 'eye' },
      { id: 'logAnalysis', labelKey: 'settings.logAnalysis', fallback: '日志分析', icon: 'history' },
      { id: 'about', labelKey: 'settings.about', fallback: '关于', icon: 'settings' },
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
    <div className="sv2">
      <div className="sv2-window">
        {/* ── Sidebar ── */}
        <aside className="sv2-sidebar">
          <div className="sv2-sidebar-top" />
          <button type="button" className="sv2-back-btn" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 8H3M7 4 3 8l4 4" />
            </svg>
            {tt('settingsV2.back', '返回应用')}
          </button>
          <nav className="sv2-nav">
            {NAV_GROUPS.map((group) => (
              <div key={group.titleKey}>
                <div className="sv2-nav-group">{tt(group.titleKey, group.fallback)}</div>
                {group.items.map((item) => {
                  const active = activeSection === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      // Selected row tints with the app accent (matches the
                      // chat sidebar's selected pill), so it re-skins with the
                      // user's chosen theme color instead of a fixed grey.
                      className={'sv2-nav-item' + (active ? ' active accent' : '')}
                      onClick={() => setActiveSection(item.id)}
                    >
                      <Icon name={item.icon} size={16} aria-hidden="true" />
                      <span className="label">{tt(item.labelKey, item.fallback)}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        </aside>

        {/* ── Content ── */}
        <div className="sv2-content">
          <div className="sv2-content-col">
            <div className="sv2-page-head">
              <h1>{activeLabel}</h1>
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
