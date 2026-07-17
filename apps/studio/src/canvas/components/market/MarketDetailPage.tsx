import { useState } from 'react';
import { ArrowRight, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';
import { marketRemoteDirFor } from '@open-design/contracts';
import { Badge } from '@/src/components/ui/badge';
import { Button } from '@/src/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/src/components/ui/alert-dialog';
import { EntryTile } from './tile';
import { InstallButton } from './InstallButton';
import { useMarket } from './useMarket';

// 插件详情页（对齐原型的 detail page）：面包屑 + 图标标题 + 示例 prompt
// 横幅（品牌绿系深色渐变，两主题档一致）+ 长文介绍 + 技能清单 + 信息 kv。
// 「立即试用」v1 = 复制示例 prompt 到剪贴板。
//
// 「技能」区不再假设一个条目只打包一个技能——从 files[] 里挑出所有
// `skills/<subid>/SKILL.md` 路径，逐个列出，对应 fusion-code 里实际会
// 分别暴露成 `cowork:<subid>` 的每一个技能。
//
// 宿主中立：返回列表靠 onBack 注入，本组件不碰 canvas router（理由见
// MarketView 头注释）。

const SUBSKILL_RE = /^skills\/([^/]+)\/SKILL\.md$/;

function subskillIds(files: { path: string }[]): string[] {
  const ids = files.map((f) => f.path.match(SUBSKILL_RE)?.[1]).filter((x): x is string => !!x);
  return [...new Set(ids)].sort();
}

export function MarketDetailPage({
  entryId,
  onBack,
}: {
  entryId: string;
  onBack: () => void;
}) {
  const market = useMarket();
  const [pendingUninstall, setPendingUninstall] = useState<string | null>(null);
  const entry = market.registry?.entries.find((e) => e.id === entryId) ?? null;
  const installedItem = market.installed.find((i) => i.name === entryId);
  const installed = installedItem !== undefined;

  const copyPrompt = (text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => market.notify('已复制，去对话里粘贴即可试用'))
      .catch(() => market.notify('复制失败'));
  };

  return (
    <div className="relative h-full">
      {/* 顶栏：列表页放 tab 段，详情页放面包屑——同一条栏、同一位置、同一套
        * 浮起+磨砂/拖拽规则（理由见 MarketView 的顶栏注释：容器不声明
        * app-region 好让 strip 的拖拽穿透，只有交互元素挖 no-drag 洞）。 */}
      <div className="absolute inset-x-0 top-0 z-30 flex h-[46px] items-center gap-2 bg-card/70 px-3.5 backdrop-blur-xl">
        {/* 原型 .crumb：12.5px / gap 8；button 4px 6px + radius 6；
          * sep 透明度 0.55；cur 500 */}
        <nav className="flex items-center gap-2 text-[12.5px] [-webkit-app-region:no-drag]">
          <Button
            variant="ghost"
            size="sm"
            className="h-auto rounded-md px-1.5 py-1 text-[12.5px] font-normal text-muted-foreground hover:bg-hover hover:text-foreground"
            onClick={onBack}
          >
            插件市场
          </Button>
          <ChevronRight className="size-3 text-muted-foreground opacity-[0.55]" />
          <span className="font-medium">{entry?.displayName ?? entryId}</span>
        </nav>
      </div>

      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-[880px] px-10 pb-20 pt-[74px]">
        {market.loading && !market.registry ? (
          <div className="flex items-center gap-2 pt-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 加载中…
          </div>
        ) : !entry ? (
          <div className="mt-16 rounded-2xl border border-dashed border-border p-12 text-center text-muted-foreground">
            <p className="text-sm font-medium text-foreground">没有找到这个条目</p>
            <p className="mt-1.5 text-xs">它可能已从市场下架</p>
          </div>
        ) : (
          <>
            {/* 原型 .detail-icon-wrap margin-top 10 / .detail-icon 56-13 */}
            <div className="mt-2.5">
              <EntryTile entry={entry} size={56} radius={13} />
            </div>
            {/* 原型 .detail-title-row margin-top 16 / gap 12；h1 24px-650 */}
            <div className="mt-4 flex items-start gap-3">
              <div className="min-w-0">
                <h1 className="text-2xl font-[650] tracking-[-0.02em]">{entry.displayName}</h1>
                <p className="mt-[5px] text-[13px] text-muted-foreground">{entry.description}</p>
                {entry.capabilities.length > 0 ? (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {entry.capabilities.map((cap) => (
                      <Badge key={cap} variant="secondary" className="font-normal text-muted-foreground">
                        {cap}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2 pt-1">
                <InstallButton
                  id={entry.id}
                  installed={installed}
                  installing={market.installingIds.has(entry.id)}
                  builtin={market.bundledIds.has(entry.id)}
                  updateAvailable={installedItem?.updateAvailable}
                  onInstall={market.install}
                  onRequestUninstall={setPendingUninstall}
                />
              </div>
            </div>

            {entry.defaultPrompt.length > 0 ? (
              <div
                // 原型 .detail-banner：margin-top 24 / radius 16 / padding 30 28 / gap 12
                className="mt-6 flex flex-col items-center gap-3 rounded-2xl px-7 py-[30px]"
                style={{
                  background:
                    'radial-gradient(120% 160% at 15% 0%, hsl(150 45% 30% / 0.85) 0%, transparent 55%),' +
                    'radial-gradient(120% 160% at 90% 100%, hsl(200 45% 26% / 0.8) 0%, transparent 60%),' +
                    'hsl(165 35% 16%)',
                }}
              >
                {entry.defaultPrompt.slice(0, 3).map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    data-slot="market-prompt-pill"
                    onClick={() => copyPrompt(prompt)}
                    // 原型 .prompt-pill：radius 14 / padding 9 9 9 14 / 12.5px
                    className="flex max-w-full items-center gap-2.5 rounded-[14px] border border-white/15 bg-white/10 py-[9px] pl-3.5 pr-[9px] text-left text-[12.5px] text-white/90 transition-colors hover:bg-white/[0.17]"
                  >
                    <span className="flex shrink-0 items-center gap-1.5 font-semibold">
                      <EntryTile entry={entry} size={18} radius={5} />
                      {entry.displayName}
                    </span>
                    <span className="min-w-0 truncate">{prompt}</span>
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/10">
                      <ArrowRight className="size-3" />
                    </span>
                  </button>
                ))}
              </div>
            ) : null}

            {/* 原型 .detail-about：margin-top 26 / 13.5px / line-height 1.75 */}
            <p className="mt-[26px] text-[13.5px] leading-[1.75]">
              {entry.longDescription ??
                `${entry.description}。安装后在新会话里通过 / 触发 cowork:${entry.id} 使用。`}
            </p>

            {(() => {
              const subIds = subskillIds(entry.files);
              return (
                <>
                  {/* 原型 .d-sec：margin-top 34 / 15px-650 / padding-bottom 10 */}
                  <h2 className="mt-[34px] border-b border-border pb-2.5 text-[15px] font-[650]">
                    技能<span className="pl-1.5 text-[13px] font-normal text-muted-foreground">{subIds.length}</span>
                  </h2>
                  {subIds.map((subId) => (
                    <div key={subId} className="flex items-center gap-3 py-3.5">
                      <EntryTile entry={entry} size={34} radius={8} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium">cowork:{subId}</div>
                        <div className="truncate text-xs text-muted-foreground">{entry.description}</div>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {installed ? '新会话生效' : '安装后可用'}
                      </span>
                    </div>
                  ))}
                </>
              );
            })()}

            <h2 className="mt-[34px] border-b border-border pb-2.5 text-[15px] font-[650]">信息</h2>
            {/* 原型 .d-info：行 padding 9 0 / 12.5px，dt 宽 130 */}
            <dl className="text-[12.5px]">
              {(
                [
                  [
                    '类别',
                    entry.category
                      ? (market.registry?.categories.find((c) => c.id === entry.category)?.title ?? entry.category)
                      : '—',
                  ],
                  ['版本', entry.version],
                  ['大小', `${Math.max(1, Math.ceil(entry.totalSize / 1024))} KB · ${entry.files.length} 个文件`],
                  ['开发者', entry.developerName ?? entry.author?.name ?? '—'],
                  ['许可', entry.license ?? '—'],
                  ['安装位置', `~/.cowork/${marketRemoteDirFor(entry.kind)}/${entry.id}`],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="flex items-center border-b border-border/60 py-[9px]">
                  <dt className="w-[130px] shrink-0 text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 truncate">{v}</dd>
                </div>
              ))}
              {(
                [
                  ['网站', entry.websiteURL ?? entry.homepage],
                  ['隐私政策', entry.privacyPolicyURL],
                  ['服务条款', entry.termsOfServiceURL],
                  ['源码', entry.repository],
                ] as const
              )
                .filter(([, url]) => !!url)
                .map(([k, url]) => (
                  <div key={k} className="flex items-center border-b border-border/60 py-[9px]">
                    <dt className="w-[130px] shrink-0 text-muted-foreground">{k}</dt>
                    <dd className="min-w-0 truncate">
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        data-slot="market-external-link"
                        className="inline-flex items-center gap-1 text-foreground hover:text-[hsl(var(--brand))]"
                      >
                        {url}
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                    </dd>
                  </div>
                ))}
            </dl>
          </>
        )}
        </div>
      </div>

      {market.notice ? (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-xs text-background shadow-lg">
          {market.notice}
        </div>
      ) : null}

      <AlertDialog open={pendingUninstall !== null} onOpenChange={(o) => !o && setPendingUninstall(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移除「{pendingUninstall}」？</AlertDialogTitle>
            <AlertDialogDescription>
              移除后新会话不再加载它；进行中的会话不受影响。之后可以随时重新安装。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingUninstall) void market.uninstall(pendingUninstall);
                setPendingUninstall(null);
              }}
            >
              移除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
