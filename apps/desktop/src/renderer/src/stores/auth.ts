import { create } from 'zustand'

import type { AuthState as AuthIpcState } from '../../../shared/ipc-channels'

/**
 * Auth (login) state — synced across windows via the main process.
 *
 * The sign-in UI is LoginDialog (phone + SMS-code); on success it calls
 * `login(rawPhone)`. The signed-in identity also has to be visible in the
 * shell tab strip's login entry, which is a SEPARATE webContents from the
 * chat renderer — so localStorage (per-renderer) can't be the source of
 * truth. Instead **main** owns it (persisted in settings.json) and this
 * store is a synced cache:
 *
 *   - `hydrateAuthFromMain()` seeds the store on mount (AUTH_GET).
 *   - `subscribeAuthChanges()` keeps it live: when ANY window writes auth,
 *     main broadcasts AUTH_CHANGED to the others and the handler applies it.
 *   - `login` / `logout` push to main (AUTH_SET); main persists + broadcasts.
 *     We also update locally right away so the writer's own UI is instant
 *     (main skips the writer in its broadcast, so there's no echo back).
 *
 * Only the **masked** phone (138****8888) ever leaves this module — the raw
 * number is masked here before it's sent to main. There's no token yet (the
 * fusion-code backend is env-driven), so this is an identity marker.
 */
/**
 * Default display name on first sign-in. The backend has no username field,
 * so a new user starts with this placeholder and can rename from the account
 * menu. It deliberately differs from the phone so the two-line chrome chip
 * (nickname over phone) doesn't show the same string twice.
 */
const DEFAULT_NICKNAME = 'Open Design 用户'

interface AuthStoreState {
  loggedIn: boolean
  /**
   * Whether the initial AUTH_GET from main has settled (success OR failure).
   * Starts false; `hydrateAuthFromMain()` flips it true once the read resolves
   * so a login wall can tell "still loading" from "settled, signed out".
   */
  hydrated: boolean
  /** Masked phone for display, e.g. "138****8888". Null when signed out. */
  phone: string | null
  /** User-editable display name. Null when signed out. */
  nickname: string | null
  /** Sign in. Pass the raw 11-digit phone; it's masked before storing. */
  login: (rawPhone: string) => void
  /** Rename the signed-in user. No-op when signed out / blank. */
  setNickname: (name: string) => void
  logout: () => void
  /** Adopt a state pushed from main (hydrate / AUTH_CHANGED). Internal. */
  _adopt: (state: AuthIpcState) => void
}

/** 138****8888 — keep the first 3 and last 4 digits, mask the middle 4. */
function maskPhone(raw: string): string {
  // Happy path: an 11-digit phone (login() only runs post PHONE_RE).
  if (raw.length === 11) return `${raw.slice(0, 3)}****${raw.slice(7)}`
  // Defense-in-depth: anything else slipped past validation. NEVER return the
  // raw digits (that would defeat this module's "only the masked phone leaves
  // here" invariant) — fully mask instead.
  return '*'.repeat(raw.length)
}

function pushToMain(state: AuthIpcState): void {
  // Fire-and-forget: the local set already happened, and main's settings.json
  // is the durable copy. A failed write just means main was unreachable.
  void window.chatApi?.setAuth?.(state).catch(() => {
    /* main offline / preload missing — local state still reflects the intent */
  })
}

export const useAuthStore = create<AuthStoreState>((set, get) => ({
  loggedIn: false,
  hydrated: false,
  phone: null,
  nickname: null,
  login: (rawPhone) => {
    const phone = maskPhone(rawPhone)
    // Preserve a previously-set nickname ONLY when the SAME phone re-logs in
    // (a returning user who renamed before). A different phone is a different
    // account — never inherit the prior user's name, or a stale store (e.g. a
    // cross-window logout not yet adopted) would leak one user's nickname onto
    // another's login on the same running app.
    const samePhone = get().phone === phone
    const nickname = samePhone ? (get().nickname ?? DEFAULT_NICKNAME) : DEFAULT_NICKNAME
    set({ loggedIn: true, phone, nickname })
    pushToMain({ loggedIn: true, phone, nickname })
  },
  setNickname: (name) => {
    const nickname = name.trim()
    if (!get().loggedIn || nickname === '') return
    const phone = get().phone
    set({ nickname })
    pushToMain({ loggedIn: true, phone, nickname })
  },
  logout: () => {
    set({ loggedIn: false, phone: null, nickname: null })
    pushToMain({ loggedIn: false, phone: null, nickname: null })
  },
  _adopt: (state) =>
    set({
      loggedIn: state.loggedIn,
      phone: state.phone,
      nickname: state.nickname
    })
}))

/**
 * Seed the store from main's persisted copy. Call once on mount (both the
 * chat App and the shell). No-op when the preload bridge is missing.
 */
export async function hydrateAuthFromMain(): Promise<void> {
  const api = window.chatApi
  // No bridge (e.g. preload missing) — there's nothing to read, but the wall
  // must still resolve, so mark hydrated and let the signed-out default stand.
  if (!api?.getAuth) {
    useAuthStore.setState({ hydrated: true })
    return
  }
  try {
    const state = await api.getAuth()
    if (state) useAuthStore.getState()._adopt(state)
  } catch {
    /* main offline — store keeps its signed-out default */
  } finally {
    // Either way the read has settled — release the wall's loading gate. A
    // failed read leaves us signed out, which correctly shows the login wall.
    useAuthStore.setState({ hydrated: true })
  }
}

/**
 * Subscribe to cross-window auth changes. Returns an unsubscribe. Call from
 * an effect in both the chat App and the shell so each reflects a login /
 * logout performed in the other window.
 */
export function subscribeAuthChanges(): () => void {
  const api = window.chatApi
  if (!api?.onAuthChanged) return () => {}
  return api.onAuthChanged((state) => {
    useAuthStore.getState()._adopt(state)
  })
}
