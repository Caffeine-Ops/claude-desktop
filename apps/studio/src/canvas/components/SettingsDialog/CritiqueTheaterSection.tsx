import { MessageSquare } from 'lucide-react';
import { SettingCard, SettingGroup, SettingRow, SettingSwitchRow } from '../settings/SettingPrimitives';

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
    <section>
      {/* 2026-09-02 走查实锤：这里原本还有一个 <h3>{settingsNav}</h3>，与外层
          渲染的页面标题**一字不差地重复**，删掉。2026-09-04 再删掉紧跟的说明
          <p>{settingsNavHint}——壳的页头现在会画同一句副标题（useSectionHeaders），
          留着就是第二次「说了两遍」。 */}
      {/* 2026-09-02 P2：换 SettingCard/SettingRow。原本开关行下面挂着两段
          说明 <p>，现在拆成两行——第二段（项目相关提示）本就是独立的一条
          信息，单独占一行比堆在开关底下更好读。
          注意不能把两段都塞进同一个 hint：SettingRow 的 hint 渲染在 <p> 里，
          里面再放 <p> 是非法嵌套，浏览器会自动拆开、间距全乱。 */}
      <SettingGroup>
        <SettingCard>
          <SettingSwitchRow
            icon={<MessageSquare />}
            title={t('critiqueTheater.settingsEnabledLabel')}
            hint={t('critiqueTheater.settingsEnabledDescription')}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          <SettingRow
            hint={
              activeProjectId !== null
                ? t('critiqueTheater.settingsEnabledProjectHint')
                : t('critiqueTheater.settingsEnabledNoProjectHint')
            }
          />
        </SettingCard>
      </SettingGroup>
    </section>
  );
}
