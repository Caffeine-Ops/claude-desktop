// Lovart-style left navigation rail for the entry view.
//
// Renders a narrow icon-only column of the primary destinations users
// expect to keep in reach: Home, new project, projects, automations,
// design systems, plugins, and integrations.
// Language switching and other account-scoped controls live behind the
// floating settings cog in the top-right corner of the main content.

import type { ReactNode } from 'react';
import { UpdaterPopup } from './UpdaterPopup';
import { useT } from '../i18n';

export type EntryView =
  | 'home'
  | 'onboarding'
  | 'projects'
  | 'tasks'
  | 'plugins'
  | 'design-systems'
  | 'integrations';

interface Props {
  view: EntryView;
  onViewChange: (view: EntryView) => void;
  onNewProject: () => void;
}

// Rail glyphs are inlined here (rather than going through the shared `Icon`
// component) so the rail matches prototypes/open-design-nav-v0.html `.rail`
// 1:1 — 19px artwork at stroke 1.8, with a couple of marks (tasks = a
// flow/flag mark, design-systems = stacked layers) that differ from the
// shared set's kanban/blocks. Keeping them local also means swapping the
// rail's look never disturbs kanban/blocks/home usages elsewhere.
function RailIcon({ children, strokeWidth = 1.8 }: { children: ReactNode; strokeWidth?: number }) {
  return (
    <svg
      width={19}
      height={19}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  );
}

interface NavButtonProps {
  active?: boolean;
  /** Action buttons (e.g. "new project") open a flow rather than switch
   *  views — they get the accent-tinted create affordance on hover and
   *  never carry `is-active`/`aria-current`. */
  action?: boolean;
  ariaLabel: string;
  tooltip: string;
  onClick: () => void;
  testId?: string;
  children: ReactNode;
}

function NavButton({ active, action, ariaLabel, tooltip, onClick, testId, children }: NavButtonProps) {
  return (
    <button
      type="button"
      className={`entry-nav-rail__btn${active ? ' is-active' : ''}${action ? ' entry-nav-rail__btn--action' : ''}`}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      data-tooltip={tooltip}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {children}
    </button>
  );
}

export function EntryNavRail({ view, onViewChange, onNewProject }: Props) {
  const t = useT();
  const homeLabel = t('entry.navHome');
  const isHome = view === 'home';

  return (
    <nav className="entry-nav-rail" aria-label="Primary">
      <div className="entry-nav-rail__group">
        <NavButton
          active={isHome}
          ariaLabel={homeLabel}
          tooltip={homeLabel}
          onClick={() => onViewChange('home')}
          testId="entry-nav-home"
        >
          <RailIcon>
            <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <path d="M9 22V12h6v10" />
          </RailIcon>
        </NavButton>
        <UpdaterPopup />
        <NavButton
          action
          ariaLabel={t('entry.navNewProject')}
          tooltip={t('entry.navNewProject')}
          onClick={onNewProject}
          testId="entry-nav-new-project"
        >
          <RailIcon strokeWidth={1.9}>
            <path d="M12 5v14M5 12h14" />
          </RailIcon>
        </NavButton>
        <NavButton
          active={view === 'projects'}
          ariaLabel={t('entry.navProjects')}
          tooltip={t('entry.navProjects')}
          onClick={() => onViewChange('projects')}
          testId="entry-nav-projects"
        >
          <RailIcon>
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.6-.8l-.9-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          </RailIcon>
        </NavButton>
        <NavButton
          active={view === 'tasks'}
          ariaLabel={t('entry.navTasks')}
          tooltip={t('entry.navTasks')}
          onClick={() => onViewChange('tasks')}
          testId="entry-nav-tasks"
        >
          <RailIcon>
            <path d="M5 3v18M5 7h9l-2 3 2 3H5" />
          </RailIcon>
        </NavButton>
        <NavButton
          active={view === 'design-systems'}
          ariaLabel={t('entry.navDesignSystems')}
          tooltip={t('entry.navDesignSystems')}
          onClick={() => onViewChange('design-systems')}
          testId="entry-nav-design-systems"
        >
          <RailIcon>
            <path d="M3.5 8 12 3l8.5 5L12 13z" />
            <path d="m3.5 12 8.5 5 8.5-5" />
            <path d="m3.5 16 8.5 5 8.5-5" />
          </RailIcon>
        </NavButton>
        <NavButton
          active={view === 'plugins'}
          ariaLabel={t('entry.navPlugins')}
          tooltip={t('entry.navPlugins')}
          onClick={() => onViewChange('plugins')}
          testId="entry-nav-plugins"
        >
          <RailIcon>
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </RailIcon>
        </NavButton>
        <NavButton
          active={view === 'integrations'}
          ariaLabel={t('entry.navIntegrations')}
          tooltip={t('entry.navIntegrations')}
          onClick={() => onViewChange('integrations')}
          testId="entry-nav-integrations"
        >
          <RailIcon>
            <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
            <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
          </RailIcon>
        </NavButton>
      </div>
    </nav>
  );
}
