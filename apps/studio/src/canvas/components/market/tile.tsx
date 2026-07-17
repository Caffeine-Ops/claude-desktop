import { useState } from 'react';
import type { MarketEntry } from '@open-design/contracts';

// 图标渲染：有 composerIcon（daemon 已改写成走代理的绝对 URL，见
// routes.ts 的 rewriteEntryAssetPaths）就显示真实图片；没有图标、或图片
// 加载失败（比如条目还没发布图标），退回 brandColor 底色 + 名称首字母的
// 占位块——诚实的「这里本该有图」信号，不是伪造的完成态。
// 色板：brandColor 缺失时按 id 哈希稳定取色，与原型 docs/ui-prototype-plugins.html
// 的色板量级一致。

const FALLBACK_COLORS = [
  '#3b78e7', '#de5246', '#1e9e5a', '#d99114', '#7b5bd6',
  '#d64f8e', '#0e9488', '#e06a2b', '#2b2b30', '#5c6472',
];

function hashColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length]!;
}

function initialsFor(entry: Pick<MarketEntry, 'id' | 'name' | 'displayName'>): string {
  const source = entry.displayName || entry.name;
  const initials = source
    .split(/[\s-]+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
  return initials || entry.id.slice(0, 2).toUpperCase();
}

type TileEntry = Pick<MarketEntry, 'id' | 'name' | 'displayName' | 'composerIcon' | 'brandColor'>;

export function EntryTile({
  entry,
  size = 38,
  radius = 9,
}: {
  entry: TileEntry;
  size?: number;
  radius?: number;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const color = entry.brandColor ?? hashColor(entry.id);
  const showImage = !!entry.composerIcon && !imgFailed;

  if (showImage) {
    return (
      <img
        src={entry.composerIcon}
        alt=""
        aria-hidden
        width={size}
        height={size}
        className="shrink-0 object-cover"
        style={{ width: size, height: size, borderRadius: radius, backgroundColor: color }}
        onError={() => setImgFailed(true)}
      />
    );
  }
  return (
    <div
      aria-hidden
      // font-[650] = 原型的 --fw-strong（真实 tokens.css 的
      // --font-weight-strong 同值，只是没映射成 Tailwind utility）。
      className="flex shrink-0 items-center justify-center font-[650] text-white"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: color,
        // 原型 .tile(38px)=14px、.mini-tile(30px)=11px，0.36 比例两档都对得上
        fontSize: Math.max(10, Math.round(size * 0.36)),
        letterSpacing: '-0.02em',
      }}
    >
      {initialsFor(entry)}
    </div>
  );
}
