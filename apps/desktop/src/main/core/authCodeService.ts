import type { AuthCodeError } from '../../shared/ipc-channels'

/**
 * authCodeService — the send-code / verify-code backend, behind a stable
 * interface.
 *
 * REPLACEABLE STUB. There is no SMS backend yet (the fusion-code CLI is
 * env-driven and has no auth endpoints), so this generates a code locally,
 * keeps it in memory, logs it to the Electron terminal for development, and
 * verifies against it. Everything *around* it is real, though — the IPC
 * channels, the throttle, the TTL, the attempt cap, and the error contract —
 * so the LoginDialog's success AND failure paths can be built and exercised
 * today.
 *
 * When a real endpoint exists, replace ONLY the two function bodies below
 * (`requestCode` → POST /send-code, `checkCode` → POST /verify-code) and drop
 * the in-memory Map + the dev `console.log`. The signatures, the AuthCodeError
 * union, and every caller stay exactly as they are. That's the whole point of
 * landing it as a service now rather than inlining the stub in register.ts.
 *
 * Why the throttle lives here and not in the renderer: LoginDialog still runs
 * a 60s resend countdown, but that's pure UX — a user can re-open the modal to
 * reset it. The authoritative cooldown is enforced here, per phone, so it
 * survives any renderer-side reset. A real backend would enforce it server-
 * side; until then this stands in for that guarantee.
 */

/** Server-side phone shape check — mirrors the renderer's PHONE_RE. */
const PHONE_RE = /^1[3-9]\d{9}$/
/** Minimum gap between two code requests for the same phone. */
const RESEND_COOLDOWN_MS = 60_000
/** How long an issued code stays valid. */
const CODE_TTL_MS = 5 * 60_000
/** Wrong-code tries allowed before the phone is locked out (re-request needed). */
const MAX_ATTEMPTS = 5

interface CodeRecord {
  code: string
  /** Epoch ms after which the code is no longer valid. */
  expiresAt: number
  /** Wrong-code attempts so far against this record. */
  attempts: number
  /** Epoch ms of the last send — drives the resend cooldown. */
  lastSentAt: number
}

/**
 * phone(raw) → outstanding code. Module-level singleton: there's one main
 * process, and codes are short-lived, so a plain Map is enough — no need to
 * persist (a code surviving a restart would be a liability, not a feature).
 */
const records = new Map<string, CodeRecord>()

type Result = { ok: true } | { ok: false; error: AuthCodeError }

/** 6 random digits, zero-padded. Stub-only — a real backend owns the code. */
function generateCode(): string {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0')
}

/**
 * Issue (or re-issue) a code for `phone`. Enforces the per-phone cooldown.
 * STUB: logs the code; a real impl POSTs to the SMS endpoint and returns its
 * ok/error verbatim.
 */
export function requestCode(phone: string): Result {
  if (!PHONE_RE.test(phone)) return { ok: false, error: 'invalid_phone' }

  const now = Date.now()
  const existing = records.get(phone)
  if (existing && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
    return { ok: false, error: 'rate_limited' }
  }

  const code = generateCode()
  records.set(phone, {
    code,
    expiresAt: now + CODE_TTL_MS,
    attempts: 0,
    lastSentAt: now
  })

  // Dev-only: the only way to see the code without an SMS backend. Delete this
  // line when wiring the real endpoint — it must never log a real code.
  console.log(`[authCodeService] STUB code for ${phone}: ${code} (valid 5m)`)

  return { ok: true }
}

/**
 * Verify `phone` + `code`. Consumes the record on success; counts wrong tries
 * and locks out after MAX_ATTEMPTS (caller must re-request). A missing record
 * reads as `expired` — either it was never requested, already used, or aged
 * out; in every case the user needs a fresh code.
 */
export function checkCode(phone: string, code: string): Result {
  if (!PHONE_RE.test(phone)) return { ok: false, error: 'invalid_phone' }

  const rec = records.get(phone)
  if (!rec) return { ok: false, error: 'expired' }

  if (Date.now() > rec.expiresAt) {
    records.delete(phone)
    return { ok: false, error: 'expired' }
  }

  if (rec.code !== code) {
    rec.attempts += 1
    if (rec.attempts >= MAX_ATTEMPTS) {
      // Burn the record so a locked-out phone can't keep guessing — force a
      // fresh request, which also resets the attempt counter.
      records.delete(phone)
      return { ok: false, error: 'too_many_attempts' }
    }
    return { ok: false, error: 'invalid_code' }
  }

  // Single-use: a verified code can't be replayed.
  records.delete(phone)
  return { ok: true }
}
