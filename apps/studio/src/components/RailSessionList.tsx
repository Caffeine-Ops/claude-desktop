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
 * 交互形态（对齐原型，全部不打断列表本身）：
 *  - 重命名走**行内编辑**：行原地变输入框，Enter 提交 / Esc 或点行外取消
 *    （行有竞争性点击动作——切会话——所以外点是取消不是提交；对比
 *    ChatHeader 的标题编辑 blur 即提交，那里没有竞争动作）。
 *  - 删除走**菜单内二次确认**（原型变体 D）：第一次点「删除」不关菜单，
 *    条目原地变红成「确认删除？」+ 3 秒引信自动复原；再点才真删。危险
 *    确认发生在同一个像素位置，且列表行全程可见——删谁、删完列表长
 *    什么样，一直看得到。
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

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Check, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import type { ComponentType, ReactNode } from 'react'
import type { ThreadSummary } from '@desktop-shared/types'

import { railEaseOut } from '@/src/chat/shell/railMotion'
import { ScrollArea } from '@/src/components/ui/scroll-area'
import { Button } from '@/src/components/ui/button'
import { Input } from '@/src/components/ui/input'
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

/** 删除条目上膛后自动复原的窗口（原型 3s 引信）。 */
const ARM_WINDOW_MS = 3000
/** renamed-flash 动画时长 + 余量，播完摘类以便下次重播。 */
const FLASH_MS = 950

/**
 * rail 行的**展示**标题。ThreadSummary.title 无 custom/ai 标题时兜底到
 * firstPrompt——以 slash 命令开头的会话（/claude-desktop:ppt-master 武汉…）
 * 会把命令原文糊满整行，噪音吃掉真正的语义。展示层剥掉开头的命令 token：
 *  - `/claude-desktop:ppt-master 武汉大学PPT` → `武汉大学PPT`
 *  - 只有命令没有参数时，退化为命令短名（`/claude-desktop:ppt-master` →
 *    `ppt-master`），比整串路径可读。
 * 只影响 rail 展示；行 title 属性仍是完整原文，悬停可看全。
 */
function displayTitle(raw: string): string {
  const t = raw.trim()
  const m = /^(\/[\w.:-]+)\s*([\s\S]*)$/.exec(t)
  if (!m) return t
  const rest = m[2].trim()
  if (rest) return rest
  return m[1].slice(1).split(':').pop() || t
}

/** updatedAt → 时间分组。 */
function groupLabel(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return '今天'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  // 标签叫「本周」但语义是滚动 7 天（与 shell-floating 原型的分组名对齐；
  // 真按日历周切，周一早上「上周五」会瞬移进「更早」，反而反直觉）。
  if (now.getTime() - ms < 7 * 24 * 60 * 60 * 1000) return '本周'
  return '更早'
}

/** updatedAt → 行尾相对时间（原型 .session-row .time：刚刚 / N 分钟前 /
 * N 小时前 / 昨天 / 周X / M月D日）。只在列表 reload 时重算——与分组标签
 * 同一刷新节奏，不为「3 分钟前变 4 分钟前」挂定时器。 */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
function relativeTime(ms: number): string {
  const now = new Date()
  const d = new Date(ms)
  const diffMin = Math.floor((now.getTime() - ms) / 60_000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  if (d.toDateString() === now.toDateString()) return `${Math.floor(diffMin / 60)} 小时前`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  if (now.getTime() - ms < 7 * 24 * 60 * 60 * 1000) return WEEKDAYS[d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

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
 * 菜单条目本体（··· 与右键共用）。armed = 删除已上膛：条目整红、显示
 * 「确认删除？」并点燃底部 3 秒引信（宽度烧完由父级 disarm 复原）。
 */
function SessionMenuItems({
  Item,
  armed,
  onRename,
  onDeleteSelect
}: {
  Item: MenuItemComponent
  armed: boolean
  onRename: () => void
  onDeleteSelect: (event: Event) => void
}) {
  return (
    <>
      <Item onSelect={onRename}>
        <Pencil className="size-3.5" /> 重命名
      </Item>
      <Item
        variant={armed ? 'default' : 'destructive'}
        onSelect={onDeleteSelect}
        className={cn(
          armed &&
            'relative overflow-hidden bg-destructive text-white focus:bg-destructive focus:text-white [&_svg]:text-white!'
        )}
      >
        <Trash2 className="size-3.5" />
        {armed ? '确认删除？' : '删除'}
        {armed && (
          <motion.span
            aria-hidden
            initial={{ scaleX: 1 }}
            animate={{ scaleX: 0 }}
            transition={{ duration: ARM_WINDOW_MS / 1000, ease: 'linear' }}
            className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-white/55"
          />
        )}
      </Item>
    </>
  )
}

export function RailSessionList() {
  const pathname = usePathname()

  const [threads, setThreads] = useState<readonly ThreadSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // 行内重命名
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [justRenamedId, setJustRenamedId] = useState<string | null>(null)
  // 删除二次确认（菜单条目上膛）
  const [armedId, setArmedId] = useState<string | null>(null)
  const armTimerRef = useRef<number | null>(null)

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
    const offList = window.tabApi?.onShellSessionListChanged?.(reload)
    // 切换事件回流时同步高亮——无论切换是本组件发起（点击项）还是 chat
    // 页面内部发起后经 main 正规化，最终都汇到这一个事件上。
    const offSwitch = window.chatApi.onShellSessionSwitch?.((id) => {
      setActiveId(id)
    })
    return () => {
      offList?.()
      offSwitch?.()
    }
  }, [reload])

  const goChat = useCallback(() => {
    // shallow pushState 而非 router.push：两面常驻 SurfaceHost、page 是
    // 空壳，Next 无需做任何导航工作（见 AppRail goChatShallow 注释）。
    if (!pathname.startsWith('/chat')) window.history.pushState(null, '', '/chat')
  }, [pathname])

  /** 点击行：高亮 + 导航到聊天 + 通知 main 切 runtime。 */
  const switchTo = useCallback(
    (id: string | null) => {
      setActiveId(id)
      goChat()
      void window.tabApi?.switchShellSession?.(id)
    },
    [goChat]
  )

  /* ── 行内重命名 ── */

  const disarm = useCallback(() => {
    if (armTimerRef.current != null) {
      window.clearTimeout(armTimerRef.current)
      armTimerRef.current = null
    }
    setArmedId(null)
  }, [])

  const startRename = useCallback(
    (t: ThreadSummary) => {
      disarm()
      setRenameValue(t.title)
      setRenamingId(t.id)
    },
    [disarm]
  )

  const cancelRename = useCallback(() => setRenamingId(null), [])

  const commitRename = useCallback(() => {
    const id = renamingId
    const title = renameValue.trim()
    setRenamingId(null)
    const target = threads.find((t) => t.id === id)
    if (!id || !target || !title || title === target.title) return
    // 乐观：行文字立即更新并播微光；rename 的 sessionListChanged 广播随后
    // 从磁盘重新导出同一个值（失败时 reload 拉回真实标题）。
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)))
    setJustRenamedId(id)
    window.setTimeout(() => setJustRenamedId((cur) => (cur === id ? null : cur)), FLASH_MS)
    void window.tabApi
      ?.renameShellSession?.({ sessionId: id, title })
      .then(reload)
      .catch((err: unknown) => {
        console.warn('[RailSessionList] rename failed', err)
        reload()
      })
  }, [renamingId, renameValue, threads, reload])

  // 点击编辑行以外任意处取消编辑（mousedown 先于 click，避免顺手切走会话
  // 时编辑器闪一帧才消失）。
  useEffect(() => {
    if (renamingId == null) return undefined
    const onDown = (e: MouseEvent) => {
      const editor = document.querySelector('[data-rail-renaming]')
      if (editor && !editor.contains(e.target as Node)) cancelRename()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [renamingId, cancelRename])

  /* ── 删除：菜单内二次确认 ── */

  const arm = useCallback(
    (id: string) => {
      disarm()
      setArmedId(id)
      // 3 秒无第二击自动复原——红态不该在无人看的菜单里常驻。
      armTimerRef.current = window.setTimeout(() => {
        armTimerRef.current = null
        setArmedId(null)
      }, ARM_WINDOW_MS)
    },
    [disarm]
  )

  const performDelete = useCallback(
    (target: ThreadSummary) => {
      disarm()
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
        setActiveId(next?.id ?? null)
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
    [threads, activeId, disarm, reload]
  )

  /** 「删除」条目点击：未上膛 → 拦下关闭并上膛；已上膛 → 放行执行。 */
  const onDeleteSelect = useCallback(
    (t: ThreadSummary) => (e: Event) => {
      if (armedId !== t.id) {
        e.preventDefault() // 菜单保持打开，条目原地变红
        arm(t.id)
      } else {
        performDelete(t)
      }
    },
    [armedId, arm, performDelete]
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
          * display:table 写在 Radix 的 inline style 上。 */}
        <ScrollArea className="-mx-1 min-h-0 flex-1 px-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
          {/* pr-2：shadcn ScrollArea 的滚动条是 overlay（浮在内容上），
              行文字 truncate 到容器右缘会被它盖住尾巴——内容侧自留出
              滚动条的宽度（原型 session-scroll 右 padding 同理）。 */}
          <ul className="flex flex-col pr-2">
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
                    renaming={item.thread.id === renamingId}
                    justRenamed={item.thread.id === justRenamedId}
                    armed={item.thread.id === armedId}
                    renameValue={renameValue}
                    onRenameValueChange={setRenameValue}
                    onCommitRename={commitRename}
                    onCancelRename={cancelRename}
                    onSwitch={() => switchTo(item.thread.id)}
                    onStartRename={() => startRename(item.thread)}
                    onDeleteSelect={onDeleteSelect(item.thread)}
                    onMenuOpenChange={(open) => {
                      if (!open) disarm()
                    }}
                  />
                )
              )}
            </AnimatePresence>
          </ul>
        </ScrollArea>
      </div>
    </MotionConfig>
  )
}

/**
 * 单个会话行。三态：常规（标题 + hover 浮现 ···）、编辑（行内输入框 +
 * 保存钩）、上膛态只影响菜单条目不影响行本身。选中态 = 目标行上的中性
 * 灰底 + 品牌绿圆点，即时呈现（曾是 layoutId glider 滑块在行间滑动，
 * 2026-07-04 应用户要求去掉切换动画后退役）。
 */
function SessionRow({
  thread,
  active,
  renaming,
  justRenamed,
  armed,
  renameValue,
  onRenameValueChange,
  onCommitRename,
  onCancelRename,
  onSwitch,
  onStartRename,
  onDeleteSelect,
  onMenuOpenChange
}: {
  thread: ThreadSummary
  active: boolean
  renaming: boolean
  justRenamed: boolean
  armed: boolean
  renameValue: string
  onRenameValueChange: (v: string) => void
  onCommitRename: () => void
  onCancelRename: () => void
  onSwitch: () => void
  onStartRename: () => void
  onDeleteSelect: (event: Event) => void
  onMenuOpenChange: (open: boolean) => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!renaming) return undefined
    // 等编辑器挂载完成再聚焦全选（radix 菜单关闭会抢一次焦点）。
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [renaming])

  return (
    <motion.li
      layout="position"
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.22, ease: railEaseOut }}
      className="overflow-hidden"
    >
      {renaming ? (
        <div
          data-rail-renaming
          // h-8 与常规行同高：进入/退出编辑时行高不跳。
          className="flex h-8 items-center gap-1 rounded-lg bg-sidebar-accent/60 pl-2 pr-1"
        >
          <Input
            ref={inputRef}
            value={renameValue}
            maxLength={200}
            name="rename-session"
            aria-label="重命名对话"
            onChange={(e) => onRenameValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onCommitRename()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onCancelRename()
              }
            }}
            className="h-7 min-w-0 flex-1 rounded-md border-sidebar-primary px-2 text-[13px] focus-visible:border-sidebar-primary focus-visible:ring-sidebar-primary/25"
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="保存"
            // mousedown preventDefault：不让 input 先失焦（外点=取消，这一下
            // 不是外点）。
            onMouseDown={(e) => e.preventDefault()}
            onClick={onCommitRename}
            className="size-7 shrink-0 text-sidebar-primary hover:bg-sidebar-primary/12 hover:text-sidebar-primary"
          >
            <Check className="size-3.5" />
          </Button>
        </div>
      ) : (
        <ContextMenu onOpenChange={onMenuOpenChange}>
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
                {/* 相对时间：hover / 菜单打开时让位给 ···（原型 .time 的
                  * display:none on hover；这里用 opacity 免布局跳动——时间
                  * 与 ··· 分别位于行内流和绝对定位层，淡出即可无重叠）。 */}
                <span className="shrink-0 text-[11px] font-normal text-muted-foreground/70 transition-opacity group-hover:opacity-0 group-has-[[data-state=open]]:opacity-0">
                  {relativeTime(thread.updatedAt)}
                </span>
              </Button>
              <DropdownMenu onOpenChange={onMenuOpenChange}>
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
                    armed={armed}
                    onRename={onStartRename}
                    onDeleteSelect={onDeleteSelect}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-[9rem]">
            <SessionMenuItems
              Item={ContextMenuItem}
              armed={armed}
              onRename={onStartRename}
              onDeleteSelect={onDeleteSelect}
            />
          </ContextMenuContent>
        </ContextMenu>
      )}
    </motion.li>
  )
}
