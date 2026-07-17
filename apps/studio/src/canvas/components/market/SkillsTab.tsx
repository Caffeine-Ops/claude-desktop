import { Check } from 'lucide-react';
import type { MarketRegistry, SkillsMarketInstalledItem } from '@open-design/contracts';
import { Badge } from '@/src/components/ui/badge';
import { EntryRow, matchesQuery } from './EntryRow';
import { InstallButton } from './InstallButton';

// 技能 tab：已安装区（含本地手放目录）+ 市场技能全列表。点行开技能弹层。

export function SkillsTab({
  registry,
  installed,
  bundledIds,
  installingIds,
  query,
  onInstall,
  onRequestUninstall,
  onOpenSkill,
}: {
  registry: MarketRegistry;
  installed: SkillsMarketInstalledItem[];
  bundledIds: Set<string>;
  installingIds: Set<string>;
  query: string;
  onInstall: (id: string) => void;
  onRequestUninstall: (name: string) => void;
  onOpenSkill: (id: string) => void;
}) {
  const searching = query.trim().length > 0;
  const byId = new Map(registry.entries.map((e) => [e.id, e]));
  const installedNames = new Set(installed.map((i) => i.name));
  const skills = registry.entries.filter((e) => e.kind === 'skill' && matchesQuery(e, query));

  // 只收 kind==='skill' 的市场条目 + 本地手放目录（本地目录没有 kind，但
  // 物理上只可能来自 skillsRoot——插件没有"手放"场景，见 skillsDir.ts 注释）；
  // 否则分目录后装的插件会连带出现在这个技能 tab 的「已安装」区。
  const installedRows = installed
    .filter((item) => item.origin === 'local' || item.kind === 'skill')
    .map((item) => ({ item, entry: byId.get(item.name) }))
    .filter(({ item, entry }) =>
      matchesQuery(
        entry ?? { id: item.name, name: item.name, displayName: item.name, description: '', keywords: [] },
        query,
      ),
    );

  return (
    <div>
      <section className="mt-8">
        <h2 className="border-b border-border pb-3 text-[15px] font-[650]">已安装</h2>
        <div className="mt-1.5 grid grid-cols-1 gap-x-7 min-[860px]:grid-cols-2">
          {installedRows.map(({ item, entry }) => (
            <EntryRow
              key={item.name}
              entry={entry ?? { id: item.name, name: item.name, displayName: item.name, description: '本地技能目录' }}
              sub={entry?.description ?? '~/.cowork/skills 下的本地目录'}
              onClick={entry ? () => onOpenSkill(entry.id) : undefined}
              right={
                <span className="flex shrink-0 items-center gap-2">
                  {item.origin === 'local' ? (
                    <Badge variant="secondary" className="text-muted-foreground">
                      本地
                    </Badge>
                  ) : null}
                  <InstallButton
                    id={item.name}
                    installed
                    installing={installingIds.has(item.name)}
                    updateAvailable={item.updateAvailable}
                    onInstall={onInstall}
                    onRequestUninstall={onRequestUninstall}
                  />
                </span>
              }
            />
          ))}
        </div>
        {installedRows.length === 0 ? (
          <p className="py-4 text-xs text-muted-foreground">
            {searching ? '已安装里没有匹配项' : '还没有安装技能'}
          </p>
        ) : null}
      </section>

      <section className="mt-9">
        <h2 className="border-b border-border pb-3 text-[15px] font-[650]">全部技能</h2>
        <div className="mt-1.5 grid grid-cols-1 gap-x-7 min-[860px]:grid-cols-2">
          {skills.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              onClick={() => onOpenSkill(entry.id)}
              right={
                installedNames.has(entry.id) ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-[hsl(var(--brand))]">
                    <Check className="size-3.5" /> 已安装
                  </span>
                ) : (
                  <InstallButton
                    id={entry.id}
                    installed={false}
                    installing={installingIds.has(entry.id)}
                    builtin={bundledIds.has(entry.id)}
                    onInstall={onInstall}
                    onRequestUninstall={onRequestUninstall}
                  />
                )
              }
            />
          ))}
        </div>
        {skills.length === 0 ? (
          <div className="mt-6 rounded-[14px] border border-dashed border-border px-6 py-12 text-center text-muted-foreground">
            <p className="text-sm font-medium text-foreground">
              {searching ? '没有找到相关技能' : '市场里还没有技能条目'}
            </p>
            <p className="mt-1.5 text-[12.5px]">{searching ? '换个关键词试试' : '等仓库发布后刷新'}</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
