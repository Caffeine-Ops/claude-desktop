'use client'

/**
 * AppRail 的会话列表 —— docs/ui-prototype-session-actions.html 的 shadcn 落地。
 *
 * 数据链路完整复用 legacy 的 SHELL_SESSION_* IPC 环（preload 的
 * listShellSessions / switchShellSession / renameShellSession /
 * deleteShellSession / onShellSessionListChanged）：那套通道当年为「shell
 * renderer 无 engine、要展示活跃 chat tab 的会话」设计，单视图下发起方和
 * chat 页面是**同一个 webContents**，环依然成立——点击项 invoke
 * SWITCH_REQUEST，main 正规化成 SHELL_SESSION_SWITCH 事件发回本页面，
 * chat 的 FusionRuntimeProvider 既有订阅接住并走完整的 store 切换逻辑。
 *
 * 交互形态（2026-07-05 应用户要求：重命名/删除都走弹窗，替换掉早先的
 * 行内编辑 + 菜单内二次确认）：
 *  - 重命名走 **shadcn Dialog**：菜单点「重命名」开弹窗，输入框预填当前
 *    标题并全选，Enter / 点「保存」提交，Esc / 点「取消」/ 点遮罩关闭。
 *  - 删除走 **shadcn AlertDialog**（危险确认框）：菜单点「删除」开确认框，
 *    「删除」按钮走 destructive 样式，确认才真删。
 *  - 两个弹窗都是列表级单实例，由 renameTarget / deleteTarget 驱动——菜单
 *    条目只负责设置 target 打开对应弹窗，删/改逻辑集中在根组件。
 *  - ··· 菜单与右键菜单是同一组条目（SessionMenuItems 分别塞进
 *    DropdownMenu / ContextMenu 两个 radix 壳）。
 *  - 选中态即时呈现（无滑动动画，2026-07-04 退役），删除行播高度折叠动画，
 *    删的是当前会话时选中态移交相邻行。
 *
 * 本组件不 import 任何模块求值期会触碰 window 的 src/chat/ 模块（那会
 * 破坏所在 layout 的 SSR）；railMotion 是纯常量模块，属安全例外——rail
 * 的动效节奏必须与聊天区同源，不复制数值。一切数据在 useEffect 里经
 * window.chatApi / tabApi 获取，浏览器直开（无 chatApi）时整块渲染为空。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Loader2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import type { ComponentType, ReactNode } from 'react'
import type { ThreadSummary } from '@desktop-shared/types'

import { railEaseOut } from '@/src/chat/shell/railMotion'
import { useChatStore, useRunningSessionIdsKey } from '@/src/chat/stores/chat'
import { useUnreadIdsKey, useUnreadStore } from '@/src/chat/stores/unread'
import { groupLabel, relativeTime } from '@/src/components/railTime'
import { ScrollArea } from '@/src/components/ui/scroll-area'
import { Button } from '@/src/components/ui/button'
import { Input } from '@/src/components/ui/input'
import { Label } from '@/src/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/src/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/src/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/src/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/src/components/ui/context-menu'
import { cn } from '@/src/lib/utils'

/** renamed-flash 动画时长 + 余量，播完摘类以便下次重播。 */
const FLASH_MS = 950

/** 空标题的兜底展示文案（与删空会话回落的语义一致）。 */
const UNTITLED_LABEL = '新对话'

/**
 * rail 行的**展示**标题。ThreadSummary.title 无 custom/ai 标题时兜底到
 * firstPrompt——以 slash 命令开头的会话会把命令原文糊满整行，噪音吃掉真正
 * 的语义。展示层归一化成可读文本，按优先级处理三种形态：
 *
 *  1. **XML 包裹的命令**（`<command-name>/x</command-name>
 *     <command-args>参数</command-args>`）——这是 fusion-code 落盘 slash
 *     命令 user turn 的原始格式，会话【进行中或 SDK 尚未归一化】时 firstPrompt
 *     就是这段 XML（2026-07-05：ppt-master 会话跑起来但 rail 只显示一堆
 *     `<command-message>…` 标签甚至空白的根因——旧逻辑的正则只认裸 `/` 开头，
 *     不认 `<` 开头的 XML，直接把整段标签原样返回）。这里抽出
 *     `<command-args>`（有参数用参数）或 `<command-name>` 的命令短名。
 *  2. **裸 slash 命令**（SDK 归一化后的 `/claude-desktop:ppt-master 武汉…`）：
 *     `/claude-desktop:ppt-master 武汉大学PPT` → `武汉大学PPT`；纯命令无参数
 *     → 命令短名 `ppt-master`。
 *  3. 其它纯文本原样返回。
 *
 * 任何一步产出空串都兜底到「新对话」，绝不让 rail 出现无名行。只影响 rail
 * 展示；行 title 属性仍是完整原文，悬停可看全。
 */
function displayTitle(raw: string): string {
  const t = raw.trim()
  if (!t) return UNTITLED_LABEL

  // 形态 1：XML 包裹的 slash 命令。
  if (t.startsWith('<command-')) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim()
    if (args) return args
    const name = /<command-name>\s*\/?([\w.:-]+)\s*<\/command-name>/.exec(t)?.[1]
    if (name) return name.split(':').pop() || name
    // 认得是命令 XML 但抽不出名字/参数——别把标签糊到 rail 上。
    return UNTITLED_LABEL
  }

  // 形态 2：裸 slash 命令。
  const m = /^(\/[\w.:-]+)\s*([\s\S]*)$/.exec(t)
  if (m) {
    const rest = m[2].trim()
    if (rest) return rest
    return m[1].slice(1).split(':').pop() || UNTITLED_LABEL
  }

  // 形态 3：普通文本。
  return t
}

/* groupLabel / relativeTime 抽到 railTime.ts 与 RailProjectList 共用
 *（两个 rail 列表的时间节奏必须同源）。 */

/** 列表渲染项：分组标签与会话行拍平进同一个 AnimatePresence，
 * 组内最后一行被删时标签跟着播同一支折叠退场。 */
type RailItem =
  | { kind: 'label'; key: string; text: string }
  | { kind: 'row'; key: string; thread: ThreadSummary }

function buildItems(threads: readonly ThreadSummary[]): RailItem[] {
  const items: RailItem[] = []
  let lastGroup: string | null = null
  for (const t of threads) {
    const g = groupLabel(t.updatedAt)
    if (g !== lastGroup) {
      lastGroup = g
      items.push({ kind: 'label', key: `g:${g}`, text: g })
    }
    items.push({ kind: 'row', key: t.id, thread: t })
  }
  return items
}

/**
 * DropdownMenuItem / ContextMenuItem 的公共形状——两个菜单壳里塞的是
 * 同一组条目，条目只关心这几个 props。
 */
type MenuItemComponent = ComponentType<{
  className?: string
  variant?: 'default' | 'destructive'
  onSelect?: (event: Event) => void
  children?: ReactNode
}>

/**
 * 菜单条目本体（··· 与右键共用）。两项都只做一件事：关掉菜单、打开对应
 * 弹窗（重命名 Dialog / 删除 AlertDialog），真正的动作在根组件里。
 */
function SessionMenuItems({
  Item,
  onRename,
  onDelete
}: {
  Item: MenuItemComponent
  onRename: () => void
  onDelete: () => void
}) {
  return (
    <>
      <Item onSelect={onRename}>
        <Pencil className="size-3.5" /> 重命名
      </Item>
      <Item variant="destructive" onSelect={onDelete}>
        <Trash2 className="size-3.5" /> 删除
      </Item>
    </>
  )
}

export function RailSessionList() {
  const pathname = usePathname()

  // Sessions with an assistant turn in flight — drives the per-row
  // running spinner. Subscribed as a stable comma-joined key (see the
  // hook) and rebuilt into a Set here so row lookups are O(1) and the
  // Set identity only changes when the running set actually changes.
  const runningKey = useRunningSessionIdsKey()
  const runningIds = useMemo(
    () => new Set(runningKey ? runningKey.split(',') : []),
    [runningKey]
  )

  // Sessions whose finished reply the user hasn't seen yet — drives the
  // per-row unread dot. Same stable-key-then-Set pattern as runningIds.
  const unreadKey = useUnreadIdsKey()
  const unreadIds = useMemo(
    () => new Set(unreadKey ? unreadKey.split(',') : []),
    [unreadKey]
  )

  const [threads, setThreads] = useState<readonly ThreadSummary[]>([])
  // 选中态的**权威源**是 chat store 的前台 `sessionId`（chat 与 rail 同一个
  // studio webContents，共享同一份 zustand store）——不是本组件累积的临时
  // state。这一改是「切到工作画布再切回智能助手时选中态丢失」的根治点
  // （2026-07-05）：rail 挂在根 layout 的 surface tab 三元里，切到画布面时
  // RailSessionList 被整块卸载，本地 activeId state 随之蒸发；切回来重新挂载
  // 时初值是 null，而此刻并没有任何一方会重新广播 SHELL_SESSION_SWITCH，
  // 于是旧的「纯 push 累积的 activeId」永远回不到当前会话。改成订阅
  // store.sessionId 后，重挂载首帧即读到权威前台会话，选中态自动恢复。
  //
  // 仍保留本地 activeId 作**乐观覆盖**：点击行时立即高亮（点击 → store
  // sessionId 更新之间冷路径有几十毫秒的 await 间隙，见 FusionRuntimeProvider
  // 的 onSwitchToThread），以及删除当前会话时把选中态即时移交相邻行。store
  // sessionId 随后追上会把 activeId 覆盖成同值（幂等），null 视作「未接管，
  // 跟随 store」。
  const foregroundSessionId = useChatStore((s) => s.sessionId)
  const [optimisticId, setOptimisticId] = useState<string | null>(null)
  // optimisticId 一旦与 store 的前台会话一致（或 store 已切到别的会话），
  // 乐观覆盖的使命就完成了，交还给 store 权威值——否则一次点击后 activeId
  // 会被本地值永久钉住，store 侧的后续切换（如 AI 在别的会话里被切到前台）
  // 反而高亮不到。
  const activeId = optimisticId ?? foregroundSessionId
  useEffect(() => {
    if (optimisticId !== null && optimisticId === foregroundSessionId) {
      setOptimisticId(null)
    }
  }, [optimisticId, foregroundSessionId])
  const [justRenamedId, setJustRenamedId] = useState<string | null>(null)
  // 重命名弹窗：target = 正在改名的会话；draft = 输入框当前值。
  const [renameTarget, setRenameTarget] = useState<ThreadSummary | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  // 删除确认弹窗：target = 待删会话。
  const [deleteTarget, setDeleteTarget] = useState<ThreadSummary | null>(null)

  const reload = useCallback(() => {
    if (typeof window === 'undefined' || !window.tabApi?.listShellSessions) return
    window.tabApi
      .listShellSessions()
      .then((r) => {
        setThreads([...r.threads].sort((a, b) => b.updatedAt - a.updatedAt))
      })
      .catch((err: unknown) => console.warn('[RailSessionList] list failed', err))
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.chatApi) return undefined
    reload()
    // 会话列表刷新订阅【两条都挂】——两条通道由 engine 的同一个
    // `sessionListChanged` 事件驱动，但 fan-out 路径不同：
    //   - SHELL_SESSION_LIST_CHANGED（tabApi）：经 tabRegistry 转发，带
    //     `activeTabId === 本 tab` 守卫（多 tab 时只刷前台）。
    //   - SESSION_LIST_CHANGED（chatApi）：engine 直接 send 到自己的
    //     webContents，【无条件】。chat 面的 threadList 一直用这条且实时
    //     生效，rail 只挂了带守卫的那条——AI 回复中途 shell fan-out 那条
    //     偶发不到位时，rail 就停在旧时间不刷新（2026-07-05：ppt 会话回复
    //     中 rail 时间卡在「7 分钟前」不动的根因）。补挂无条件的这条兜底，
    //     两条都触发 reload（reload 幂等，重复拉一次无害）。
    const offShellList = window.tabApi?.onShellSessionListChanged?.(reload)
    const offEngineList = window.chatApi.onSessionListChanged?.(reload)
    // 切换事件回流时同步高亮——无论切换是本组件发起（点击项）还是 chat
    // 页面内部发起后经 main 正规化，最终都汇到这一个事件上。切到哪个会话
    // 即视为看过它的回复，顺手清掉该会话的未读标记（这是权威清除点，
    // 覆盖所有切换来源）。
    const offSwitch = window.chatApi.onShellSessionSwitch?.((id) => {
      // 乐观抢跑：切换回流时 store.sessionId 多半已同步，但冷路径下
      // FusionRuntimeProvider 还在 await loadSession，这一帧先高亮到位。
      setOptimisticId(id)
      if (id) useUnreadStore.getState().clearUnread(id)
    })
    return () => {
      offShellList?.()
      offEngineList?.()
      offSwitch?.()
    }
  }, [reload])

  const goChat = useCallback(() => {
    // shallow pushState 而非 router.push：两面常驻 SurfaceHost、page 是
    // 空壳，Next 无需做任何导航工作（见 AppRail goChatShallow 注释）。
    if (!pathname.startsWith('/chat')) window.history.pushState(null, '', '/chat')
  }, [pathname])

  /** 点击行：高亮 + 导航到聊天 + 通知 main 切 runtime + 清未读。 */
  const switchTo = useCallback(
    (id: string | null) => {
      setOptimisticId(id)
      if (id) useUnreadStore.getState().clearUnread(id)
      goChat()
      void window.tabApi?.switchShellSession?.(id)
    },
    [goChat]
  )

  /* ── 重命名：shadcn Dialog ── */

  const openRename = useCallback((t: ThreadSummary) => {
    setRenameDraft(t.title)
    setRenameTarget(t)
  }, [])

  // 弹窗开后聚焦全选输入框（等 radix 菜单关闭抢完焦点，与内容挂载对齐）。
  useEffect(() => {
    if (!renameTarget) return undefined
    const timer = window.setTimeout(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [renameTarget])

  const commitRename = useCallback(() => {
    const target = renameTarget
    const title = renameDraft.trim()
    if (!target) return
    // 无变化/清空视作取消，直接关窗不打 IPC。
    if (!title || title === target.title) {
      setRenameTarget(null)
      return
    }
    setRenameTarget(null)
    // 乐观：行文字立即更新并播微光；rename 的 sessionListChanged 广播随后
    // 从磁盘重新导出同一个值（失败时 reload 拉回真实标题）。
    setThreads((prev) => prev.map((t) => (t.id === target.id ? { ...t, title } : t)))
    setJustRenamedId(target.id)
    window.setTimeout(
      () => setJustRenamedId((cur) => (cur === target.id ? null : cur)),
      FLASH_MS
    )
    void window.tabApi
      ?.renameShellSession?.({ sessionId: target.id, title })
      .then(reload)
      .catch((err: unknown) => {
        console.warn('[RailSessionList] rename failed', err)
        reload()
      })
  }, [renameTarget, renameDraft, reload])

  /* ── 删除：shadcn AlertDialog ── */

  const performDelete = useCallback(
    (target: ThreadSummary) => {
      setDeleteTarget(null)
      const idx = threads.findIndex((t) => t.id === target.id)
      if (idx < 0) return
      const rest = threads.filter((t) => t.id !== target.id)
      // 乐观移除驱动折叠退场动画；IPC 失败时 reload 把行拉回来。
      setThreads(rest)
      if (activeId === target.id) {
        // 选中态移交相邻行（原型 handleActiveHandoff）：优先同位置的下一
        // 行，删的是末行则前一行，删空则回「新对话」。只移交 runtime
        // 指针，不做路由跳转——在画布页删会话不该被拽去聊天页。
        const next = rest[Math.min(idx, rest.length - 1)] ?? null
        setOptimisticId(next?.id ?? null)
        void window.tabApi?.switchShellSession?.(next?.id ?? null)
      }
      void window.tabApi
        ?.deleteShellSession?.({ sessionId: target.id })
        .then(reload)
        .catch((err: unknown) => {
          console.warn('[RailSessionList] delete failed', err)
          reload()
        })
    },
    [threads, activeId, reload]
  )

  if (threads.length === 0) {
    // 空态（含浏览器直开的无 chatApi 场景）：不渲染占位骨架——rail 上一块
    // 空白比一块假列表诚实。
    return null
  }

  const items = buildItems(threads)

  return (
    // reducedMotion="user"：折叠退场尊重系统「减弱动态效果」，
    // 与 chat App 的 MotionConfig 行为一致（rail 挂在 layout，不在那棵树里）。
    <MotionConfig reducedMotion="user">
      {/* 无「对话」标题（shell-floating 原型）：分组标签（今天/昨天/…）
        * 自己就是节奏，多一行总标题只会把 rail 撑得更碎。 */}
      <div className="flex min-h-0 flex-1 flex-col pt-2">
        {/* [&>…]:block!：Radix ScrollArea 的 Viewport 会把 children 包进一层
          * `display:table; min-width:100%` 的 div——table 按 max-content 撑宽，
          * 长标题会把整行撑出 rail 右缘（时间标签被顶出去、truncate 失效，
          * 标题硬切无省略号，2026-07-04 实锤）。纯竖向列表不需要 table 的
          * 横向内容测量，强制回 block 让行宽回归容器约束；带 ! 是因为
          * display:table 写在 Radix 的 inline style 上。
          *
          * 右侧 -mr-3 而非对称 -mx-1（2026-07-05 用户要求「滚动条贴右缘」）：
          * overlay 滚动条定位在 ScrollArea 容器右缘，而 AppRail 的 nav 有
          * px-3（右 12px）把列表推离 rail 右缘。右负外边距吃满这 12px，让
          * 滚动条容器右缘 = rail 右缘 = 内容卡左缘，滚动条紧贴内容不留缝。
          * 左侧仍 -ml-1（选中行圆角背景略往左伸的呼吸），故拆成不对称。 */}
        <ScrollArea className="-ml-1 -mr-3 min-h-0 flex-1 pl-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
          {/* pr-3：滚动条贴到容器右缘后，行文字 truncate 到右缘会被 10px 宽
              的 overlay 滚动条盖住尾巴——内容侧留出 ≥滚动条宽度的右 padding
              让文字避开（这段 padding 落在 ScrollArea 容器内、滚动条之内）。 */}
          <ul className="flex flex-col pr-3">
            <AnimatePresence initial={false}>
              {items.map((item) =>
                item.kind === 'label' ? (
                  <motion.li
                    key={item.key}
                    layout="position"
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: railEaseOut }}
                    // 分组标签是列表的呼吸位：字号压到 11px、透明度降档、上方
                    // 留足空（pt-5）让组与组之间有明确的段落感——行墙太密正是
                    // 「丑」的主因之一。
                    className="overflow-hidden px-3 pb-1.5 pt-5 text-[11px] font-medium text-muted-foreground/70 first:pt-1.5"
                  >
                    {item.text}
                  </motion.li>
                ) : (
                  <SessionRow
                    key={item.key}
                    thread={item.thread}
                    active={item.thread.id === activeId}
                    running={runningIds.has(item.thread.id)}
                    unread={unreadIds.has(item.thread.id)}
                    justRenamed={item.thread.id === justRenamedId}
                    onSwitch={() => switchTo(item.thread.id)}
                    onStartRename={() => openRename(item.thread)}
                    onStartDelete={() => setDeleteTarget(item.thread)}
                  />
                )
              )}
            </AnimatePresence>
          </ul>
        </ScrollArea>
      </div>

      {/* 重命名弹窗（列表级单实例）：open 由 renameTarget 是否为 null 驱动。 */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              commitRename()
            }}
          >
            <DialogHeader>
              <DialogTitle>重命名对话</DialogTitle>
              <DialogDescription>为这个对话起一个新名字。</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 py-4">
              <Label htmlFor="rail-rename-input" className="sr-only">
                对话名称
              </Label>
              <Input
                id="rail-rename-input"
                ref={renameInputRef}
                value={renameDraft}
                maxLength={200}
                name="rename-session"
                autoComplete="off"
                placeholder="输入新名称"
                onChange={(e) => setRenameDraft(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRenameTarget(null)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  !renameDraft.trim() ||
                  renameDraft.trim() === renameTarget?.title
                }
              >
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗（列表级单实例）：危险动作走 AlertDialog + destructive。 */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这个对话？</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `「${displayTitle(deleteTarget.title)}」及其消息将被删除，此操作无法撤销。`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20"
              onClick={() => deleteTarget && performDelete(deleteTarget)}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MotionConfig>
  )
}

/**
 * 单个会话行。两态：常规（标题 + hover 浮现 ···）、选中（目标行上的中性
 * 灰底 + 品牌绿圆点，即时呈现）。重命名/删除都改走列表级弹窗，行本身不再
 * 承载行内编辑与上膛态（2026-07-05）。
 */
function SessionRow({
  thread,
  active,
  running,
  unread,
  justRenamed,
  onSwitch,
  onStartRename,
  onStartDelete
}: {
  thread: ThreadSummary
  active: boolean
  running: boolean
  unread: boolean
  justRenamed: boolean
  onSwitch: () => void
  onStartRename: () => void
  onStartDelete: () => void
}) {
  return (
    <motion.li
      layout="position"
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.22, ease: railEaseOut }}
      className="overflow-hidden"
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group relative">
            {active && (
              // 选中底：中性灰（shell-floating 原型的用色纪律：绿只给 CTA
              // 与选中「点」记号，选中面本身不上色）。曾是 layoutId 共享的
              // motion 滑块（切换时在行间做 FLIP 滑动），2026-07-04 应用户
              // 要求退役——切换即时呈现，普通 span 直接画在目标行。
              <span
                aria-hidden
                className="absolute inset-0 rounded-lg bg-sidebar-accent"
              />
            )}
            {/* shadcn Button 而非裸 <button>：canvas 的裸元素 reset 守卫
                （canvas/index.css）只豁免 [data-slot] 与 .chat-app 子树，
                rail 挂在根 layout、两个豁免都不覆盖——裸 button 会被 reset
                填成白底描边卡片（2026-07-03 实锤）。rail/全局层的交互元素
                一律用 shadcn 原语，靠 data-slot 拿豁免。 */}
            <Button
              type="button"
              variant="ghost"
              onClick={onSwitch}
              title={thread.firstPrompt ?? thread.title}
              className={cn(
                // h-8（32px，原型 .session-row）：36px 行配 13px 字在长列表里
                // 显得松散又占地，32px 才是「工具列表」的密度。
                'relative flex h-8 w-full items-center justify-start gap-2 rounded-lg px-3 text-left text-[13px] font-normal transition-colors',
                justRenamed && 'just-renamed',
                active
                  ? // 选中态文字回中性前景（滑块已是中性灰），身份记号交给
                    // 下面的品牌绿圆点——shell-floating 原型的选中语言。
                    'font-medium text-sidebar-foreground hover:bg-transparent hover:text-sidebar-foreground'
                  : // 实色 sidebar-accent（原型 .row:hover 的 rail-hover 同款）：
                    // 60% 透明版叠在灰 rail 上若隐若现，反馈感太弱。
                    'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-foreground'
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'size-[5px] shrink-0 rounded-full transition-colors',
                  active ? 'bg-sidebar-primary' : 'bg-transparent'
                )}
              />
              <span className="min-w-0 flex-1 truncate">{displayTitle(thread.title)}</span>
              {/* 行右侧状态，三选一，都在行内流、hover / 菜单打开时淡出让位给
                * 绝对定位的 ···（原型 .time 的 display:none on hover）：
                *  1. 运行中：旋转 spinner（品牌绿，与聊天区 ThinkingSpinner
                *     同色）——「正在运行」比「2 小时前」更该被看到；
                *  2. 未读：AI 回复已完成但用户还没看过（回合在非前台会话结束），
                *     蓝色小圆点，切到该会话即清除；
                *  3. 否则：相对时间。
                * running 与 unread 天然互斥（未读只在回合结束后出现，那时已不
                * running），故按此优先级排布。 */}
              {running ? (
                <span
                  className="flex shrink-0 items-center text-brand transition-opacity group-hover:opacity-0 group-has-[[data-state=open]]:opacity-0"
                  aria-label="任务运行中"
                  title="任务运行中"
                >
                  <Loader2 className="size-3.5 animate-spin" />
                </span>
              ) : unread ? (
                <span
                  className="flex shrink-0 items-center transition-opacity group-hover:opacity-0 group-has-[[data-state=open]]:opacity-0"
                  aria-label="有未读回复"
                  title="有未读回复"
                >
                  <span className="size-2 rounded-full bg-[#3b82f6]" />
                </span>
              ) : (
                <span className="shrink-0 text-[11px] font-normal text-muted-foreground/70 transition-opacity group-hover:opacity-0 group-has-[[data-state=open]]:opacity-0">
                  {relativeTime(thread.updatedAt)}
                </span>
              )}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="会话操作"
                  className="absolute right-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[9rem]">
                <SessionMenuItems
                  Item={DropdownMenuItem}
                  onRename={onStartRename}
                  onDelete={onStartDelete}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-[9rem]">
          <SessionMenuItems
            Item={ContextMenuItem}
            onRename={onStartRename}
            onDelete={onStartDelete}
          />
        </ContextMenuContent>
      </ContextMenu>
    </motion.li>
  )
}
