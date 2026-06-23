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
 *   - `login` calls `commitLogin` (AUTH_LOGIN) and ADOPTS main's authoritative
 *     snapshot — main derives the tenantId, so loggedIn + tenantId land together
 *     (no local sha256, no optimistic loggedIn-without-tenantId window).
 *   - `logout` / rename push to main (AUTH_SET); main persists + broadcasts.
 *     We update locally right away so the writer's own UI is instant (main
 *     skips the writer in its broadcast, so there's no echo back).
 *
 * The raw phone reaches main only via the verify + commit flow (sendCode /
 * verifyCode / commitLogin); it is never persisted and never broadcast. Main
 * derives the masked phone (138****8888) and tenantId, and only those leave
 * main. There's no token yet (the fusion-code backend is env-driven), so this
 * is an identity marker.
 */

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
  /**
   * Stable per-tenant key — sha256(rawPhone) first 16 hex chars, **derived by
   * main** and mirrored here from its snapshot (the renderer never computes it).
   * Null when signed out. Matches AuthState.tenantId in ipc-channels.ts.
   */
  tenantId: string | null
  /**
   * Sign in. Pass the raw 11-digit phone (already SMS-verified). main derives
   * the identity and returns the authoritative snapshot, which we adopt.
   */
  login: (rawPhone: string) => void
  /** Rename the signed-in user. No-op when signed out / blank. */
  setNickname: (name: string) => void
  logout: () => void
  /** Adopt a state pushed from main (hydrate / AUTH_CHANGED). Internal. */
  _adopt: (state: AuthIpcState) => void
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
  tenantId: null,
  login: (rawPhone) => {
    // Identity derivation lives in main now. commitLogin hands main the raw
    // (already SMS-verified) phone; main re-derives the tenantId, preserves a
    // returning user's nickname (or defaults a new one), persists + activates
    // the tenant, and returns the authoritative snapshot. We adopt it so
    // loggedIn + tenantId land together — there's no longer a "logged in but
    // tenantId not yet computed" window for the send gate to defend against.
    //
    // A successful commit triggers a full tenant-switch reset (reload); this
    // renderer is rebuilt and re-hydrates from main, so the local adopt below
    // mostly covers the instant before that. On failure (expired proof, main
    // unreachable) main returns the signed-out snapshot and we stay logged out.
    void window.chatApi
      ?.commitLogin?.({ phone: rawPhone })
      .then((state) => {
        if (state) get()._adopt(state)
      })
      .catch(() => {
        /* main unreachable / preload missing — stay signed out, user retries */
      })
  },
  setNickname: (name) => {
    const nickname = name.trim()
    if (!get().loggedIn || nickname === '') return
    // Optimistic local update; main is authoritative for the rest. We still
    // send the full AuthState shape (the AUTH_SET contract), but main IGNORES
    // the identity fields (tenantId / phone) and renames only its *active*
    // tenant — so a stale tenantId here (mid cross-window transition) can't
    // misroute the rename or get it rejected. phone/tenantId go along only to
    // satisfy the type; their values don't matter.
    set({ nickname })
    pushToMain({ loggedIn: true, phone: get().phone, nickname, tenantId: get().tenantId })
  },
  logout: () => {
    set({ loggedIn: false, phone: null, nickname: null, tenantId: null })
    pushToMain({ loggedIn: false, phone: null, nickname: null, tenantId: null })
  },
  _adopt: (state) =>
    set({
      loggedIn: state.loggedIn,
      phone: state.phone,
      nickname: state.nickname,
      tenantId: state.tenantId
    })
}))

/**
 * Snapshot read of "is a tenant signed in right now". For non-React call sites
 * — event callbacks, assistant-ui adapters — that can't use the hook selector
 * and need a point-in-time value (NOT a subscription). Centralizes the gate so
 * the token-gating call sites don't each inline `useAuthStore.getState().loggedIn`.
 */
export function isLoggedIn(): boolean {
  return useAuthStore.getState().loggedIn
}

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
