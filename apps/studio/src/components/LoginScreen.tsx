'use client'

/**
 * 全屏登录页（AuthGate 的 signedOut 面）——「HUD 分屏」科技感版。
 *
 * 登录方式：手机号 + 短信验证码（sub2api 后端 `POST /auth/send-sms-code` +
 * `POST /auth/login/phone`），不做邮箱登录。手机号首次登录由后端自动
 * 注册，因此没有独立的「没有账号」提示——诚实反映这条链路的真实行为。
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
import type { FormEvent, ReactNode } from 'react'
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
 * 行为全是 shadcn 原生。`trailing` 给验证码字段挂「获取验证码」按钮，
 * 不传时套壳 flex 容器只有一个子元素，行为等同直出 Input。
 */
function FormField({
  id,
  label,
  type,
  inputMode,
  autoComplete,
  autoFocus,
  placeholder,
  value,
  disabled,
  invalid,
  onChange,
  trailing
}: {
  id: string
  label: string
  type: string
  inputMode?: 'text' | 'numeric' | 'tel'
  autoComplete: string
  autoFocus?: boolean
  placeholder: string
  value: string
  disabled: boolean
  invalid?: boolean
  onChange: (v: string) => void
  trailing?: ReactNode
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-[13px] font-medium text-[color:var(--lg-ink-2)]">
        {label}
      </Label>
      <div className="flex gap-2">
        <Input
          id={id}
          type={type}
          inputMode={inputMode}
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
            'h-11 flex-1 rounded-lg border-[color:var(--lg-line)]',
            'bg-[color:var(--lg-input-bg)] dark:bg-[color:var(--lg-input-bg)]',
            'text-[15px] text-[color:var(--lg-ink)] caret-[color:var(--lg-green)]',
            // 用 --lg-ink-2（同 Label 色阶）不用更淡的 --lg-ink-3——0.4 alpha
            // 的 placeholder 在亮档背景上对比度不够，读起来发虚（2026-07-22
            // 用户反馈样式不好看，见 FormField 头注释）。
            'placeholder:text-[color:var(--lg-ink-2)]',
            'hover:border-[color:var(--lg-line-hover)]',
            'focus-visible:border-[color:var(--lg-focus-border)] focus-visible:ring-[3px] focus-visible:ring-[color:var(--lg-focus-ring)]',
            'focus-visible:bg-[color:var(--lg-input-focus-bg)] dark:focus-visible:bg-[color:var(--lg-input-focus-bg)]',
            'disabled:opacity-60',
            // 错误态：红边红环（盖过 shadcn 的 aria-invalid destructive 默认）
            'aria-invalid:border-[color:var(--lg-error)] aria-invalid:ring-[color:var(--lg-error-ring)] dark:aria-invalid:ring-[color:var(--lg-error-ring)]'
          )}
        />
        {trailing}
      </div>
    </div>
  )
}

/** 后端 isValidPhone 的镜像校验（纯数字，6-20 位，可选 + 前缀）——只挡
 * 明显的手误，真实校验属于后端。 */
const PHONE_RE = /^\+?\d{6,20}$/

export function LoginScreen({
  onSignedIn
}: {
  onSignedIn: (state: AuthState) => void
}) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  // 发码冷却倒计时（秒），驱动「获取验证码」按钮的禁用与文案。
  const [countdown, setCountdown] = useState(0)

  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  const phoneValid = PHONE_RE.test(phone.trim())

  const handleSendCode = () => {
    if (sendingCode || countdown > 0 || !phoneValid) return
    const api = window.chatApi
    if (!api?.sendSmsCode) return
    setSendingCode(true)
    setError(null)
    void api
      .sendSmsCode(phone.trim())
      .then((result) => {
        setSendingCode(false)
        if (result.ok) {
          setCountdown(result.countdown)
        } else {
          setError(result.error)
        }
      })
      .catch(() => {
        setSendingCode(false)
        setError('验证码发送失败，请稍后重试')
      })
  }

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (submitting) return
    const api = window.chatApi
    if (!api?.login) return
    setSubmitting(true)
    setError(null)
    void api
      .login({ phone: phone.trim(), code: code.trim() })
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
              {/* 原文案「使用你的账号登录」信息量为零——「欢迎回来」已经
                  暗示了登录语境，这句只是填充。换成登录方式本身（手机号 +
                  验证码），下面表单字段一眼就能对上，不是白说
                  （2026-07-22 用户反馈样式文案不好看）。 */}
              <p
                className={cn(
                  RISE,
                  '[animation-delay:.14s]',
                  'mt-2.5 text-[14.5px] leading-normal tracking-[-0.1px] text-[color:var(--lg-ink-2)]'
                )}
              >
                手机号 + 验证码登录
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
                id="login-phone"
                label="手机号"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                autoFocus
                placeholder="请输入手机号"
                value={phone}
                disabled={submitting}
                invalid={!!error}
                onChange={setPhone}
              />
              <FormField
                id="login-code"
                label="验证码"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="请输入验证码"
                value={code}
                disabled={submitting}
                invalid={!!error}
                onChange={setCode}
                trailing={
                  // 原配色（白底 + 浅灰描边）跟旁边的 Input 完全同色，用户分不清
                  // 这是个按钮还是第三个输入框；倒计时态又只降透明度，浅灰描边
                  // 淡出后几乎看不出「被禁用」。改成可点时走品牌绿 ghost（跟主
                  // 按钮同色系但克制，读作「次级动作」），禁用/倒计时时明确切
                  // 灰且不透明——两态一眼能分（2026-07-22 用户反馈样式不好看）。
                  <Button
                    type="button"
                    variant="outline"
                    disabled={sendingCode || countdown > 0 || !phoneValid || submitting}
                    onClick={handleSendCode}
                    className={cn(
                      'h-11 shrink-0 whitespace-nowrap rounded-lg px-3.5 text-[13px] font-medium transition-colors',
                      'border-[color:var(--lg-green)]/35 bg-[color:var(--lg-green)]/[0.06] text-[color:var(--lg-green)]',
                      'hover:border-[color:var(--lg-green)]/55 hover:bg-[color:var(--lg-green)]/[0.1]',
                      'disabled:cursor-not-allowed disabled:border-[color:var(--lg-line)] disabled:bg-transparent',
                      'disabled:text-[color:var(--lg-ink-3)] disabled:hover:border-[color:var(--lg-line)] disabled:hover:bg-transparent'
                    )}
                  >
                    {sendingCode ? (
                      <Loader2 aria-hidden className="size-3.5 animate-spin" />
                    ) : countdown > 0 ? (
                      `${countdown}s 后重发`
                    ) : (
                      '获取验证码'
                    )}
                  </Button>
                }
              />

              {/* 错误文案来自 main（AUTH_LOGIN 的 error 字段），mono 终端感。
                  常驻占位（固定 h-5，无错误时 invisible）而不是有错误才挂载——
                  右侧表单面是 items-center 垂直居中（见容器 className），这行
                  一旦按条件挂载/卸载就会改变 form 高度，让整张卡片（含上面的
                  标题）在报错瞬间被居中重算硬顶一下，无过渡、看起来像「抖了
                  一下」（2026-07-22 用户反馈）。固定高度让卡片总高不随 error
                  变化，报错只是在已预留的空间里淡入文字。 */}
              <p
                role={error ? 'alert' : undefined}
                className={cn(
                  'flex h-5 items-center px-0.5 font-mono text-[12.5px] text-[color:var(--lg-error)]',
                  "before:content-['✕_']",
                  !error && 'invisible'
                )}
              >
                {error}
              </p>

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

            {/* 手机号首次登录由后端自动注册，没有独立的「无账号」态。 */}
            <p
              className={cn(
                RISE,
                '[animation-delay:.28s]',
                'mt-[18px] text-[13px] tracking-[-0.1px] text-[color:var(--lg-ink-3)]'
              )}
            >
              首次登录将自动为你创建账号
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
