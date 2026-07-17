import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { MarketEntry, MarketRegistry, SkillsMarketInstalledItem } from '@open-design/contracts';
import { EntryRow, matchesQuery } from './EntryRow';
import { EntryTile } from './tile';
import { InstallButton } from './InstallButton';
import { tilePopIn } from './motion';

// 插件 tab：已安装横排 mini-tile + 按 registry 分类分区的插件列表。
// 精选（featured===true）条目额外出现在顶部「精选」分区（app store 惯例：
// 既在自己的常规分类里，也在精选轮播/分区里再露一次）。点行进详情页
// （/market/:id），安装按钮原位三态。

function fallbackTileEntry(name: string): Pick<MarketEntry, 'id' | 'name' | 'displayName' | 'composerIcon' | 'brandColor'> {
  return { id: name, name, displayName: name };
}

export function PluginsTab({
  registry,
  installed,
  bundledIds,
  installingIds,
  query,
  onInstall,
  onRequestUninstall,
  onOpenDetail,
}: {
  registry: MarketRegistry;
  installed: SkillsMarketInstalledItem[];
  bundledIds: Set<string>;
  installingIds: Set<string>;
  query: string;
  onInstall: (id: string) => void;
  onRequestUninstall: (name: string) => void;
  onOpenDetail: (id: string) => void;
}) {
  const reduce = useReducedMotion();
  const searching = query.trim().length > 0;
  const byId = new Map(registry.entries.map((e) => [e.id, e]));
  const installedNames = new Set(installed.map((i) => i.name));
  const plugins = registry.entries.filter((e) => e.kind === 'plugin' && matchesQuery(e, query));

  // 分类分区：registry.categories 顺序优先，未归入任何已知分类的落「其他」
  const categories = [...registry.categories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const knownCatIds = new Set(categories.map((c) => c.id));
  const sections: { title: string; items: MarketEntry[] }[] = [];
  const featured = plugins.filter((e) => e.featured);
  if (featured.length > 0) sections.push({ title: '精选', items: featured });
  for (const cat of categories) {
    const items = plugins.filter((e) => e.category === cat.id);
    if (items.length > 0) sections.push({ title: cat.title, items });
  }
  const leftovers = plugins.filter((e) => !e.category || !knownCatIds.has(e.category));
  if (leftovers.length > 0) sections.push({ title: '其他', items: leftovers });

  // 已安装横排：只收 kind==='plugin' 的市场条目——插件没有"手放"场景（本地
  // 兼容 manifest 只服务 skillsRoot，见 skillsDir.ts 注释），local-origin 项
  // 恒属于 Skills tab，不该出现在这里。market 装的取 registry 条目画 tile；
  const installedTiles = installed
    .filter((item) => item.kind === 'plugin')
    .map((item) => {
      const entry = byId.get(item.name);
      return { item, entry: entry ?? fallbackTileEntry(item.name) };
    });

  const row = (entry: MarketEntry) => (
    <EntryRow
      key={entry.id}
      entry={entry}
      onClick={() => onOpenDetail(entry.id)}
      right={
        <InstallButton
          id={entry.id}
          installed={installedNames.has(entry.id)}
          installing={installingIds.has(entry.id)}
          builtin={bundledIds.has(entry.id)}
          updateAvailable={installed.find((i) => i.name === entry.id)?.updateAvailable}
          onInstall={onInstall}
          onRequestUninstall={onRequestUninstall}
        />
      }
    />
  );

  return (
    <div>
      {!searching ? (
        <section className="mt-8">
          <div className="flex items-center">
            <h2 className="text-[15px] font-[650]">已安装</h2>
          </div>
          <div className="mt-3.5 flex min-h-8 flex-wrap gap-2.5">
            {installedTiles.length === 0 ? (
              <span className="self-center text-[12.5px] text-muted-foreground">
                还没有安装插件——从下面的列表挑一个试试
              </span>
            ) : (
              // 原型 .mini-tile 的 pop-in：装完一个插件、tile 落进这一排时
              // 弹一下（scale 0.4 → 1）。AnimatePresence 让移除也有退场，
              // 否则删一个会「啪」地消失、后面的 tile 瞬移补位。
              <AnimatePresence initial={false}>
                {installedTiles.map(({ item, entry }) => (
                  <motion.div
                    key={item.name}
                    layout={!reduce}
                    initial={reduce ? false : { scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={reduce ? { opacity: 0 } : { scale: 0.4, opacity: 0 }}
                    transition={tilePopIn}
                    role="button"
                    tabIndex={0}
                    title={item.origin === 'local' ? `${item.name}（本地）` : item.name}
                    className="cursor-pointer"
                    // hover 抬升交给 motion（whileHover），与 pop-in/layout 同一个
                    // transform 写手——用 CSS transition-transform 会和 motion 的
                    // transform 打架，入场动画播到一半 hover 就会跳。
                    whileHover={reduce ? undefined : { y: -2 }}
                    onClick={() => {
                      if (byId.has(item.name)) onOpenDetail(item.name);
                    }}
                  >
                    <EntryTile entry={entry} size={30} radius={8} />
                  </motion.div>
                ))}
              </AnimatePresence>
            )}
          </div>
        </section>
      ) : null}

      {sections.map((sec) => (
        <section key={sec.title} className="mt-9">
          {/* 原型 .section > h2：15px / 650 / padding-bottom 12 / 底边框 */}
          <h2 className="border-b border-border pb-3 text-[15px] font-[650]">{sec.title}</h2>
          {/* 原型 .plugin-grid：column-gap 28 / margin-top 6，单列断点是
            * **860px**（不是 Tailwind 的 md=768） */}
          <div className="mt-1.5 grid grid-cols-1 gap-x-7 min-[860px]:grid-cols-2">
            {sec.items.map(row)}
          </div>
        </section>
      ))}

      {sections.length === 0 ? (
        // 原型 .empty-state：margin-top 48 / padding 48 24 / radius 14 /
        // h3 14px-500 / p margin-top 6 + 12.5px
        <div className="mt-12 rounded-[14px] border border-dashed border-border px-6 py-12 text-center text-muted-foreground">
          <p className="text-sm font-medium text-foreground">
            {searching ? '没有找到相关插件' : '市场里还没有插件条目'}
          </p>
          <p className="mt-1.5 text-[12.5px]">{searching ? '换个关键词试试' : '等仓库发布后刷新'}</p>
        </div>
      ) : null}
    </div>
  );
}
