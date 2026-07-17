import type { ReactNode } from 'react';
import type { MarketEntry } from '@open-design/contracts';
import { EntryTile } from './tile';

// 市场列表行（插件/技能两个 tab 共用）：图标 + 名称 + 单行描述 + 右侧
// 动作区。裸 div 而非 <button>——canvas 面的裸元素 reset 只打 button/input
// 等交互元素，div 行不受影响，且行内还有真按钮（InstallButton）不能嵌套。

type RowEntry = Pick<
  MarketEntry,
  'id' | 'name' | 'displayName' | 'composerIcon' | 'brandColor' | 'description'
>;

export function EntryRow({
  entry,
  sub,
  right,
  onClick,
}: {
  entry: RowEntry;
  sub?: string;
  right?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
      // 原型 .plugin-row：gap 12 / padding 10 10 / margin 2 -10 / radius 10。
      // active 底色原型写的是 --secondary-hover，那个 token **真实 tokens.css
      // 里没有**（原型自带的，它声称 1:1 取自 tokens 但有出入）——退到真实存在
      // 的 --secondary，语义（比 hover 更深一档）一致。
      className={`-mx-2.5 my-0.5 flex items-center gap-3 rounded-[10px] px-2.5 py-2.5 transition-colors ${
        onClick ? 'cursor-pointer hover:bg-hover active:bg-secondary' : ''
      }`}
    >
      <EntryTile entry={entry} />
      <div className="min-w-0 flex-1">
        {/* 原型 .plugin-name 13.5px/500、.plugin-desc 12.5px + margin-top 2 */}
        <div className="truncate text-[13.5px] font-medium">
          {entry.displayName}
          {entry.name !== entry.displayName ? (
            <span className="pl-1.5 text-[12.5px] font-normal text-muted-foreground">
              {entry.name}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
          {sub ?? entry.description}
        </div>
      </div>
      {right}
    </div>
  );
}

/** 搜索过滤：命中 名称/展示名/描述/关键词 任一即保留 */
export function matchesQuery(
  entry: Pick<MarketEntry, 'name' | 'displayName' | 'description' | 'id' | 'keywords'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [entry.id, entry.name, entry.displayName, entry.description, ...entry.keywords]
    .join('\n')
    .toLowerCase()
    .includes(q);
}
