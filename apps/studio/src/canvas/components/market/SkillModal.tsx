import { useEffect, useState } from 'react';
import type { MarketEntry } from '@open-design/contracts';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/src/components/ui/dialog';
import { Button } from '@/src/components/ui/button';
import { Loader2, MessageCircle } from 'lucide-react';
import { EntryTile } from './tile';
import { InstallButton } from './InstallButton';
import { fetchEntryReadme } from './useMarket';

// 技能详情弹层（对齐原型的 skill modal）：图标 + 标题 + 描述 + README
// 面板 + 底部 安装/移除。README 走 daemon 代理拉条目的 README.md 正文
// （人类可读的市场说明，不是喂给 CLI 的 SKILL.md），v1 以等宽预格式文本
// 呈现（不引 markdown 渲染器）。

export function SkillModal({
  entry,
  installed,
  installing,
  builtin,
  onInstall,
  onRequestUninstall,
  onClose,
}: {
  entry: MarketEntry | null;
  installed: boolean;
  installing: boolean;
  builtin: boolean;
  onInstall: (id: string) => void;
  onRequestUninstall: (name: string) => void;
  onClose: () => void;
}) {
  const [readme, setReadme] = useState<string | null>(null);
  const [readmeLoading, setReadmeLoading] = useState(false);

  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    setReadme(null);
    setReadmeLoading(true);
    void fetchEntryReadme(entry.id).then((content) => {
      if (cancelled) return;
      setReadme(content);
      setReadmeLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  return (
    <Dialog open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      {/* 原型 .skill-modal：620 宽 / max-height 84vh / radius 18 /
        * padding 22 28 24。gap-0 关掉 shadcn DialogContent 的默认纵向 gap
        * ——原型各块自带 margin-top，两套间距叠加会把弹层撑散。 */}
      <DialogContent className="max-h-[84vh] max-w-[620px] gap-0 overflow-y-auto rounded-[18px] px-7 pb-6 pt-[22px]">
        {entry ? (
          <>
            <DialogHeader className="items-start gap-0 space-y-0 text-left">
              {/* 原型 .sm-icon 是 54px 圆形中性占位（那时技能还没有真实图标）。
                * 现在条目自带 composerIcon，故保留 EntryTile 显示真图，只对齐
                * 尺寸/圆形——有真图就显示真图，比中性占位更诚实。 */}
              <EntryTile entry={entry} size={54} radius={27} />
              {/* 原型 .sm-title：margin-top 14 / 20px / 650；.kind 16px/400 */}
              <DialogTitle className="mt-3.5 text-xl font-[650]">
                {entry.displayName}
                <span className="pl-2 text-base font-normal text-muted-foreground">Skill</span>
              </DialogTitle>
              {/* 原型 .sm-desc：margin-top 12 / 13px / line-height 1.75 */}
              <DialogDescription className="mt-3 text-left text-[13px] leading-[1.75]">
                {entry.description}
              </DialogDescription>
            </DialogHeader>
            {/* 原型 .sm-readme：margin-top 18 / --muted 底 / radius 12 /
              * padding 16 18 / 12.5px / line-height 1.8 */}
            <div className="mt-[18px] rounded-xl bg-muted px-[18px] py-4">
              {readmeLoading ? (
                <div className="flex items-center gap-2 py-4 text-[12.5px] text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> 加载说明…
                </div>
              ) : readme ? (
                <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12.5px] leading-[1.8] text-foreground/90">
                  {readme}
                </pre>
              ) : (
                <p className="py-2 text-[12.5px] text-muted-foreground">说明暂时拉取不到，稍后再试。</p>
              )}
            </div>
            {/* 原型 .sm-footer：margin-top 22 */}
            <div className="mt-[22px] flex items-center">
              {installed ? (
                <Button
                  size="sm"
                  variant="ghost"
                  // 原型 .btn-uninstall：height 30 / padding 0 14 / --destructive-tint(8%)
                  className="h-[30px] rounded-full bg-destructive/[0.08] px-3.5 text-[12.5px] font-medium text-destructive hover:brightness-95 hover:text-destructive"
                  onClick={() => onRequestUninstall(entry.id)}
                >
                  移除
                </Button>
              ) : null}
              <div className="ml-auto flex items-center gap-2">
                {installed ? (
                  <Button
                    size="sm"
                    // 原型 .btn-try：height 30 / padding 0 14 / brand-tint(10%) → hover 16%
                    className="h-[30px] rounded-full bg-[hsl(var(--brand)/0.1)] px-3.5 text-[12.5px] font-medium text-[hsl(var(--brand))] hover:bg-[hsl(var(--brand)/0.16)]"
                    variant="ghost"
                    onClick={onClose}
                  >
                    <MessageCircle className="size-3.5" /> 新会话中试用
                  </Button>
                ) : (
                  <InstallButton
                    id={entry.id}
                    installed={installed}
                    installing={installing}
                    builtin={builtin}
                    onInstall={onInstall}
                    onRequestUninstall={onRequestUninstall}
                  />
                )}
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
