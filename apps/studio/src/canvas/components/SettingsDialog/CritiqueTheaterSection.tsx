import { Switch } from '@/src/components/ui/switch';

import { useI18n } from '../../i18n';
import { useRoute } from '../../router';
import {
  setCritiqueTheaterEnabled,
  useCritiqueTheaterEnabled,
} from '../Theater';

/**
 * Settings surface for the M1 Critique Theater rollout toggle.
 *
 * The toggle has two halves on opposite sides of the HTTP boundary:
 *
 *   * Browser-side: `useCritiqueTheaterEnabled` reads / writes the
 *     `open-design:config` localStorage blob; this is what gates
 *     whether `<CritiqueTheaterMount>` actually renders.
 *   * Daemon-side: the rollout resolver in `server.ts` reads
 *     `project.metadata.critiqueTheaterEnabled`, so the daemon only
 *     routes runs through the critique pipeline when the active
 *     project's metadata row says yes (or env / phase / skill policy
 *     overrides it).
 *
 * If we only wrote localStorage, the user would see the mount but
 * every generation would still skip the critique pipeline server-side
 * (Codex + lefarcen P1 on PR #1484). To keep the two halves in
 * lockstep, the setter takes an optional `{ projectId }` and, when
 * provided, does the read-merge-write PATCH on the project's metadata
 * (already shipped by Phase 15 and exercised by the wireup PR).
 *
 * This section threads the currently-open project id when the dialog
 * is opened from `/projects/:id`. When opened from the entry gallery
 * (`/`), the toggle is localStorage-only, and a contextual hint tells
 * the user that per-project persistence requires opening a project
 * first. That matches the actual scope of the wire-up.
 */
export function CritiqueTheaterSection() {
  const { t } = useI18n();
  const enabled = useCritiqueTheaterEnabled();
  const route = useRoute();
  const activeProjectId = route.kind === 'project' ? route.projectId : null;
  const setEnabled = (next: boolean) => {
    if (activeProjectId !== null) {
      void setCritiqueTheaterEnabled(next, { projectId: activeProjectId });
    } else {
      void setCritiqueTheaterEnabled(next);
    }
  };
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          {t('critiqueTheater.settingsNav')}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('critiqueTheater.settingsNavHint')}
        </p>
      </div>
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <label
            className="cursor-pointer text-[13px] font-medium text-foreground"
            htmlFor="critique-theater-enabled"
          >
            {t('critiqueTheater.settingsEnabledLabel')}
          </label>
          <Switch
            id="critique-theater-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
        <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
          {t('critiqueTheater.settingsEnabledDescription')}
        </p>
        {activeProjectId !== null ? (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {t('critiqueTheater.settingsEnabledProjectHint')}
          </p>
        ) : (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {t('critiqueTheater.settingsEnabledNoProjectHint')}
          </p>
        )}
      </div>
    </section>
  );
}
