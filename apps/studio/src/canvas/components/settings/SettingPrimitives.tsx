/*
 * 设置页版式原语（2026-09-02，P2 视觉统一）
 * ============================================================
 * 为什么要有这三个组件
 * ------------------------------------------------------------
 * 在此之前，`rounded-xl border border-border bg-card` 这串类名在 7 个文件里
 * 重复了十多处，且每处的内边距各写各的（p-4 / p-5 / px-4 / py-2.5 …）。后果
 * 有两个：一是同一页里卡片的内边距和圆角对不齐；二是想统一调整版式时必须逐个
 * 文件改，漏一个就留下一张"长得不一样"的卡。
 *
 * 更重要的是版式本身的改动：**从「一项一张卡」改为「一组一张卡 + 内部发丝线
 * 分隔」**。旧写法下一屏七八张独立卡片各自浮着，每张都带一圈边框，边框数量
 * 等于设置项数量，视觉噪音很重；组卡把边框降到"每组一圈"，靠 1px 发丝线分隔
 * 组内各行——这是 macOS 系统设置与 Linear 的做法，同样内容纵向更短、更整齐。
 *
 * 这个模式在本仓库并非首创：AppearanceSection 的字号卡（界面字号/代码字号/
 * 手型光标三行共一张卡，divide-y 分隔）早就是这么写的。P2 做的是**把这个已经
 * 存在的好模式抽出来推广**，而不是引入一套新审美。
 *
 * 精细化（2026-09-04，样稿 docs/ui-prototype-settings-v4.html 定稿后落地）
 * ------------------------------------------------------------
 * 在组卡之上再加一层「行级细节」：行 hover 浅底、行首图标位（`icon`）、右侧
 * 灰字当前值（`value`，数值可 `mono`）、跳转行的 chevron（`onClick`）、组底部
 * 脚注（SettingGroup 的 `footnote`）、卡片一级极淡阴影。这些都是可选 prop，
 * 不传就是原来的样子——老调用方零改动。
 * 另抽出 SettingSwitchRow：此前 Privacy/Critique/Appearance/Notifications 四处
 * 各自手抄「SettingRow + Switch + useId + labelFor」，其中通知页两处漏了 labelFor
 * 导致点标题切不动开关（评审发现）。统一到一个组件，整行可点是默认行为。
 *
 * 纪律
 * ------------------------------------------------------------
 * - 全部走 Tailwind utility + shadcn 原语，不碰 legacy 的 .settings-* / .sv2-*
 *   类（canvas CSS 未分层，同名属性会压过 utility，见 CLAUDE.md 迁移纪律）。
 * - 只管版式，不含任何业务状态：控件由调用方以 children 传入，这样每个 section
 *   的 handler / 埋点 / 条件渲染都原样保留，迁移是纯视觉重构。
 */

import { useId, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

import { Switch } from '@/src/components/ui/switch';
import { cn } from '@/src/lib/utils';

/**
 * 分组：一个可选的小标题 + 一张卡。
 * 标题用 11.5px/600 + 字距，与 SettingsDialogV2 侧栏的分组标题同一套排版，
 * 让左右两栏的层级语言一致。
 */
export function SettingGroup({
  label,
  footnote,
  children,
  className,
}: {
  label?: string;
  /** 组底部一行小字：放「这组设置的适用范围 / 数据来源」这类不属于任何一行的说明。 */
  footnote?: ReactNode;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('mb-8 last:mb-0', className)}>
      {label ? (
        <div className="mb-2 pl-0.5 text-[11.5px] font-semibold tracking-[0.04em] text-muted-foreground">
          {label}
        </div>
      ) : null}
      {children}
      {footnote ? (
        <p className="mx-0.5 mb-0 mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          {footnote}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 组卡：一组设置共用的一张卡，内部各行由 divide-y 自动分隔。
 * 内边距刻意留在 SettingRow 上而不是卡上——分隔线必须横贯整张卡（从左边框到
 * 右边框），若把 px 提到卡上，divide-y 画出的线会内缩一段，看起来像断了。
 */
export function SettingCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-card',
        // 一级极淡阴影：只为把卡从白底上「托」起一点，不做悬浮感。深色下换成
        // 纯黑低透明度——灰调阴影在深色底上会发白。
        'shadow-[0_1px_2px_hsl(240_6%_10%/0.04),0_0_0_0.5px_hsl(240_6%_10%/0.02)] dark:shadow-[0_1px_2px_hsl(0_0%_0%/0.3)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * 设置行：左边「标题 + 说明」，右边控件。
 *
 * `stack` 用于控件本身很宽的场合（音效选择器、输入框、色板…）：此时左右并排
 * 会把标题挤成两行，改为标题在上、控件独占一行。
 *
 * 说明文字放在**标题正下方**而不是整行下方——它解释的是这一项设置，跟在标题
 * 后面读起来才连贯；旧写法把 hint 放在开关底下横跨整行，视线要从右边的开关
 * 折返回左边才能读到。
 */
export function SettingRow({
  title,
  hint,
  icon,
  value,
  mono = false,
  onClick,
  danger = false,
  size = 'default',
  stack = false,
  labelFor,
  children,
  className,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  /** 行首图标（传 lucide 组件实例，如 `<Volume2 />`），渲染在 28px 的浅底方块里。 */
  icon?: ReactNode;
  /** 右侧灰字当前值（余额、版本号、当前选项名…），在 children 控件之前。 */
  value?: ReactNode;
  /** value 用等宽字：版本号、金额、ID 这类要对齐或逐字读的值。 */
  mono?: boolean;
  /**
   * 传了就是「跳转行」：整行变 button、右侧画 chevron、hover 浅底。
   * 不传时行是纯展示容器（hover 仍有极浅底色反馈，保持整张卡的手感一致）。
   */
  onClick?: () => void;
  /** 破坏性动作行（退出登录、清除数据）：标题与图标走 destructive 色。 */
  danger?: boolean;
  /** hero = 内边距大一档，给头像行 / 应用版本行这类「一张卡里的主角」用。 */
  size?: 'default' | 'hero';
  stack?: boolean;
  /**
   * 传入右侧控件的 id，标题块就渲染成 <label htmlFor>，于是**点这一行的文字
   * 也能切换控件**。开关类的行应该都带上：开关本体只有 40×24px，而"点标题
   * 也能切"是用户在系统设置里养成的肌肉记忆，命中面积能大一个数量级。
   * （PrivacySection 的局部 ToggleRow 原先就是这么做的，抽上来供所有行复用。）
   */
  labelFor?: string;
  children?: ReactNode;
  className?: string;
}): React.JSX.Element {
  const textBlock = (
    <>
      {title ? (
        <div className={cn('text-[13px] font-medium', danger ? 'text-destructive' : 'text-foreground')}>
          {title}
        </div>
      ) : null}
      {hint ? <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
    </>
  );

  const lead = icon ? (
    <div
      aria-hidden="true"
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-[7px] [&>svg]:size-[15px]',
        danger ? 'bg-destructive/10 text-destructive' : 'bg-secondary text-muted-foreground',
      )}
    >
      {icon}
    </div>
  ) : null;

  const end =
    value !== undefined || children || onClick ? (
      <div className={cn(stack ? 'min-w-0' : 'flex shrink-0 items-center gap-2.5')}>
        {value !== undefined ? (
          <span
            className={cn(
              'text-[13px] tabular-nums',
              mono ? 'font-mono text-[12.5px] text-foreground' : 'text-muted-foreground',
            )}
          >
            {value}
          </span>
        ) : null}
        {children}
        {onClick ? (
          <ChevronRight aria-hidden="true" className="size-[15px] text-muted-foreground" />
        ) : null}
      </div>
    ) : null;

  const rowCls = cn(
    'w-full text-left transition-colors hover:bg-muted/50',
    size === 'hero' ? 'px-4 py-[18px]' : 'px-4 py-3.5',
    stack ? 'flex flex-col gap-2.5' : 'flex items-center gap-3.5',
    onClick && 'cursor-pointer',
    className,
  );

  /* stack 布局下图标跟标题同一行（图标 + 标题在上、宽控件在下），
     并排布局下图标是第一列。 */
  const head =
    title || hint ? (
      labelFor ? (
        <label htmlFor={labelFor} className="min-w-0 flex-1 cursor-pointer">
          {textBlock}
        </label>
      ) : (
        <div className="min-w-0 flex-1">{textBlock}</div>
      )
    ) : null;

  const body = stack ? (
    <>
      {head || lead ? (
        <div className="flex items-center gap-3.5">
          {lead}
          {head}
          {onClick ? end : null}
        </div>
      ) : null}
      {onClick ? null : end}
    </>
  ) : (
    <>
      {lead}
      {head}
      {end}
    </>
  );

  if (onClick) {
    // data-slot：本目录在 chat 链 @source 内，但 canvas 的裸 button reset
    // 只豁免 [data-slot] 与 .chat-app 子树，裸 <button> 会被填成描边卡片。
    return (
      <button type="button" data-slot="setting-row" onClick={onClick} className={rowCls}>
        {body}
      </button>
    );
  }
  return <div className={rowCls}>{body}</div>;
}

/**
 * 开关行：标题 + 说明 + shadcn Switch，整行文字可点（labelFor 自动接线）。
 * `tint` = 开启后整行带一层浅底，作为「已开启」的额外视觉提示（PrivacySection
 * 原有行为，抽上来时保留为可选项，其它页默认不开——一页全是开关时整片发灰）。
 */
export function SettingSwitchRow({
  title,
  hint,
  icon,
  checked,
  onCheckedChange,
  disabled = false,
  tint = false,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  tint?: boolean;
  className?: string;
}): React.JSX.Element {
  const id = useId();
  return (
    <SettingRow
      title={title}
      hint={hint}
      icon={icon}
      labelFor={id}
      className={cn(tint && checked && 'bg-muted/40', className)}
    >
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </SettingRow>
  );
}
