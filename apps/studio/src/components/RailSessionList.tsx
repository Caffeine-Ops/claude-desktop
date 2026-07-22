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
 *  - 选中态即时呈现（无滑动动画，2026-07-04 退役），删除行即时消失（折叠
 *    退场动画随虚拟滚动退役，2026-07-16——AnimatePresence 需要被删节点留在
 *    DOM 播完退场，与虚拟化冲突），删的是当前会话时选中态移交相邻行。
 *  - 列表虚拟滚动（@tanstack/react-virtual，2026-07-16）：几百条会话时只
 *    渲染可视区十几行，重渲成本与会话总数解耦，细节见渲染处注释。
 *
 * 本组件不 import 任何模块求值期会触碰 window 的 src/chat/ 模块（那会
 * 破坏所在 layout 的 SSR）；railMotion 是纯常量模块，属安全例外——rail
 * 的动效节奏必须与聊天区同源，不复制数值。一切数据在 useEffect 里经
 * window.chatApi / tabApi 获取，浏览器直开（无 chatApi）时整块渲染为空。
 *
 * 列表数据（threads/loaded）住在 stores/railSessions.ts 的模块级 zustand
 * store 而非本组件 state——本组件随 chat ↔ 画布切面整块卸载，本地 state
 * 会归零导致每次切回都骨架屏重加载（2026-07-08）；store 跨挂载存活，
 * 重挂载首帧直接渲染缓存，挂载 effect 的 reload 只做后台静默校正。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import {
  Clapperboard,
  Copy,
  FileText,
  Folder,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2
} from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ComponentType, ReactNode } from 'react'
import type { ThreadSummary } from '@desktop-shared/types'

import { rememberCanvasPath } from '@/src/stores/canvasNav'
import { hasSurfaceOverlay, useSurfaceOverlayStore } from '@/src/stores/surfaceOverlay'
import { stripMessageMarker } from '@/src/chat/lib/messageMarkers'
import { condenseFileMentions } from '@/src/chat/lib/mentionDisplay'
import { useChatStore, useRunningSessionIdsKey } from '@/src/chat/stores/chat'
import { usePendingPermissionKindsBySession } from '@/src/chat/stores/permissions'
import { useRailSessionsStore } from '@/src/chat/stores/railSessions'
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
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/src/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
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
 * 的语义。展示层归一化成可读文本，按优先级处理四种形态：
 *
 *  0. **消息内嵌协议标记**（`[[sheet-selection]]{...}` / `[[image-edit]]
 *     {...}`）——表格「框选问 AI」、图片标记编辑面板发出的消息，firstPrompt
 *     是完整 CLI 文本（marker JSON + 提示语 + TSV/编辑指令），不剥离会把
 *     整段 JSON 糊满整行（2026-07-13 事故：表格框选消息把 rail 行和顶栏
 *     标题都撑成了一整条 JSON）。用 stripMessageMarker 换成人类可读的
 *     问题/备注短文本。
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
 * 展示；行 title 属性也过同一层归一化（见下方 title={displayTitle(...)}），
 * 避免 hover tooltip 把未剥离的原始 marker JSON 全量吐出来。
 */
function displayTitle(raw: string): string {
  const marked = stripMessageMarker(raw)
  const t = marked.trim()
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
    if (rest) return condenseFileMentions(rest)
    return m[1].slice(1).split(':').pop() || UNTITLED_LABEL
  }

  // 形态 3：普通文本。`@"path"` mention 压成 basename（内联附件的首条
  // 消息标题原本是一整条绝对路径，rail 行放不下），规则同气泡/头部标题。
  return condenseFileMentions(t)
}

/* groupLabel / relativeTime 抽到 railTime.ts 与 RailProjectList 共用
 *（两个 rail 列表的时间节奏必须同源）。 */

/** 列表渲染项：分组标签与会话行拍平成一维数组喂给虚拟滚动
 * （useVirtualizer 按 index 取项、按 kind 分别渲染）。 */
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
  variant?: 'default' | 'destructive'
  onSelect?: (event: Event) => void
  children?: ReactNode
}>

/** 与 MenuItemComponent 同理的 Separator 公共形状（两个 radix 壳各有一个）。 */
type MenuSeparatorComponent = ComponentType<object>

/**
 * 菜单条目本体（··· 与右键共用）。两项都只做一件事：关掉菜单、打开对应
 * 弹窗（重命名 Dialog / 删除 AlertDialog），真正的动作在根组件里。
 * 重命名与删除之间加分隔线——危险操作与普通操作分组是 macOS 菜单惯例，
 * 也让红色的「删除」不再直接压在「重命名」底下显得扎眼。
 */
function SessionMenuItems({
  Item,
  Separator,
  onRename,
  onExportReplay,
  onViewJsonl,
  onCopyJsonlPath,
  onDelete
}: {
  Item: MenuItemComponent
  Separator: MenuSeparatorComponent
  onRename: () => void
  onExportReplay: () => void
  onViewJsonl: () => void
  onCopyJsonlPath: () => void
  onDelete: () => void
}) {
  return (
    // 样式零覆盖：菜单精修档（13.5px 条目 / rounded-xl 容器 / 双层投影）
    // 已是 ui/dropdown-menu、ui/context-menu 基件默认（2026-07-08 晋升，
    // 见 dropdown-menu.tsx 头注释）。图标 1.75 笔画与账户菜单同款。
    <>
      <Item onSelect={onRename}>
        <Pencil strokeWidth={1.75} /> 重命名
      </Item>
      <Item onSelect={onExportReplay}>
        <Clapperboard strokeWidth={1.75} /> 导出为演示
      </Item>
      <Item onSelect={onViewJsonl}>
        <FileText strokeWidth={1.75} /> 查看 jsonl
      </Item>
      <Item onSelect={onCopyJsonlPath}>
        <Copy strokeWidth={1.75} /> 复制 jsonl 路径
      </Item>
      <Separator />
      <Item variant="destructive" onSelect={onDelete}>
        <Trash2 strokeWidth={1.75} /> 删除
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

  // Sessions blocked on the user：权限批准（approval）或 AskUserQuestion
  // 回答（question）。驱动行右侧的「等待批准/等待回答」pill——等待时
  // running spinner 的「正在干活」是误报，pill 优先级最高。useShallow
  // 版 Record，只有某会话的 kind 变化才重渲。
  const awaitingKinds = usePendingPermissionKindsBySession()

  // Sessions whose finished reply the user hasn't seen yet — drives the
  // per-row unread dot. Same stable-key-then-Set pattern as runningIds.
  const unreadKey = useUnreadIdsKey()
  const unreadIds = useMemo(
    () => new Set(unreadKey ? unreadKey.split(',') : []),
    [unreadKey]
  )

  // 列表数据与首拉标记都在模块级 store（跨挂载缓存，语义见 railSessions.ts
  // 头注释）。threads 引用只在 store set 时更换，selector 直接返回字段安全
  // （不是每次 new 的派生对象，无 getSnapshot 循环风险）。
  const threads = useRailSessionsStore((s) => s.threads)
  const loaded = useRailSessionsStore((s) => s.loaded)
  // zustand action 引用终身稳定，可直接进 effect deps。
  const reload = useRailSessionsStore((s) => s.reload)
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
  //
  // 有面盖着时（插件市场 / 知识库）**一个会话都不高亮**（activeId = null）：
  // 此刻内容区根本不是那个会话，留着高亮等于骗人——rail 的「当前位置」指示交给
  // 那个面自己的入口按钮的选中态（见 AppRail）。前台会话本身没变，关掉面（点
  // 会话/切面）高亮立刻回来，这里只是不显示。2026-07-17 用户实锤：「如果当前是
  // 插件，会话应该取消选中状态，选中状态应该在插件」。
  // selector 直接返回 boolean（不是 kind）：换面时不必让整条列表跟着重渲染。
  const overlayOpen = useSurfaceOverlayStore((s) => s.open !== null)
  const activeId = overlayOpen ? null : (optimisticId ?? foregroundSessionId)
  useEffect(() => {
    if (optimisticId !== null && optimisticId === foregroundSessionId) {
      setOptimisticId(null)
    }
  }, [optimisticId, foregroundSessionId])
  const [justRenamedId, setJustRenamedId] = useState<string | null>(null)
  // 重命名弹窗：target = 正在改名的会话；draft = 输入框当前值。
  const [renameTarget, setRenameTarget] = useState<ThreadSummary | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // 打开弹窗那一刻的预填值，作为「用户到底改没改」的比较基准。不能拿
  // ThreadSummary.title 当基准——预填的是 displayTitle() 归一化后的行文字，
  // 跟原文天然不相等，用原文比会把「打开就点保存」判成真改名（同 ChatHeader
  // 那个弹窗的 initialDraftRef）。
  const renameInitialRef = useRef('')
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  // 删除确认弹窗：target = 待删会话。
  const [deleteTarget, setDeleteTarget] = useState<ThreadSummary | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.chatApi) {
      // 同 reload 里的兜底：无宿主桥（浏览器直开）永远等不来数据，
      // 直接判定为空态，别让骨架屏挂死。
      useRailSessionsStore.setState({ loaded: true })
      return undefined
    }
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
    // TODO(debug 2026-07-08): 同上，事件到达打点，定位后连箭头函数一起还原。
    const offShellList = window.tabApi?.onShellSessionListChanged?.(() => {
      console.log('[RailSessionList] evt: SHELL_SESSION_LIST_CHANGED')
      reload()
    })
    const offEngineList = window.chatApi.onSessionListChanged?.(() => {
      console.log('[RailSessionList] evt: SESSION_LIST_CHANGED')
      reload()
    })
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
    // 切走前记住画布路径（2026-07-14，删多标签栏连带修复）：这也是「从画布
    // 切到聊天」的入口之一，不记的话切回画布会用陈旧的 lastCanvasPath。
    const onChat = pathname.startsWith('/chat')
    // 已在聊天面**且**没有面（插件市场/知识库）盖着 → 真 no-op。
    // 面开关（?market=1 / ?kb=1）挂在当前 pathname 上，开在聊天面时 pathname
    // 仍是 '/chat'——只判 pathname 的话这里直接 return，参数不被剥掉、面继续
    // 盖着，用户点会话「没反应」（2026-07-17 用户实锤）。pushState('/chat')
    // 写死路径不带 query，天然剥掉所有面开关。同族陷阱见 AppRail 的 goSurface。
    if (onChat && !hasSurfaceOverlay()) return
    if (!onChat) rememberCanvasPath()
    window.history.pushState(null, '', '/chat')
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

  // 预填 = rail 行此刻显示的那行文字，不是 ThreadSummary.title 原文
  // （2026-07-17 用户要求，同 ChatHeader 的重命名弹窗）。原文可能是命令
  // XML、裸 slash 命令、或整条绝对路径——displayTitle 已经把这些归一化成
  // 人话摆在行上了，弹窗不该再把原文摊开让用户对着它改。
  // 兜底文案（「新对话」）预填空串，让 placeholder 出场。
  const openRename = useCallback((t: ThreadSummary) => {
    const shown = displayTitle(t.title)
    const prefill = shown === UNTITLED_LABEL ? '' : shown
    setRenameDraft(prefill)
    renameInitialRef.current = prefill
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
    // 无变化/清空视作取消，直接关窗不打 IPC。基准是打开时的预填值而不是
    // target.title 原文——理由见 renameInitialRef。没动过就原样留着原文
    // （行上渲染出来的文字一模一样，用户看不出差别，也没白丢命令前缀/路径）。
    if (!title || title === renameInitialRef.current) {
      setRenameTarget(null)
      return
    }
    setRenameTarget(null)
    // 乐观：行文字立即更新并播微光；rename 的 sessionListChanged 广播随后
    // 从磁盘重新导出同一个值（失败时 reload 拉回真实标题）。
    useRailSessionsStore.getState().applyRename(target.id, title)
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
      useRailSessionsStore.getState().applyRemove(target.id)
      if (activeId === target.id) {
        // 选中态移交相邻行（原型 handleActiveHandoff）：优先同位置的下一
        // 行，删的是末行则前一行，删空则回「新对话」。只移交 runtime
        // 指针，不做路由跳转——在画布页删会话不该被拽去聊天页。
        const next = rest[Math.min(idx, rest.length - 1)] ?? null
        setOptimisticId(next?.id ?? null)
        void window.tabApi?.switchShellSession?.(next?.id ?? null)
      }
      // 删除 IPC 的收尾走墓碑集协议（2026-07-16）：
      //  - applyRemove 已把行乐观折叠 + 把 id 记进墓碑，删盘的 ~1.2s 窗口期内
      //    任何来源的 reload 都会过滤掉这个 id，不会让已删行复活（此前的 bug：
      //    cli 退出等无关事件的并发 reload 拿到还没删完的磁盘旧列表，把乐观
      //    移除覆盖回来，删除的会话短暂又冒出来）。
      //  - 成功 → confirmRemove 摘墓碑：此刻磁盘已删，且 main 已 emit
      //    sessionListChanged，fan-out 的 reload 会拿到不含它的权威列表；不再
      //    显式 .then(reload)（那会叠加成一次删除多趟扫盘）。
      //  - 失败 → cancelRemove 摘墓碑 + reload，把误删移除的行从磁盘拉回来。
      const store = useRailSessionsStore.getState()
      void window.tabApi
        ?.deleteShellSession?.({ sessionId: target.id })
        .then(() => store.confirmRemove(target.id))
        .catch((err: unknown) => {
          console.warn('[RailSessionList] delete failed', err)
          store.cancelRemove(target.id)
        })
    },
    [threads, activeId, reload]
  )

  /* ── 导出为演示：main 弹保存框写 .claudereplay ── */

  const performExportReplay = useCallback(async (target: ThreadSummary) => {
    // slides 模式标记住在带 persist 的 chat store（composerMode）——本文件
    // 禁止静态 import 求值期碰 window 的模块（SSR 约束，见头注释），动态
    // import 在点击时才加载，安全。
    let mode: 'slides' | undefined
    try {
      const { useComposerModeStore } = await import(
        '../chat/stores/composerMode'
      )
      mode = useComposerModeStore.getState().slidesSessions[target.id]
        ? 'slides'
        : undefined
    } catch {
      /* 读不到标记就不带 mode——回放退化为单栏，不阻塞导出 */
    }
    void window.chatApi
      ?.exportReplay({
        sessionId: target.id,
        title: displayTitle(target.title),
        ...(mode ? { mode } : {})
      })
      .then((r) => {
        // 成功反馈 = 直接在 Finder 里定位导出的文件（比任何提示都直观）；
        // 取消（path:null）静默。失败仅记日志——保存对话框已给过用户交互，
        // rail 这层没有常驻消息位可用。
        if (r.ok && r.path) {
          void window.chatApi.revealPath({ absPath: r.path })
        } else if (!r.ok) {
          console.warn('[RailSessionList] exportReplay failed:', r.error)
        }
      })
      .catch((err: unknown) => {
        console.warn('[RailSessionList] exportReplay error:', err)
      })
  }, [])

  /* ── 查看 jsonl：main 全局扫 ~/.claude/projects/ 找到会话原始 transcript
   * 后用 vscode://file URI 交给 VS Code 打开（2026-07-20 用户要求，此前
   * 是系统默认程序——.jsonl 没有稳定默认关联，体验不可控）。找不到文件/
   * VS Code 未安装/打开失败都只记日志——菜单点击即发即弃，rail 没有常驻
   * 消息位。 */
  const performViewJsonl = useCallback((target: ThreadSummary) => {
    void window.chatApi
      ?.openSessionJsonl({ sessionId: target.id })
      .then((r) => {
        if (r.error) {
          console.warn('[RailSessionList] openSessionJsonl failed:', r.error)
        }
      })
      .catch((err: unknown) => {
        console.warn('[RailSessionList] openSessionJsonl error:', err)
      })
  }, [])

  /* ── 复制 jsonl 路径：跟查看 jsonl 同一套 main 侧定位逻辑，只是不
   * shell.openPath，而是把绝对路径写进剪贴板（navigator.clipboard，同
   * WrittenFilesPanel.tsx 的既有用法）。菜单点击即发即弃，没有常驻消息位
   * 展示成功/失败——与本文件其它菜单动作同一惯例，失败只记日志。 ── */
  const performCopyJsonlPath = useCallback((target: ThreadSummary) => {
    void window.chatApi
      ?.getSessionJsonlPath({ sessionId: target.id })
      .then((r) => {
        if (!r.path) {
          console.warn('[RailSessionList] getSessionJsonlPath failed:', r.error)
          return
        }
        void navigator.clipboard.writeText(r.path).catch((err: unknown) => {
          console.warn('[RailSessionList] clipboard write failed:', err)
        })
      })
      .catch((err: unknown) => {
        console.warn('[RailSessionList] getSessionJsonlPath error:', err)
      })
  }, [])

  // items 随 threads 变化才重建（useMemo）：虚拟化后组件会在每个滚动帧
  // 重渲（getVirtualItems 变化驱动），不能每帧重跑 O(n) 的 buildItems。
  const items = useMemo(() => buildItems(threads), [threads])

  /* ── 虚拟滚动（2026-07-16，@tanstack/react-virtual）──
   *
   * 会话到几百条后全量渲染是切换卡顿的大头：每次列表重渲都要 diff/commit
   * 全部行。虚拟化后只渲染可视区 ±overscan 的十几行，重渲成本与会话总数
   * 解耦。配套取舍：
   *  - 删除行的 Framer 折叠退场动画退役（AnimatePresence 需要被删节点留在
   *    DOM 播完退场，与「滚出可视区即卸载」的虚拟化模型天然冲突；虚拟项的
   *    translateY 定位也会和 motion 的 layout 动画争抢 transform）。删除
   *    即时消失，用户已确认「优先流畅、简化动画」。
   *  - 滚动容器仍是 Radix ScrollArea——virtualizer 只要求拿到真正 overflow
   *    的元素（Viewport，经 viewportRef 透出），滚动条外观不变。
   *  - label（分组标签，~40px）与 row（32px）高度不同 → estimateSize 按
   *    kind 给初值，measureElement 渲染后实测校正（首个 label 的 pt-1.5
   *    与后续 pt-5 的差异也靠实测覆盖）。
   *  - getItemKey 用 items 的稳定 key（label=`g:组名`、row=会话 id）——
   *    尺寸缓存跟着 key 走，删行/重排后不会把旧行的高度错配到新行上。
   */
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => viewportRef.current,
    // row 36 = 32（h-8 行本身）+ 4（li 的 pb-1 行间距，见下方 li 注释）。
    // 必须跟 li 的实测高度对齐：estimateSize 只管**尚未挂载**的项，估矮了
    // totalSize 偏小、滚动条比例失真，滚过去被 measureElement 修正时位置还会跳。
    estimateSize: (i) => (items[i]?.kind === 'label' ? 40 : 36),
    getItemKey: (i) => items[i].key,
    overscan: 8
  })

  if (threads.length === 0) {
    // 首次拉取还在路上：骨架屏占位（2026-07-07 用户反馈——启动时 rail
    // 空白一拍像坏了）。loaded 在 store 里跨挂载持久，这块骨架只在应用
    // 启动后的第一次拉取出现，切面重挂载直接渲染缓存列表。只有确认
    // 「真的没有会话」（含浏览器直开的无 chatApi 场景）才渲染空白——
    // 那时空白比一块假列表诚实。
    if (!loaded) return <RailSessionSkeleton />
    return null
  }

  return (
    <>
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
          * 左侧仍 -ml-1（选中行圆角背景略往左伸的呼吸），故拆成不对称。
          *
          * 左净空 pl-1 必须落在 li 上、不能留在这里（2026-07-17）：Viewport
          * 是 overflow-x:hidden 的裁剪盒，而这条 pl-1 是它**外面**的 padding
          * ——4px 全被吃在裁剪边界之外，等于把 Viewport 左缘又推回与行左缘
          * 重合（实测 -ml-1 让本容器 left=8，pl-1 又把 Viewport 推到 12 =
          * 行 left），-ml-1 白扩、focus ring（shadcn 的 ring-[3px]，向外 3px）
          * 左半被裁；右侧因 li 自带 pr-3 有 12px 净空所以完好，表现为「环左
          * 边缺一块、右边完整」。挪到 li 后 Viewport 左缘退到 8 成为真正的
          * 裁剪净空，li 的 pl-1 再把行推回 left=12，行几何一分不变。
          * 同 pr-3 的道理：li 是 absolute + w-full，w-full 解析到 ul 的
          * padding box，padding 加在 ul/ScrollArea 上都拦不住它。 */}
        <ScrollArea
          viewportRef={viewportRef}
          className="-ml-1 -mr-3 min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!"
        >
          {/* 虚拟滚动容器：ul 撑起全列表总高度（totalSize，滚动条比例由它
            * 决定），只有可视区 ±overscan 的虚拟项真正挂进 DOM，各自绝对
            * 定位 + translateY 到自己的槽位。li 挂 measureElement 实测行高
            * 回填 virtualizer（data-index 是它的读数协议）。
            * pr-3 从 ul 挪到每个 li：滚动条贴容器右缘后行文字要留出 ≥滚动条
            * 宽度的右 padding 避让（绝对定位子项的 w-full 解析到 ul 的
            * padding box，ul 上的 pr-3 拦不住它们）。 */}
          <ul
            className="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((v) => {
              const item = items[v.index]
              /* pb-1 只给 row：4px 行间距让 hover/选中的灰底读成一块块分离的
               * 卡片，而不是贴死的行墙（2026-07-17 用户要求）。
               * 间距**必须是 padding 不能是 margin**——measureElement 走
               * getBoundingClientRect().height，margin 不在盒内测不到，
               * virtualizer 会按 32px 累加 translateY 让行叠在一起。
               * 灰底由内层 h-8 的 Button/选中 span 画，正好不铺进这 4px，
               * 缝隙透出 rail 底色。label 不加：它自带 pt-5 的组间呼吸。 */
              return (
                <li
                  key={item.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  className={cn(
                    // pl-1：给 focus ring 留出裁剪净空（理由见上方 ScrollArea
                    // 注释）。行/标签的可视左缘仍是 12px——Viewport 左缘退到
                    // 8px，这 4px 正好补回来。
                    'absolute left-0 top-0 w-full pl-1 pr-3',
                    item.kind === 'row' && 'pb-1'
                  )}
                  style={{ transform: `translateY(${v.start}px)` }}
                >
                  {item.kind === 'label' ? (
                    // 分组标签是列表的呼吸位：字号压到 11px、透明度降档、上方
                    // 留足空（pt-5）让组与组之间有明确的段落感——行墙太密正是
                    // 「丑」的主因之一。首个标签收窄到 pt-1.5（原 first:pt-1.5
                    // ——虚拟化后 DOM 首子未必是列表首项，改按 index===0 判定）。
                    <div
                      className={cn(
                        'px-3 pb-1.5 text-[11px] font-medium text-muted-foreground/70',
                        v.index === 0 ? 'pt-1.5' : 'pt-5'
                      )}
                    >
                      {item.text}
                    </div>
                  ) : (
                    // 回调一律传**稳定引用**（switchTo/openRename/… 都是终身稳定
                    // 的 useCallback / setState），thread 也是稳定引用（threads
                    // 数组元素在 reload 未换列时恒等），配合 SessionRow 的 memo
                    // 让高频重渲（滚动帧、running/unread/权限/切换事件）下行
                    // 内容不重渲——虚拟化后组件每个滚动帧都会重渲，没有这层
                    // memo 每帧都要重跑所有可见行（含两次带正则的 displayTitle）。
                    <SessionRow
                      thread={item.thread}
                      active={item.thread.id === activeId}
                      running={runningIds.has(item.thread.id)}
                      awaitingKind={awaitingKinds[item.thread.id]}
                      unread={unreadIds.has(item.thread.id)}
                      justRenamed={item.thread.id === justRenamedId}
                      onSwitch={switchTo}
                      onStartRename={openRename}
                      onExportReplay={performExportReplay}
                      onViewJsonl={performViewJsonl}
                      onCopyJsonlPath={performCopyJsonlPath}
                      onStartDelete={setDeleteTarget}
                    />
                  )}
                </li>
              )
            })}
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
        {/* 精修档（2026-07-08，用户指定 Notion 重命名弹窗样式，替代 07-07 的
          * A 案）：440px 卡 + 大圆角，19px 大标题 / 13px 副文拉开层次，输入框
          * 48px 高 15px 字（安静 focus 与浅色 selection 已在 ui/input.tsx 基件
          * 层修）；取消走 outline 描边、保存走品牌绿渐变（与账户菜单升级钮
          * 同源——用户明确「主题色跟其他保持一致」，否掉 Notion 原版黑钮），
          * disabled 用中性灰而非透明度——「还没改名」要读作待命，不是坏了。
          * 2026-07-19 毛玻璃化，与 ThreadView.tsx 顶栏重命名弹窗同一套
          * className 覆盖（局部覆盖不动共享 DialogContent 基件），保持两处
          * 「同一套精修档」的既有惯例同步。首版 /70 不透明度+blur-2xl 真机
          * CDP 截图核对后发现暗色主题下效果太不明显，改成 /55 + backdrop-
          * brightness-125 提亮背后模糊内容、blur-xl（比 2xl 浅一档，保留纹理
          * 更看得出"透视感"）+ border-white/15 固定白描边（装饰性非语义色，
          * 同保存按钮渐变里的 inset 高光做法），具体理由见 ThreadView.tsx
          * 同处更长的注释。 */}
        <DialogContent className="rounded-2xl border border-white/15 bg-background/55 shadow-[0_24px_70px_-18px_rgba(0,0,0,0.4),0_8px_24px_-12px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-xl backdrop-saturate-150 backdrop-brightness-100 dark:backdrop-brightness-125 sm:max-w-[440px]">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              commitRename()
            }}
          >
            <DialogHeader>
              <DialogTitle className="text-[19px]">重命名对话</DialogTitle>
              <DialogDescription className="text-[13px]">
                保持简短且易于识别
              </DialogDescription>
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
                className="h-12 rounded-xl px-4 text-[15px] md:text-[15px]"
                onChange={(e) => setRenameDraft(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenameTarget(null)}
              >
                取消
              </Button>
              {/* transition-[opacity,box-shadow] 覆盖基件的 transition-all：
                * disabled↔enabled 的底色是「渐变图像 ↔ 灰底」——background-image
                * 不可过渡会瞬跳，color 却吃 transition-all 慢慢变，中间帧=绿底
                * 半灰字（2026-07-07 用户实锤「文字变色有问题」）。颜色切换必须
                * 与背景同步瞬时完成，过渡只留给 hover 的 opacity/阴影。 */}
              <Button
                type="submit"
                // 主按钮跟主题色（2026-07-17 从写死品牌绿改 --accent，同
                // Composer 发送键的理由：这颗按钮是用户动作的确认态，颜色
                // 该跟着设置页选的主题色走，不是固定身份色）。
                className="bg-[linear-gradient(135deg,hsl(var(--accent)),color-mix(in_srgb,hsl(var(--accent))_85%,#000))] text-white shadow-[0_1px_2px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.18)] transition-[opacity,box-shadow] hover:opacity-95 disabled:bg-none disabled:bg-muted disabled:text-muted-foreground/70 disabled:opacity-100 disabled:shadow-none"
                // 只挡空标题，不再挡「没改过」（2026-07-17 用户要求一直可点，
                // 同 ChatHeader 的重命名弹窗）：默认就灰、要先改字才亮的主按钮
                // 读起来像功能坏了。没改内容就点＝commitRename 里短路成取消。
                disabled={!renameDraft.trim()}
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
        {/* 精修档（同重命名弹窗，2026-07-08 Notion 案）：与重命名弹窗同一排版
          * 节奏（大标题 / 副文 / 右下双按钮），07-07 的红 tint 垃圾桶徽章随之
          * 退役——危险语义由红色主按钮 + 标题疑问句承担，会话名加重嵌进副文。
          * 2026-07-19 补毛玻璃化：07-19 重命名弹窗那版收窄范围时特意没带上
          * 删除确认（怕波及全 app 其它 AlertDialog），用户回头点名要这一处
          * 也要玻璃质感，于是原样搬重命名弹窗那份 className 覆盖（/55 不透明
          * 度 + backdrop-brightness-125 提亮 + backdrop-blur-xl + border-
          * white/15 固定白描边），具体理由见 ThreadView.tsx 重命名弹窗同处
          * 长注释。 */}
        <AlertDialogContent className="rounded-2xl border border-white/15 bg-background/55 shadow-[0_24px_70px_-18px_rgba(0,0,0,0.4),0_8px_24px_-12px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-xl backdrop-saturate-150 backdrop-brightness-100 dark:backdrop-brightness-125 sm:max-w-[440px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[19px]">
              删除这个对话？
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[13px] leading-relaxed">
              {deleteTarget ? (
                <>
                  「
                  <span className="font-medium text-foreground">
                    {displayTitle(deleteTarget.title)}
                  </span>
                  」及其消息将被删除，此操作无法撤销。
                </>
              ) : (
                ''
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-[linear-gradient(135deg,hsl(var(--destructive)),color-mix(in_srgb,hsl(var(--destructive))_82%,#000))] text-white shadow-[0_1px_2px_rgba(0,0,0,0.14),inset_0_1px_0_rgba(255,255,255,0.16)] hover:opacity-95 focus-visible:ring-destructive/20"
              onClick={() => deleteTarget && performDelete(deleteTarget)}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * 首次拉取期间的骨架屏。节奏对齐真实列表（分组标签位 + h-8 会话行位），
 * 数据到位后行落在骨架同一坐标上，切换不跳版。条子用 sidebar-accent 语义
 * token（两档主题自适应，rail 上禁裸灰/裸白——2026-07-04 暗档白块教训）；
 * 标题条宽度写死错落值模拟真实标题长短，纯装饰所以 aria-hidden。
 */
const SKELETON_ROW_WIDTHS = ['68%', '52%', '78%', '44%', '60%'] as const

function RailSessionSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col pt-2" aria-hidden>
      <div className="animate-pulse pl-1 pr-3">
        {/* 分组标签占位（对齐真实标签的 px-3 + first:pt-1.5 节奏） */}
        <div className="px-3 pb-2 pt-1.5">
          <div className="h-2.5 w-9 rounded bg-sidebar-accent" />
        </div>
        {SKELETON_ROW_WIDTHS.map((w, i) => (
          <div key={i} className="flex h-8 items-center justify-between gap-2 px-3">
            <div className="h-2.5 rounded bg-sidebar-accent" style={{ width: w }} />
            {/* 行尾时间位的短条 */}
            <div className="h-2 w-7 shrink-0 rounded bg-sidebar-accent/70" />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 单个会话行。两态：常规（标题 + hover 浮现 ···）、选中（目标行上的中性
 * 灰底 + 主题色圆点，即时呈现）。重命名/删除都改走列表级弹窗，行本身不再
 * 承载行内编辑与上膛态（2026-07-05）。
 *
 * memo 包裹（2026-07-16 性能优化）：根组件订阅 running/unread/权限/前台
 * sessionId 四个高频切片，AI 流式回复时会被逐 delta 反复重渲；不 memo 则
 * 每次都重渲**全部**行（每行还跑两次带正则的 displayTitle）。所有 prop
 * 都是原始值或稳定引用（回调由根组件的 useCallback / setState 提供，thread
 * 是 threads 数组元素、reload 未换列时恒等），故默认浅比较即可精确到「只
 * 重渲状态真变了的那一行」。**新增/改 prop 时务必保证它是原始值或稳定
 * 引用**，否则 memo 静默失效、退回全量重渲。
 *
 * 回调签名（onSwitch 收 id、其余收 thread）与根组件的 switchTo/openRename/
 * performExportReplay/setDeleteTarget 直接对齐，行内用 useCallback 自绑
 * thread——绑定后的引用只随 thread/回调变化，配合外层稳定 prop 保持恒等。
 */
const SessionRow = memo(function SessionRow({
  thread,
  active,
  running,
  awaitingKind,
  unread,
  justRenamed,
  onSwitch,
  onStartRename,
  onExportReplay,
  onViewJsonl,
  onCopyJsonlPath,
  onStartDelete
}: {
  thread: ThreadSummary
  active: boolean
  running: boolean
  awaitingKind?: 'approval' | 'question'
  unread: boolean
  justRenamed: boolean
  onSwitch: (id: string) => void
  onStartRename: (thread: ThreadSummary) => void
  onExportReplay: (thread: ThreadSummary) => void
  onViewJsonl: (thread: ThreadSummary) => void
  onCopyJsonlPath: (thread: ThreadSummary) => void
  onStartDelete: (thread: ThreadSummary) => void
}) {
  const awaitingLabel =
    awaitingKind === 'question' ? '等待回答' : '等待批准'
  // 自绑 thread：把根组件传下来的稳定回调与本行的 thread 收敛成零参
  // handler。deps 只有 thread + 对应回调（都稳定），故这些绑定引用也稳定，
  // 不会因父级高频重渲而变。
  const handleSwitch = useCallback(() => onSwitch(thread.id), [onSwitch, thread.id])
  const handleStartRename = useCallback(
    () => onStartRename(thread),
    [onStartRename, thread]
  )
  const handleExportReplay = useCallback(
    () => void onExportReplay(thread),
    [onExportReplay, thread]
  )
  const handleViewJsonl = useCallback(
    () => onViewJsonl(thread),
    [onViewJsonl, thread]
  )
  const handleCopyJsonlPath = useCallback(
    () => onCopyJsonlPath(thread),
    [onCopyJsonlPath, thread]
  )
  const handleStartDelete = useCallback(
    () => onStartDelete(thread),
    [onStartDelete, thread]
  )
  // 不再自带 li 壳：虚拟化后 li（绝对定位 + translateY + measureElement）
  // 由父级的虚拟项 map 统一提供，本组件只渲染行内容。原 motion.li 的折叠
  // 退场随虚拟化退役（2026-07-16，取舍见根组件虚拟滚动注释）。
  return (
    <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group relative">
            {active && (
              // 选中底：中性灰（shell-floating 原型的用色纪律：绿只给 CTA
              // 与选中「点」记号，选中面本身不上色）。曾是 layoutId 共享的
              // motion 滑块（切换时在行间做 FLIP 滑动），2026-07-04 应用户
              // 要求退役——切换即时呈现，普通 span 直接画在目标行。毛玻璃
              // 质感（2026-07-18，跟账户菜单/composer/surface tabs 同一批）：
              // 实底 bg-sidebar-accent 换成半透明 + backdrop-blur。2026-07-20
              // 摘掉 backdrop-blur（亮色主题用户报「没有毛玻璃效果」）：这个
              // span 是 `.app-rail` 的后代，壁纸开启时 rail 自身已经是
              // backdrop-filter: blur(20px)...（background-art.css），这里
              // 再叠一层等于嵌套模糊两次——跟 AppRail.tsx 的 surface tabs
              // thumb 同一条纪律（那边有更长的解释）。摘掉后只剩半透明色，
              // 透出 rail 那层已经模糊好的结果就够了，不需要重复模糊。
              <span
                aria-hidden
                className="absolute inset-0 rounded-lg bg-sidebar-accent/55"
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
              onClick={handleSwitch}
              title={displayTitle(thread.firstPrompt ?? thread.title)}
              className={cn(
                // h-8（32px，原型 .session-row）：36px 行配 13px 字在长列表里
                // 显得松散又占地，32px 才是「工具列表」的密度。
                'relative flex h-8 w-full items-center justify-start gap-2 rounded-lg px-3 text-left text-[13px] font-normal transition-colors',
                justRenamed && 'just-renamed',
                active
                  ? // 选中态文字回中性前景（滑块已是中性灰），身份记号交给
                    // 下面的圆点。2026-07-19 从跟主题走的 --primary 改成固定
                    // 品牌绿 --brand（用户实锤要跟 Composer 工作区切换弹层
                    // 的绿勾同一个颜色）——主题色可能跟 sidebar 底色撞色到
                    // 看不清，brand 绿不跟用户主题走，识别度恒定。
                    'font-medium text-sidebar-foreground hover:bg-transparent hover:text-sidebar-foreground'
                  : // hover 底毛玻璃化（2026-07-19，同选中态 2026-07-18 那批
                    // /55 配方）：原实色 sidebar-accent 曾是刻意选择（60% 透明
                    // 版叠在灰 rail 上若隐若现，反馈感太弱），但那是选中态
                    // 玻璃化之前的判断——现在选中滑块已是玻璃底，hover 态保持
                    // 实色会两态质感不一致（悬停到「菜单收起后仍留在行上」的
                    // 常见场景尤其明显），故跟进同款半透明。不带 backdrop-blur
                    // （2026-07-20 摘掉，理由同上面选中底那段注释——`.app-rail`
                    // 自身已经模糊过一次，这里不需要再模糊）。
                    'text-sidebar-foreground/75 hover:bg-sidebar-accent/55 hover:text-sidebar-foreground'
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'size-[5px] shrink-0 rounded-full transition-colors',
                  active ? 'bg-brand' : 'bg-transparent'
                )}
              />
              <span className="min-w-0 flex-1 truncate">{displayTitle(thread.title)}</span>
              {/* 工作区徽标（统一会话管理）：只有非默认工作区（桌面）的
                * 会话才带 workspaceLabel（main 侧决定，见 ThreadSummary 注
                * 释）——桌面会话不打标，避免满屏重复徽标。hover 出全路径。 */}
              {thread.workspaceLabel && (
                <span
                  className="flex max-w-[76px] shrink-0 items-center gap-1 rounded bg-sidebar-accent/80 px-1.5 py-0.5 text-[10px] text-muted-foreground/80 transition-opacity group-hover:opacity-0 group-has-[[data-state=open]]:opacity-0"
                  title={thread.workspacePath}
                >
                  <Folder className="size-2.5 shrink-0" aria-hidden />
                  <span className="truncate">{thread.workspaceLabel}</span>
                </span>
              )}
              {/* 行右侧状态，四选一，都在行内流、hover / 菜单打开时淡出让位给
                * 绝对定位的 ···（原型 .time 的 display:none on hover）：
                *  1. 等待用户：「等待批准/等待回答」pill（品牌绿降饱和底，
                *     docs/ui-prototype-permission-float.html 的 .pill-wait）——
                *     优先于 running spinner：挂起时 spinner 的「正在干活」是
                *     误报，AI 其实在等用户；
                *  2. 运行中：旋转 spinner（品牌绿，与聊天区 ThinkingSpinner
                *     同色）——「正在运行」比「2 小时前」更该被看到；
                *  3. 未读：AI 回复已完成但用户还没看过（回合在非前台会话结束），
                *     蓝色小圆点，切到该会话即清除；
                *  4. 否则：相对时间。
                * running 与 unread 天然互斥（未读只在回合结束后出现，那时已不
                * running），故按此优先级排布。 */}
              {awaitingKind ? (
                <span
                  className="flex shrink-0 items-center gap-[5px] rounded-full bg-brand/[0.12] px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.02em] text-brand transition-opacity group-hover:opacity-0 group-has-[[data-state=open]]:opacity-0"
                  aria-label={awaitingLabel}
                  title={awaitingLabel}
                >
                  <span
                    aria-hidden
                    className="perm-wait-dot size-[5px] rounded-full bg-brand"
                  />
                  {awaitingLabel}
                </span>
              ) : running ? (
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
                {/* tabIndex=-1：这颗 ··· 是纯鼠标 affordance（hover 才显形）。
                  * 让它进 Tab 序列的结果是键盘焦点落在一颗隐形按钮上、行尾
                  * 凭空亮出一圈主题色 focus ring（2026-07-06 用户实锤），故
                  * 移出 Tab 序列并去掉配套的 focus-visible:opacity-100。鼠标
                  * 点击、菜单开合不受影响；无鼠标的行操作路径若将来要做，
                  * 应是行级 roving focus + 菜单键，而非逐颗隐形钮参与 Tab。 */}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="会话操作"
                  tabIndex={-1}
                  className="absolute right-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <SessionMenuItems
                  Item={DropdownMenuItem}
                  Separator={DropdownMenuSeparator}
                  onRename={handleStartRename}
                  onExportReplay={handleExportReplay}
                  onViewJsonl={handleViewJsonl}
                  onCopyJsonlPath={handleCopyJsonlPath}
                  onDelete={handleStartDelete}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <SessionMenuItems
            Item={ContextMenuItem}
            Separator={ContextMenuSeparator}
            onRename={handleStartRename}
            onExportReplay={handleExportReplay}
            onViewJsonl={handleViewJsonl}
            onCopyJsonlPath={handleCopyJsonlPath}
            onDelete={handleStartDelete}
          />
        </ContextMenuContent>
      </ContextMenu>
  )
})
