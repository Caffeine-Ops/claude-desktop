'use client'

import { useEffect } from 'react'

import { useI18n } from './i18n'
import { chatLangForLocale } from './lib/chatLangForLocale'

/** canvas i18n 的持久化键（`src/canvas/i18n/index.tsx` 的 LS_KEY）。 */
const CANVAS_LOCALE_KEY = 'open-design:locale'

/**
 * 界面语言的**常驻**同步桥：canvas（设置页「界面语言」）→ chat 面。
 * 不渲染任何 DOM，只承载副作用。姊妹件见 AppearanceBridge（主题），
 * 两者挂载位置与存活理由完全同源。
 *
 * 为什么需要这座桥
 * ----------------
 * 应用里有**两套互不知晓的 i18n**：
 *   - canvas（`src/canvas/i18n/`）19 本字典，持久化在 `open-design:locale`，
 *     设置页的「界面语言」写的是它；
 *   - chat（`src/chat/i18n.ts`）手写 zh/en 两本，持久化在
 *     `claude-desktop:lang`，智能助手空态（标题 / 三个分类 tab / 输入框
 *     提示）读的是它。
 *
 * 此前两者从无同步：`setLocale` 一行都没碰过 `setLang`。而 chat 那套的
 * 唯一 setter 是 `toggle-lang` 这个 shell 菜单动作，发送方早已随
 * TabBar 一并删除（0047853b「零引用死组件」）——于是 chat 的语言**没有
 * 任何入口可改**，卡在上次持久化的值上。用户症状：设置页明明是简体中文，
 * 智能助手空态却是 "More than chat — get things done"（2026-09-01 实锤，
 * localStorage 里 canvas=zh-CN、chat=en）。
 *
 * 为什么挂 SurfaceHost 而不是 chat/App.tsx
 * ----------------------------------------
 * 与 AppearanceBridge 同一个坑，且这里更致命：SurfaceHost 的
 * `chatShowing = isChat && !settingsOverlay && !kbOverlay`，**设置页一开
 * chat 面整棵不渲染**。而「用户在设置页里改语言」正是本桥唯一要在岗的
 * 时刻——挂在 chat 树里等于永远接不到那次广播。
 *
 * 两条链，缺一不可
 * ----------------
 *   1. 挂载时对账一次：读 canvas 的持久化值直接校准 chat。**这条才是治
 *      存量的**——已经跑歪的用户（如上）不需要再去设置页点一次语言，下次
 *      启动自动归位。
 *   2. 订阅 `od:locale-applied`：设置页当场改语言时同帧跟上，不用重启。
 *
 * 单向（canvas → chat），不做反向
 * -------------------------------
 * chat 的 lang 现在没有 UI 入口，反向桥没有触发源，加了就是死代码。若将来
 * 有人恢复 chat 侧的语言开关，**必须同时把值推回 canvas**，否则这里会在
 * 下次启动时按 canvas 的值把它盖掉（本桥的对账链是权威方向）。
 *
 * 走 `setLang()` 而不是直接 set store：它内部还会把语言 IPC 推给主进程，
 * 托盘菜单的中英文标签靠这一步跟着变（见 chat/i18n.ts 头注释）。
 */
export function LocaleBridge(): null {
  useEffect(() => {
    const sync = (locale: string | null): void => {
      if (!locale) return
      const next = chatLangForLocale(locale)
      // 值相同不 set：避免无谓的 store 写入与 IPC 往返（同 chat 侧主题
      // applier「值相同不 set」的断环处理）。
      if (useI18n.getState().lang === next) return
      useI18n.getState().setLang(next)
    }

    // 链 1：挂载对账（治存量分叉）
    try {
      sync(window.localStorage.getItem(CANVAS_LOCALE_KEY))
    } catch {
      /* localStorage 不可用（隐私模式等）：跳过对账，链 2 仍然有效 */
    }

    // 链 2：设置页当场改语言
    const onApplied = (e: Event): void => {
      const detail = (e as CustomEvent<{ locale?: string }>).detail
      sync(detail?.locale ?? null)
    }
    window.addEventListener('od:locale-applied', onApplied)
    return () => window.removeEventListener('od:locale-applied', onApplied)
  }, [])

  return null
}
