import type { Dict } from '../i18n/types';

export type SoundId = string;

export interface SoundOption {
  id: SoundId;
  labelKey: keyof Dict;
}

export const SUCCESS_SOUNDS: SoundOption[] = [
  { id: 'ding', labelKey: 'settings.notifySoundDing' },
  { id: 'chime', labelKey: 'settings.notifySoundChime' },
  { id: 'two-tone-up', labelKey: 'settings.notifySoundTwoToneUp' },
  { id: 'pluck', labelKey: 'settings.notifySoundPluck' },
];

export const FAILURE_SOUNDS: SoundOption[] = [
  { id: 'buzz', labelKey: 'settings.notifySoundBuzz' },
  { id: 'two-tone-down', labelKey: 'settings.notifySoundTwoToneDown' },
  { id: 'thud', labelKey: 'settings.notifySoundThud' },
];

export const DEFAULT_SUCCESS_SOUND_ID: SoundId = 'ding';
export const DEFAULT_FAILURE_SOUND_ID: SoundId = 'buzz';

type AudioCtxCtor = typeof AudioContext;
type NotificationOptionsWithBrowserExtensions = NotificationOptions & {
  renotify?: boolean;
};

let ctx: AudioContext | null = null;
const activeNotifications = new Set<Notification>();

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor: AudioCtxCtor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioCtxCtor }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => {
      // Autoplay policy can refuse — fall through silently. The next
      // user-gesture-driven call will retry.
    });
  }
  return ctx;
}

interface ToneSpec {
  freq: number;
  type: OscillatorType;
  start: number;
  duration: number;
  gain?: number;
  // Optional lowpass cutoff applied via a BiquadFilter for plucky textures.
  lowpass?: number;
}

function playTones(c: AudioContext, tones: ToneSpec[]): void {
  const now = c.currentTime;
  for (const tone of tones) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = tone.type;
    osc.frequency.value = tone.freq;
    const peak = tone.gain ?? 0.18;
    const startAt = now + tone.start;
    const endAt = startAt + tone.duration;
    // Short attack to avoid clicks; exponential-ish decay via linear ramp
    // to a near-zero value (exponentialRamp can't reach 0).
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.linearRampToValueAtTime(peak, startAt + Math.min(0.005, tone.duration * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt);

    let last: AudioNode = osc;
    if (tone.lowpass) {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = tone.lowpass;
      osc.connect(lp);
      last = lp;
    }
    last.connect(gain);
    gain.connect(c.destination);
    osc.start(startAt);
    osc.stop(endAt + 0.02);
  }
}

const SOUND_PLAYERS: Record<SoundId, (c: AudioContext) => void> = {
  ding: (c) => {
    playTones(c, [{ freq: 880, type: 'sine', start: 0, duration: 0.25, gain: 0.22 }]);
  },
  chime: (c) => {
    playTones(c, [
      { freq: 880, type: 'triangle', start: 0, duration: 0.4, gain: 0.18 },
      { freq: 1320, type: 'triangle', start: 0, duration: 0.4, gain: 0.12 },
    ]);
  },
  'two-tone-up': (c) => {
    playTones(c, [
      { freq: 660, type: 'square', start: 0, duration: 0.08, gain: 0.16 },
      { freq: 990, type: 'square', start: 0.09, duration: 0.08, gain: 0.16 },
    ]);
  },
  pluck: (c) => {
    playTones(c, [
      { freq: 220, type: 'sawtooth', start: 0, duration: 0.15, gain: 0.22, lowpass: 1200 },
    ]);
  },
  buzz: (c) => {
    playTones(c, [
      { freq: 165, type: 'square', start: 0, duration: 0.06, gain: 0.2 },
      { freq: 165, type: 'square', start: 0.1, duration: 0.06, gain: 0.2 },
      { freq: 165, type: 'square', start: 0.2, duration: 0.06, gain: 0.2 },
    ]);
  },
  'two-tone-down': (c) => {
    playTones(c, [
      { freq: 880, type: 'sine', start: 0, duration: 0.12, gain: 0.2 },
      { freq: 440, type: 'sine', start: 0.13, duration: 0.12, gain: 0.2 },
    ]);
  },
  thud: (c) => {
    playTones(c, [{ freq: 80, type: 'sine', start: 0, duration: 0.12, gain: 0.32 }]);
  },
};

export function playSound(id: SoundId): void {
  const c = getCtx();
  if (!c) return;
  const player = SOUND_PLAYERS[id];
  if (!player) return;
  try {
    player(c);
  } catch {
    // A node creation / connection failure should never throw out to UI code.
  }
}

export function previewSuccess(id: SoundId): void {
  playSound(id);
}

export function previewFailure(id: SoundId): void {
  playSound(id);
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export interface CompletionNotificationOpts {
  status: 'succeeded' | 'failed';
  title: string;
  body: string;
  onClick?: () => void;
}

export type CompletionNotificationResult =
  | 'shown'
  | 'unsupported'
  | 'permission-denied'
  | 'failed';

function notificationOptionsFor(
  opts: CompletionNotificationOpts,
): NotificationOptionsWithBrowserExtensions {
  const tag = `od-task-${opts.status}`;
  return {
    body: opts.body,
    tag,
    renotify: true,
    data: {
      status: opts.status,
      url: typeof window === 'undefined' ? '/' : window.location.href,
    },
  };
}

function showViaConstructor(opts: CompletionNotificationOpts): CompletionNotificationResult {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'granted') return 'permission-denied';
  try {
    const note = new Notification(opts.title, notificationOptionsFor(opts));
    activeNotifications.add(note);
    const release = () => {
      note.onclick = null;
      note.onclose = null;
      note.onerror = null;
      activeNotifications.delete(note);
    };
    note.onclick = () => {
      try {
        if (typeof window !== 'undefined') window.focus();
      } catch {
        /* ignore */
      }
      opts.onClick?.();
      try {
        note.close();
      } catch {
        /* ignore */
      }
    };
    note.onclose = release;
    note.onerror = release;
    return 'shown';
  } catch {
    return 'failed';
  }
}

export async function showCompletionNotification(
  opts: CompletionNotificationOpts,
): Promise<CompletionNotificationResult> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'granted') return 'permission-denied';
  // 直接用 Notification constructor。曾经先试 service worker（showNotification）
  // 再回退 constructor，但 SW 文件（/od-notifications-sw.js）从未存在，注册必然
  // 失败、每次白跑一轮再回退。Electron 里 constructor 通知已由主进程转成 macOS
  // 系统通知，SW 那套（给纯浏览器 PWA 的后台持久通知）在桌面壳里无收益。
  // 保留 async 签名：调用方 await 它，且未来若要接主进程 IPC 通知不必改签名。
  return showViaConstructor(opts);
}
