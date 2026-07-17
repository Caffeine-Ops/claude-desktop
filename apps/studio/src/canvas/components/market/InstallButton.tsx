import { Check, Loader2 } from 'lucide-react';
import { Badge } from '@/src/components/ui/badge';
import { Button } from '@/src/components/ui/button';

// 安装按钮三态（安装 → 安装中 → 已安装 hover 变移除），对齐原型
// docs/ui-prototype-plugins.html 的 .btn-install。已安装态的「移除」只发
// 请求意向（onRequestUninstall），确认弹层由 MarketView 统一持有。

export function InstallButton({
  id,
  installed,
  installing,
  builtin,
  updateAvailable,
  onInstall,
  onRequestUninstall,
}: {
  id: string;
  installed: boolean;
  installing: boolean;
  builtin?: boolean;
  updateAvailable?: boolean;
  onInstall: (id: string) => void;
  onRequestUninstall: (name: string) => void;
}) {
  if (builtin && !installed) {
    return (
      <Badge variant="secondary" className="shrink-0 text-muted-foreground">
        内置
      </Badge>
    );
  }
  if (installing) {
    return (
      <Button size="sm" variant="secondary" disabled className="h-7 min-w-[58px] shrink-0 rounded-full px-3.5 text-[12.5px]">
        <Loader2 className="size-3 animate-spin" /> 安装中
      </Button>
    );
  }
  if (installed && updateAvailable) {
    return (
      <Button
        size="sm"
        variant="secondary"
        className="h-7 min-w-[58px] shrink-0 rounded-full px-3.5 text-[12.5px]"
        onClick={(e) => {
          e.stopPropagation();
          onInstall(id);
        }}
      >
        更新
      </Button>
    );
  }
  if (installed) {
    return (
      <Button
        size="sm"
        variant="ghost"
        // 原型 .btn-install.installed：透明底 + brand 字；hover 变移除
        // （--destructive-tint = destructive 的 8%，不是 10%）
        className="group/ib h-7 min-w-[58px] shrink-0 rounded-full px-3.5 text-[12.5px] text-[hsl(var(--brand))] hover:bg-destructive/[0.08] hover:text-destructive"
        onClick={(e) => {
          e.stopPropagation();
          onRequestUninstall(id);
        }}
      >
        <Check className="size-3 group-hover/ib:hidden" />
        <span className="group-hover/ib:hidden">已安装</span>
        <span className="hidden group-hover/ib:inline">移除</span>
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="secondary"
      className="h-7 min-w-[58px] shrink-0 rounded-full px-3.5 text-[12.5px]"
      onClick={(e) => {
        e.stopPropagation();
        onInstall(id);
      }}
    >
      安装
    </Button>
  );
}
