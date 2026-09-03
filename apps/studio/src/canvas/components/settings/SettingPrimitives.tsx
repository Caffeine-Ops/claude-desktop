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
 * 纪律
 * ------------------------------------------------------------
 * - 全部走 Tailwind utility + shadcn 原语，不碰 legacy 的 .settings-* / .sv2-*
 *   类（canvas CSS 未分层，同名属性会压过 utility，见 CLAUDE.md 迁移纪律）。
 * - 只管版式，不含任何业务状态：控件由调用方以 children 传入，这样每个 section
 *   的 handler / 埋点 / 条件渲染都原样保留，迁移是纯视觉重构。
 */

import type { ReactNode } from 'react';

import { cn } from '@/src/lib/utils';

/**
 * 分组：一个可选的小标题 + 一张卡。
 * 标题用 11.5px/600 + 字距，与 SettingsDialogV2 侧栏的分组标题同一套排版，
 * 让左右两栏的层级语言一致。
 */
export function SettingGroup({
  label,
  children,
  className,
}: {
  label?: string;
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
  stack = false,
  labelFor,
  children,
  className,
}: {
  title?: ReactNode;
  hint?: ReactNode;
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
      {title ? <div className="text-[13px] font-medium text-foreground">{title}</div> : null}
      {hint ? <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
    </>
  );

  return (
    <div
      className={cn(
        'px-4 py-3.5 transition-colors',
        stack ? 'flex flex-col gap-2.5' : 'flex items-center justify-between gap-4',
        className,
      )}
    >
      {title || hint ? (
        labelFor ? (
          <label htmlFor={labelFor} className="min-w-0 flex-1 cursor-pointer">
            {textBlock}
          </label>
        ) : (
          <div className="min-w-0 flex-1">{textBlock}</div>
        )
      ) : null}
      {children ? (
        <div className={cn(stack ? 'min-w-0' : 'flex shrink-0 items-center gap-2')}>{children}</div>
      ) : null}
    </div>
  );
}
