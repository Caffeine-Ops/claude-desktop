'use client'

/**
 * 全屏登录页（AuthGate 的 signedOut 面）——「HUD 分屏」科技感版。
 *
 * 视觉是 docs/ui-prototype-login-v2.html HUD 分屏布局的落地（2026-07-06
 * 用户从极光玻璃改选 HUD 分屏）：左 44% 品牌面（发光 C 核 + 双轨道环反向
 * 慢转 + slogan + mono 状态行），右侧表单面；画布铺品牌绿光晕呼吸 + 细
 * 网格。与原型的刻意差异：输入框不用浮动 label，用标准 shadcn「Label
 * 一行 + Input」形态（2026-07-06 用户要求）。
 *
 * 主题（2026-07-06 用户要求跟系统/应用一致，替换掉此前「固定深色」的
 * 决策）：颜色全走 login.css 的 --lg-* 变量（亮档 .login-screen / 暗档
 * .dark .login-screen），html 的 .dark 由 chat 的 appearance.applier 维护
 * （themeMode=system 时跟随 OS 的 prefers-color-scheme），登录页因此自动
 * 与应用主题同步。右上角的主题切换按钮直接写 useAppearanceStore（rail 与
 * chat 同 webContents 共享 zustand，同 RailSessionList 的先例）——applier
 * 挂在常驻的 chat 树里（SurfaceHost keep-alive，登录墙只是 overlay 不阻止
 * 挂载），所以墙内切主题走的是与设置页完全相同的链路（持久化 + 双标记 +
 * 跨面广播）。
 *
 * 本组件在 .chat-app 之外，canvas 的裸元素 reset 会命中裸 <button>/<input>
 * ——交互元素一律 shadcn 原语（自带 data-slot 豁免），根层铁律同 AppRail。
 *
 * 顶部 48px 是窗口拖拽条（absolute 盖在两面之上）：登录墙盖满全窗后，
 * chat header / rail 顶栏的 drag 区都在墙后面摸不到，不补这条的话登录页
 * 期间整个窗口拖不动。主题切换按钮 fixed 在这条 drag 区里，必须标
 * no-drag 才点得动（同 rail 顶栏按钮的坑）。
 */

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Loader2, Monitor, Moon, Sun } from 'lucide-react'

import type { AuthState } from '@desktop-shared/ipc-channels'
import { Button } from '@/src/components/ui/button'
import { Input } from '@/src/components/ui/input'
import { Label } from '@/src/components/ui/label'
import { cn } from '@/src/lib/utils'
import { useAppearanceStore, type ThemeMode } from '@/src/chat/stores/appearance'
// login-* 背景/动效类与 --lg-* 主题变量（亮/暗双档）。组件级全局 CSS——
// 刻意不进 globals.css，与 chat/canvas 样式链解耦，登录墙样式自包含。
import './login.css'

/* 入场 stagger 的公共 animation（login.css 的 login-rise），元素各自叠
 * [animation-delay:*]。缓动与原型一致。 */
const RISE = 'animate-[login-rise_.6s_cubic-bezier(0.32,0.72,0,1)_both]'

/* 微粒错落参数（left% / 时长s / 延迟s / 尺寸px）——照抄原型的 5 颗。 */
const MOTES: Array<[number, number, number, number]> = [
  [18, 16, 0, 3],
  [36, 21, 4, 2],
  [58, 14, 8, 3],
  [74, 24, 2, 2],
  [88, 18, 11, 3]
]

/* 主题三态循环与图标/文案。顺序与设置页外观档位语义一致。 */
const THEME_CYCLE: ThemeMode[] = ['light', 'dark', 'system']
const THEME_META: Record<ThemeMode, { Icon: typeof Sun; label: string }> = {
  light: { Icon: Sun, label: '浅色' },
  dark: { Icon: Moon, label: '深色' },
  system: { Icon: Monitor, label: '跟随系统' }
}

/**
 * 右上角主题切换：点击在 浅色 → 深色 → 跟随系统 间循环。
 * mounted 守卫：themeMode 来自 zustand persist（localStorage），客户端
 * rehydrate 后的值可能与 SSR 初值 'system' 不同——mount 前不渲染，避免
 * hydration mismatch（同类坑见 useState 初始化器禁分支 window 的教训）。
 */
function ThemeToggle() {
  const mode = useAppearanceStore((s) => s.themeMode)
  const setThemeMode = useAppearanceStore((s) => s.setThemeMode)
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  if (!mounted) return null

  const { Icon, label } = THEME_META[mode]
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(mode) + 1) % THEME_CYCLE.length]
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`主题：${label}，点击切换到${THEME_META[next].label}`}
      title={`主题：${label}`}
      onClick={() => setThemeMode(next)}
      className="fixed right-4 top-2.5 z-20 text-[color:var(--lg-ink-2)] [-webkit-app-region:no-drag] hover:text-[color:var(--lg-ink)]"
    >
      <Icon className="size-4" />
    </Button>
  )
}

/**
 * 标准 shadcn 表单字段：Label 独立一行 + Input（2026-07-06 用户要求，
 * 替换掉此前覆盖过重的浮动 label 方案）。对 shadcn 默认样式的覆盖收敛
 * 到只动配色（--lg-* 变量，亮暗自动切），结构、高度语义、placeholder
 * 行为全是 shadcn 原生。
 */
function FormField({
  id,
  label,
  type,
  autoComplete,
  autoFocus,
  placeholder,
  value,
  disabled,
  invalid,
  onChange
}: {
  id: string
  label: string
  type: string
  autoComplete: string
  autoFocus?: boolean
  placeholder: string
  value: string
  disabled: boolean
  invalid?: boolean
  onChange: (v: string) => void
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-[13px] font-medium text-[color:var(--lg-ink-2)]">
        {label}
      </Label>
      <Input
        id={id}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          // 只覆盖配色（--lg-* 变量分档）；bg 双写 dark: 变体压过 shadcn
          // 默认的 dark:bg-input/30（html 带 .dark 时其特异性更高，会反杀
          // 无前缀的 arbitrary 类）。
          'h-11 rounded-lg border-[color:var(--lg-line)]',
          'bg-[color:var(--lg-input-bg)] dark:bg-[color:var(--lg-input-bg)]',
          'text-[15px] text-[color:var(--lg-ink)] caret-[color:var(--lg-green)]',
          'placeholder:text-[color:var(--lg-ink-3)]',
          'hover:border-[color:var(--lg-line-hover)]',
          'focus-visible:border-[color:var(--lg-focus-border)] focus-visible:ring-[3px] focus-visible:ring-[color:var(--lg-focus-ring)]',
          'focus-visible:bg-[color:var(--lg-input-focus-bg)] dark:focus-visible:bg-[color:var(--lg-input-focus-bg)]',
          'disabled:opacity-60',
          // 错误态：红边红环（盖过 shadcn 的 aria-invalid destructive 默认）
          'aria-invalid:border-[color:var(--lg-error)] aria-invalid:ring-[color:var(--lg-error-ring)] dark:aria-invalid:ring-[color:var(--lg-error-ring)]'
        )}
      />
    </div>
  )
}

export function LoginScreen({
  onSignedIn
}: {
  onSignedIn: (state: AuthState) => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (submitting) return
    const api = window.chatApi
    if (!api?.login) return
    setSubmitting(true)
    setError(null)
    void api
      .login({ email, password })
      .then((result) => {
        if (result.ok) {
          // 成功后不清 submitting：直通 onSignedIn 让 AuthGate 卸载本组件，
          // 按钮保持「登录中…」到消失，不闪回可点态。
          onSignedIn(result.state)
        } else {
          setError(result.error)
          setSubmitting(false)
        }
      })
      .catch(() => {
        setError('登录失败，请稍后重试')
        setSubmitting(false)
      })
  }

  return (
    <div className="login-screen fixed inset-0 z-[9999] overflow-hidden bg-[color:var(--lg-bg)] transition-colors duration-300">
      {/* ── 背景系统（纯装饰层：aria-hidden + pointer-events 穿透）── */}
      {/* 主光晕：底部品牌绿（-translate-x-1/2 由 keyframes 的 transform 接管维持） */}
      <div
        aria-hidden
        className="login-glow-main pointer-events-none absolute -bottom-[46%] left-1/2 h-[640px] w-[1000px] -translate-x-1/2"
      />
      {/* 副光晕：右上邻近青 */}
      <div
        aria-hidden
        className="login-glow-side pointer-events-none absolute -right-[18%] -top-[30%] h-[520px] w-[660px]"
      />
      <div aria-hidden className="login-grid pointer-events-none absolute inset-0" />
      {/* 漂浮微粒 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {MOTES.map(([left, dur, delay, size], i) => (
          <span
            key={i}
            className="login-mote"
            style={{
              left: `${left}%`,
              width: size,
              height: size,
              animationDuration: `${dur}s`,
              animationDelay: `${delay}s`
            }}
          />
        ))}
      </div>

      {/* 窗口拖拽条：absolute 盖在两面顶部（见头注释）。 */}
      <div className="absolute inset-x-0 top-0 z-10 h-12 [-webkit-app-region:drag]" />
      {/* 主题切换（在 drag 区内，自带 no-drag） */}
      <ThemeToggle />

      <div className="relative flex h-full">
        {/* ── 左：品牌面（窄窗降级隐藏，登录表单永远可用）── */}
        <aside className="hidden w-[44%] flex-col border-r border-[color:var(--lg-pane-border)] bg-[radial-gradient(ellipse_80%_60%_at_50%_46%,var(--lg-pane-glow),transparent_70%)] px-12 pb-9 pt-[60px] transition-colors duration-300 md:flex">
          {/* 顶部字标：真实应用图标（public/app-icon.png，256px 源）。PNG 按
            * macOS 图标规范四周有 ~10% 透明内边距，36px 呈现视觉 ~29px，与
            * 原 30px 字母方块等大；-ml/-my 负边距吐掉内边距占位，保持行高
            * 与左对齐线不动。发光走 --lg-mark-glow（drop-shadow 贴 alpha）。 */}
          <div className={cn(RISE, 'flex items-center gap-2.5')}>
            <img
              src="/app-icon.png"
              alt=""
              draggable={false}
              className="-my-[3px] -ml-[3px] size-9 shrink-0 [filter:var(--lg-mark-glow)]"
            />
            <span className="text-[15px] font-semibold tracking-[-0.2px] text-[color:var(--lg-ink)]">
              Cowork
            </span>
          </div>

          {/* 轨道环：双环反向慢转 + 中心发光核（环样式在 login.css） */}
          <div
            aria-hidden
            className={cn(RISE, '[animation-delay:.1s]', 'relative m-auto size-60')}
          >
            <div className="login-ring" />
            <div className="login-ring login-ring-inner" />
            {/* 中心核 = 真实应用图标。116px 呈现视觉 ~93px（补偿 PNG 透明
              * 内边距），与原 96px 字母方块等大；环境绿光走 --lg-core-glow。 */}
            <img
              src="/app-icon.png"
              alt=""
              draggable={false}
              className="absolute inset-0 m-auto size-[116px] [filter:var(--lg-core-glow)]"
            />
          </div>

          {/* slogan */}
          <div className={cn(RISE, '[animation-delay:.2s]', 'mb-auto text-center')}>
            <h2 className="text-[26px] font-semibold leading-[1.3] tracking-[-0.4px] text-[color:var(--lg-ink)]">
              把想法交给智能体
            </h2>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-[color:var(--lg-ink-2)]">
              写方案、做设计、跑任务
              <br />
              一个工作台完成
            </p>
          </div>

          {/* mono 状态行：呼吸绿点。版本号刻意不放——preload 的 api.version
            * 是写死的占位值，显示假版本不如不显示。 */}
          <div className={cn(RISE, '[animation-delay:.3s]', 'mt-10 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[1.5px] text-[color:var(--lg-ink-3)]')}>
            <i className="login-pulse size-1.5 rounded-full bg-[color:var(--lg-dot-outer)] shadow-[0_0_8px_var(--lg-dot-glow-outer)]" />
            System Ready
          </div>
        </aside>

        {/* ── 右：表单面 ── */}
        <div className="flex flex-1 items-center justify-center overflow-y-auto px-6">
          <div className="w-[336px]">
            {/* 表单头：分屏版左对齐（品牌身份已由左面承担，不重复 C 标） */}
            <div className="mb-[26px]">
              <div className={cn(RISE, 'mb-3.5')}>
                <span className="inline-flex items-center gap-2 font-mono text-[10.5px] font-medium uppercase tracking-[3px] text-[color:var(--lg-green)]/85 after:h-px after:w-[22px] after:bg-gradient-to-r after:from-[color:var(--lg-green)]/50 after:to-transparent">
                  Welcome Back
                </span>
              </div>
              <h1
                className={cn(
                  RISE,
                  '[animation-delay:.07s]',
                  'text-[30px] font-semibold leading-[1.12] tracking-[-0.5px] text-[color:var(--lg-ink)]'
                )}
              >
                欢迎回来
              </h1>
              <p
                className={cn(
                  RISE,
                  '[animation-delay:.14s]',
                  'mt-2.5 text-[14.5px] leading-normal tracking-[-0.1px] text-[color:var(--lg-ink-2)]'
                )}
              >
                使用你的账号登录
              </p>
            </div>

            {/* 表单。key=error：错误变化时强制重挂重播 shake（连续两次错也抖）。 */}
            <form
              key={error ?? 'ok'}
              onSubmit={handleSubmit}
              className={cn(
                RISE,
                '[animation-delay:.21s]',
                'space-y-4',
                error && 'animate-[login-shake_.4s_cubic-bezier(0.32,0.72,0,1)]'
              )}
            >
              <FormField
                id="login-email"
                label="邮箱"
                type="email"
                autoComplete="email"
                autoFocus
                placeholder="you@example.com"
                value={email}
                disabled={submitting}
                onChange={setEmail}
              />
              <FormField
                id="login-password"
                label="密码"
                type="password"
                autoComplete="current-password"
                placeholder="请输入密码"
                value={password}
                disabled={submitting}
                invalid={!!error}
                onChange={setPassword}
              />

              {/* 错误文案来自 main（AUTH_LOGIN 的 error 字段），mono 终端感 */}
              {error ? (
                <p
                  role="alert"
                  className="px-0.5 font-mono text-[12.5px] text-[color:var(--lg-error)] before:content-['✕_']"
                >
                  {error}
                </p>
              ) : null}

              <Button
                type="submit"
                disabled={submitting}
                className={cn(
                  'login-sheen relative h-12 w-full overflow-hidden rounded-xl',
                  'bg-gradient-to-br from-[color:var(--lg-green)] to-[color:var(--lg-green-deep)]',
                  'text-[15.5px] font-bold tracking-[-0.1px] text-[color:var(--lg-green-fg)]',
                  'shadow-[var(--lg-btn-shadow)]',
                  'transition-[transform,box-shadow,filter] duration-200',
                  'hover:brightness-[1.07] hover:shadow-[var(--lg-btn-shadow-hover)]',
                  'active:scale-[.985] active:brightness-[.97]',
                  'focus-visible:ring-[color:var(--lg-focus-ring)] disabled:opacity-90'
                )}
              >
                {submitting ? (
                  <>
                    <Loader2 aria-hidden className="animate-spin" />
                    登录中…
                  </>
                ) : (
                  '登录'
                )}
              </Button>
            </form>

            {/* 注册/找回密码链路尚不存在——只放诚实的静态说明，不放假链接。 */}
            <p
              className={cn(
                RISE,
                '[animation-delay:.28s]',
                'mt-[18px] text-[13px] tracking-[-0.1px] text-[color:var(--lg-ink-3)]'
              )}
            >
              没有账号？联系管理员开通
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
