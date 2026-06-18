import { useEffect, useRef, useState } from 'react'

import { useDialogStore } from '../../stores/dialogs'
import { useAuthStore } from '../../stores/auth'
import type { AuthCodeError } from '../../../../shared/ipc-channels'
import { TERMS_DOC, PRIVACY_DOC, SUPPORT_EMAIL, LEGAL_ENTITY, type LegalDoc } from './loginLegal'
import './LoginDialog.css'

/**
 * LoginDialog
 * -----------
 * Phone-number + SMS-code sign-in, rendered as the approved two-pane
 * "premium" modal (a deep-ink brand panel on the left, the form on the
 * right). This is the one dialog that does NOT use DialogShell — its
 * bespoke chrome (tinted multi-layer shadow, animated logo, sheen sweep)
 * is too far from the standard card to express through the shell. All of
 * that styling lives in the co-located LoginDialog.css, scoped under
 * `.od-login-overlay`; this file owns only the markup + interaction.
 *
 * Open/close goes through the shared dialog store (`open === 'login'`),
 * the same mechanism as the Skills/Mcp/Logs dialogs, so only one modal is
 * ever open at a time. It's opened from the shell tab strip's login entry
 * (which fires the `open-login` shell-menu action — see ShellApp /
 * App.tsx's onShellMenuAction handler).
 *
 * Backend status
 * --------------
 * "获取验证码" and the final verify now go through real IPC —
 * `chatApi.sendCode` / `chatApi.verifyCode` — to main. There's still no SMS
 * provider behind them: main answers from a replaceable stub
 * (authCodeService) that generates + logs a code locally and enforces the
 * throttle / TTL / attempt cap for real. So the wiring, the error contract,
 * and both success AND failure UI are real today; only the code's *origin* is
 * a stub. Swapping in an SMS endpoint touches only authCodeService — this
 * dialog doesn't change. The 60s countdown here is pure UX; the authoritative
 * resend cooldown lives in main (a user can re-open the modal, but not
 * out-run the server-side gap). On a verified code we record the (masked)
 * phone in the auth store via the existing `login()` path.
 */

const PHONE_RE = /^1[3-9]\d{9}$/
const CODE_RE = /^\d{6}$/
const RESEND_SECONDS = 60

/** Map a backend error code to the message shown under the form. */
function messageFor(error: AuthCodeError): string {
  switch (error) {
    case 'rate_limited':
      return '请求过于频繁，请稍后再试'
    case 'invalid_phone':
      return '请输入正确的 11 位手机号'
    case 'invalid_code':
      return '验证码错误，请重新输入'
    case 'expired':
      return '验证码已过期，请重新获取'
    case 'too_many_attempts':
      return '错误次数过多，请重新获取验证码'
    case 'network':
      return '网络异常，请稍后重试'
  }
}

/**
 * The slide-in panel that overlays the dialog when one of the three footer
 * links is tapped. `terms`/`privacy` render the long-form copy from
 * loginLegal.ts; `support` is a small bespoke contact card (placeholder email).
 * A shared chrome (back arrow + scrollable body) wraps all three. `onBack`
 * returns to the form — same effect as Escape one level.
 */
function LegalPanel({
  view,
  onBack
}: {
  view: 'terms' | 'privacy' | 'support'
  onBack: () => void
}): React.JSX.Element {
  const doc: LegalDoc | null =
    view === 'terms' ? TERMS_DOC : view === 'privacy' ? PRIVACY_DOC : null
  const title = doc ? `《${doc.title}》` : '联系支持'

  return (
    <div className="od-legal" role="region" aria-label={title}>
      <div className="od-legal-bar">
        <button type="button" className="od-legal-back" onClick={onBack} aria-label="返回">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18 9 12 15 6" />
          </svg>
          返回
        </button>
        <div className="od-legal-title">{title}</div>
      </div>

      <div className="od-legal-body">
        {doc ? (
          <>
            <div className="od-legal-meta">{doc.meta}</div>
            <p className="od-legal-intro">{doc.intro}</p>
            {doc.sections.map((sec) => (
              <section key={sec.heading} className="od-legal-section">
                <h3>{sec.heading}</h3>
                {sec.body.map((line, i) =>
                  line.startsWith('· ') ? (
                    <p key={i} className="od-legal-li">
                      {line.slice(2)}
                    </p>
                  ) : (
                    <p key={i}>{line}</p>
                  )
                )}
              </section>
            ))}
          </>
        ) : (
          <div className="od-support">
            <p className="od-legal-intro">
              使用过程中遇到任何问题，欢迎通过以下方式联系 {LEGAL_ENTITY} 团队，我们会尽快为你处理。
            </p>
            <a className="od-support-card" href={`mailto:${SUPPORT_EMAIL}`}>
              <span className="od-support-ico" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m3 7 9 6 9-6" />
                </svg>
              </span>
              <span className="od-support-text">
                <span className="od-support-label">邮件支持</span>
                <span className="od-support-value">{SUPPORT_EMAIL}</span>
              </span>
            </a>
            <p className="od-support-hours">支持时间：工作日 10:00 – 19:00（节假日顺延）</p>
          </div>
        )}
      </div>
    </div>
  )
}

export function LoginDialog(): React.JSX.Element | null {
  const open = useDialogStore((s) => s.open === 'login')
  const close = useDialogStore((s) => s.closeDialog)
  const login = useAuthStore((s) => s.login)

  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [phoneTouched, setPhoneTouched] = useState(false)
  const [countdown, setCountdown] = useState(0) // seconds left; 0 = idle
  const [requested, setRequested] = useState(false) // code asked for ≥ once
  const [sending, setSending] = useState(false) // send-code IPC in flight
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [shake, setShake] = useState(false)
  // Backend failure message (send or verify). Null = no error showing.
  const [formError, setFormError] = useState<string | null>(null)
  // Which legal/support panel is overlaid on the form; null = none showing.
  // Escape backs out of this one level before closing the whole modal.
  const [legalView, setLegalView] = useState<'terms' | 'privacy' | 'support' | null>(null)

  const phoneInputRef = useRef<HTMLInputElement>(null)
  const codeInputRef = useRef<HTMLInputElement>(null)

  const phoneValid = PHONE_RE.test(phone)
  const codeValid = CODE_RE.test(code)
  const counting = countdown > 0
  const canSubmit = phoneValid && codeValid && agreed && !submitting

  // Reset everything whenever the dialog closes so a re-open starts clean
  // (and a submitted/done state never leaks into the next session).
  useEffect(() => {
    if (open) return
    setPhone('')
    setCode('')
    setAgreed(false)
    setPhoneTouched(false)
    setCountdown(0)
    setRequested(false)
    setSending(false)
    setSubmitting(false)
    setDone(false)
    setShake(false)
    setFormError(null)
    setLegalView(null)
  }, [open])

  // Autofocus the phone field on open. Deferred a tick so it runs after the
  // pop-in animation has mounted the node.
  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => phoneInputRef.current?.focus(), 60)
    return () => window.clearTimeout(id)
  }, [open])

  // Resend countdown. Ticks once a second while > 0; cleared on unmount /
  // close (the reset effect zeroes it, which also stops this).
  useEffect(() => {
    if (countdown <= 0) return
    const id = window.setInterval(() => {
      setCountdown((s) => (s <= 1 ? 0 : s - 1))
    }, 1000)
    return () => window.clearInterval(id)
  }, [countdown])

  // Escape closes — mirrors DialogShell's global handler so the login modal
  // behaves like every other dialog even though it doesn't use the shell.
  // When a legal/support panel is up, Escape backs out of that first (one
  // level), only closing the whole modal once the form is showing again.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (legalView) setLegalView(null)
        else close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close, legalView])

  // Success → sign in + close, but driven from an effect (not an inline
  // setTimeout in onSubmit) so the 900ms timer is tied to the component
  // lifecycle. If the user dismisses the modal during that window (✕ / scrim /
  // Escape), close() flips `open` false → the reset effect sets done=false →
  // this cleanup clears the pending timer. So we never sign in after an
  // explicit dismiss, and never run login()/setState after unmount.
  useEffect(() => {
    if (!done) return
    const id = window.setTimeout(() => {
      login(phone)
      close()
    }, 900)
    return () => window.clearTimeout(id)
  }, [done, phone, login, close])

  if (!open) return null

  const onlyDigits = (v: string, max: number): string =>
    v.replace(/\D/g, '').slice(0, max)

  const sendCode = async (): Promise<void> => {
    if (!phoneValid || counting || sending) return
    setFormError(null)
    setSending(true)
    // Ask main for a code. main owns the throttle, so only start the local
    // countdown once it says ok — a `rate_limited` reply means the cooldown
    // is still running server-side and we surface that instead of faking one.
    const res = await window.chatApi?.sendCode?.({ phone })
    setSending(false)
    if (!res || !res.ok) {
      setFormError(messageFor(res?.error ?? 'network'))
      return
    }
    setRequested(true)
    setCountdown(RESEND_SECONDS)
    codeInputRef.current?.focus()
  }

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!agreed) {
      // Nudge the agreement row instead of silently doing nothing.
      setShake(true)
      window.setTimeout(() => setShake(false), 400)
      return
    }
    if (!canSubmit) return
    setFormError(null)
    setSubmitting(true)
    // Real verify round-trip. Only the success arm proceeds to login; any
    // failure (wrong/expired code, lockout, network) drops back to the form
    // with a message so the user can correct or re-request.
    const res = await window.chatApi?.verifyCode?.({ phone, code })
    if (!res || !res.ok) {
      setSubmitting(false)
      setFormError(messageFor(res?.error ?? 'network'))
      return
    }
    // Verified — flip `done` to play the success animation; the done-effect
    // above schedules the sign-in + close once it finishes.
    setDone(true)
  }

  const codeBtnLabel = sending
    ? '发送中…'
    : counting
      ? `${countdown}s 后重发`
      : requested
        ? '重新获取'
        : '获取验证码'

  return (
    <div
      className="od-login-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="登录 Open Design"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="od-login-dialog">
        <button
          type="button"
          className="od-login-close"
          aria-label="关闭"
          onClick={close}
        >
          ✕
        </button>

        {/* Legal/support panel, overlaid on top of the two-pane card when a
            footer link is tapped. Mounted only while open so its slide-in
            animation replays each time. */}
        {legalView && <LegalPanel view={legalView} onBack={() => setLegalView(null)} />}

        {/* left: brand ink panel (decorative; hidden on narrow widths) */}
        <aside className="od-login-panel" aria-hidden="true">
          <div className="od-pglow1" />
          <div className="od-pglow2" />
          <div className="od-pgrain" />
          <svg className="od-plogo" viewBox="0 0 64 64" fill="none">
            <g stroke="var(--panel-fg)" strokeWidth="3.4" strokeLinecap="square">
              <path d="M10 24 L10 10 L24 10" />
              <path d="M40 10 L54 10 L54 24" />
              <path d="M54 40 L54 54 L40 54" />
              <path d="M24 54 L10 54 L10 40" />
            </g>
            <g className="od-cross" stroke="var(--panel-cross)" strokeWidth="3" strokeLinecap="round">
              <line x1="32" y1="20" x2="32" y2="44" />
              <line x1="20" y1="32" x2="44" y2="32" />
              <line x1="23.51" y1="23.51" x2="40.49" y2="40.49" />
              <line x1="40.49" y1="23.51" x2="23.51" y2="40.49" />
            </g>
          </svg>
          <div className="od-grow" />
          <div className="od-supertitle">OPEN&nbsp;DESIGN</div>
          <h2>
            为创作而生的
            <br />
            智能体工作台
          </h2>
          <p className="od-lede">登录后即可调用 fusion-code，把想法变成成品。</p>
          <div className="od-grow" />
          <div className="od-pfoot">© 2026 · 由 fusion-code 驱动</div>
        </aside>

        {/* right: form / success */}
        <div className="od-form-wrap">
          {!done ? (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div className="od-login-head">
                <div className="od-supertitle">欢迎使用</div>
                <h1>手机号登录</h1>
                <p>未注册的手机号将自动创建账户</p>
              </div>

              <form className="od-login-form" onSubmit={onSubmit} noValidate>
                <div className="od-label">手机号</div>
                <div
                  className={
                    'od-field' +
                    (phoneTouched && phone !== '' && !phoneValid ? ' od-invalid' : '')
                  }
                >
                  <span className="od-cc">
                    +86
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                      <path d="M3 4.5 6 7.5 9 4.5" />
                    </svg>
                  </span>
                  <input
                    ref={phoneInputRef}
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel"
                    maxLength={11}
                    placeholder="请输入手机号"
                    value={phone}
                    onChange={(e) => {
                      setPhone(onlyDigits(e.target.value, 11))
                      if (formError) setFormError(null)
                    }}
                    onFocus={() => setPhoneTouched(false)}
                    onBlur={() => setPhoneTouched(true)}
                  />
                </div>
                <div
                  className={
                    'od-error' +
                    (phoneTouched && phone !== '' && !phoneValid ? ' od-show' : '')
                  }
                >
                  请输入正确的 11 位手机号
                </div>

                <div className="od-label">验证码</div>
                <div className="od-field">
                  <input
                    ref={codeInputRef}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="6 位短信验证码"
                    value={code}
                    onChange={(e) => {
                      setCode(onlyDigits(e.target.value, 6))
                      if (formError) setFormError(null)
                    }}
                  />
                  <button
                    type="button"
                    className="od-code-btn"
                    disabled={!phoneValid || counting || sending}
                    onClick={sendCode}
                  >
                    {codeBtnLabel}
                  </button>
                </div>

                {/* Backend failure (send or verify) — reuses the field error
                    style. Always mounted so showing/hiding animates. */}
                <div className={'od-error' + (formError ? ' od-show' : '')}>
                  {formError ?? ''}
                </div>

                <button type="submit" className="od-submit" disabled={!canSubmit}>
                  {submitting ? (
                    <>
                      <span className="od-spinner" />
                      验证中
                    </>
                  ) : (
                    '登 录'
                  )}
                </button>

                <label className={'od-agree' + (shake ? ' od-shake' : '')}>
                  <span
                    className={'od-box' + (agreed ? ' od-checked' : '')}
                    role="checkbox"
                    aria-checked={agreed}
                    tabIndex={0}
                    onClick={() => setAgreed((a) => !a)}
                    onKeyDown={(e) => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault()
                        setAgreed((a) => !a)
                      }
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2.5 6.2 4.8 8.5 9.5 3.5" />
                    </svg>
                  </span>
                  <span>
                    我已阅读并同意{' '}
                    <a
                      onClick={(e) => {
                        // Stop the click bubbling to the label, which would
                        // otherwise toggle the agreement checkbox.
                        e.preventDefault()
                        e.stopPropagation()
                        setLegalView('terms')
                      }}
                    >
                      《用户协议》
                    </a>{' '}
                    和{' '}
                    <a
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setLegalView('privacy')
                      }}
                    >
                      《隐私政策》
                    </a>
                  </span>
                </label>
              </form>

              <div className="od-login-spacer" />
              <div className="od-login-switch">
                遇到问题？
                <a
                  onClick={(e) => {
                    e.preventDefault()
                    setLegalView('support')
                  }}
                >
                  联系支持
                </a>
              </div>
            </div>
          ) : (
            <div className="od-done">
              <div className="od-ring">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 12.5 9 17.5 20 6.5" />
                </svg>
              </div>
              <h2>登录成功</h2>
              <p>正在进入工作台…</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
