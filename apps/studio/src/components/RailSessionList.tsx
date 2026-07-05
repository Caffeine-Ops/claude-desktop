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

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import type { ComponentType, ReactNode } from 'react'
import type { ThreadSummary } from '@desktop-shared/types'

import { railEaseOut } from '@/src/chat/shell/railMotion'
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

  const [threads, setThreads] = useState<readonly ThreadSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
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
  justRenamed,
  onSwitch,
  onStartRename,
  onStartDelete
}: {
  thread: ThreadSummary
  active: boolean
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
              {/* 相对时间：hover / 菜单打开时让位给 ···（原型 .time 的
                * display:none on hover；这里用 opacity 免布局跳动——时间
                * 与 ··· 分别位于行内流和绝对定位层，淡出即可无重叠）。 */}
              <span className="shrink-0 text-[11px] font-normal text-muted-foreground/70 transition-opacity group-hover:opacity-0 group-has-[[data-state=open]]:opacity-0">
                {relativeTime(thread.updatedAt)}
              </span>
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
