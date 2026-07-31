import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { splitBlocks } from '@desktop-shared/proposalBlocks'
import { cn } from '@/src/lib/utils'
import { useWritingStore } from '../../stores/writing'
import { paperSkinClass } from '../../lib/writingGenreStyle'
import type { WritingRevisionTarget } from '../../lib/writingRevision'
import { blockSourceAt, isBlockUnchanged } from '../../lib/writingEdit'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'
import { WritingSelectionBubble } from './WritingSelectionBubble'

/**
 * 文稿态纸面。两条修改通道：选中一段交给 AI 改写（气泡），或**双击一块就地改它的
 * Markdown 源码**（2026-07-31 加，推翻了前作 spec 的「明确不做手动编辑」）。
 *
 * 手动编辑改的是**源码而不是排好版的字**：所见即所得要把富文本反向转回 Markdown，
 * 加粗 / 列表 / 链接在来回转换里很容易跑掉，工作量还大一个量级。
 *
 * 逐块渲染（块 = 一个标题/段落/列表/表格/围栏代码，切法见 proposalBlocks.ts）而不是把整节
 * 丢给一个 markdown 组件：块的 DOM 边界既是选区改写的定位锚点（`data-section-name` +
 * `data-block-index`），也是手动编辑的最小单元。整节渲染时这个映射无从建立。
 */
export function WritingPaper({
  writing,
  busy = false,
  onRevise,
  onEditBlock
}: {
  /**
   * 这一轮 AI 是不是正在往当前文档源里落字（`useWritingInProgress()`，见 stores/writing.ts）
   * ——**不是**会话级的 `streaming`。会话级 streaming 在一轮 assistant 消息的 start~end 之间
   * 恒真，AI 跑无关 shell / 回答问题时也是真；全文写完后用户提问会让骨架误挂着「正在写
   * 第 N 节」。调用方（WritingDocPanel）已经做了这次收窄，这里只管消费布尔值。
   */
  writing: boolean
  /** AI 忙 / 已有一条改写在飞——只影响气泡按钮文案（「排队改写」），路由由调用方现读 store 决定。 */
  busy?: boolean
  /**
   * 发起一次选区改写。**省略时纸面就是纯只读的**（将来若有只读复用场景，不该冒出改写气泡），
   * 故气泡跟着这个 prop 挂载与否，而不是无条件常驻。
   */
  onRevise?: (target: WritingRevisionTarget, instruction: string) => void
  /**
   * 提交一次手动编辑。**省略时纸面仍是纯只读的**（与 onRevise 同款约定：能力跟着 prop
   * 挂载，不无条件常驻）。返回 true = 已存盘、可以关掉编辑框；false = 存盘失败，停在原块
   * 让用户看到错误并重试——**不要在失败时也关掉编辑框**，那会让错误提示伴随焦点转移一起
   * 被忽略，用户以为存上了。
   */
  onEditBlock?: (input: {
    sectionName: string
    blockIndex: number
    nextBlockMarkdown: string
    baseMtimeMs: number
  }) => Promise<boolean>
}): React.JSX.Element {
  const sections = useWritingStore((s) => s.sections)
  const genre = useWritingStore((s) => s.genre)
  const outlineTotal = useWritingStore((s) => s.outlineTotal)
  const status = useWritingStore((s) => s.status)
  const errMsg = useWritingStore((s) => s.errMsg)
  // 滚动容器：既是选区气泡的定位参照系（容器 relative），也是「选区必须落在纸面内」的判据。
  const scrollRef = useRef<HTMLDivElement | null>(null)

  /**
   * 当前正在编辑哪一块。同一时刻只有一个 —— 双击另一块会先存当前块再进新块（见 commitEdit）。
   * `draft` 是输入框里的实时内容，`base` 是进入编辑那一刻这一块的源码（用来判「变没变」），
   * `baseMtimeMs` 是**那一刻**这一节的 mtime，写盘时当乐观锁基准。
   *
   * 【为什么 baseMtimeMs 必须在进入编辑时快照，不能写盘时现读】轮询每 2s 把 sections 连同
   * mtime 刷一遍。现读的话，「你编辑期间这一节被 AI 或外部改过」——锁最该拦的场景——会因为
   * 基准已经悄悄跟到最新而比对相等、直接放行，把基于旧版编辑的内容拼进新版的错误位置。
   * 完整推演见 stores/writing.ts 的 baseMtimeMs 字段注释，那是同一颗地雷。
   */
  const [editing, setEditing] = useState<{
    sectionName: string
    blockIndex: number
    base: string
    draft: string
    baseMtimeMs: number
  } | null>(null)
  /**
   * 正在写盘的是哪一块（`"节名:块序号"`，而不是一个裸 boolean）。
   *
   * 【2026-07-31 复审 I-2：boolean 会把无关的块也锁住】双击 A 改字、还没等它存完就
   * 直接双击 B 的真实事件顺序是：B 的 mousedown 让 A 失焦 → onBlur 触发 A 的
   * commitEdit（**异步**）→ B 的 dblclick 触发 beginEdit(B) → B 的 textarea 挂载
   * → A 的 await 这才返回、清掉这面全局 boolean。若这面 flag 是裸 boolean，B 的
   * textarea 在整段等待期间会被 `disabled={saving}` 一起锁住——更糟的是
   * **`autoFocus` 对已经 disabled 的元素不生效**，B 解禁之后也不会补聚焦，用户看到
   * 编辑框已经打开却打不进字，得再手动点一下。改成「记录具体是哪一块在存」后，
   * B 的 key 与 A 的 key 不同，不会被误锁。
   */
  const [savingKey, setSavingKey] = useState<string | null>(null)
  // 防重入用的 ref（配合下面 commitEdit 里的说明）：**不能用 state 当闸**，state
  // 更新是异步的，重入调用发生在同一个事件循环 tick 里，读到的还是更新前的值。
  const savingRef = useRef(false)

  // 每节切块。sections 变才重算——流式期间 2s 一次，代价可忽略。
  const blocks = useMemo(
    () => sections.map((s) => ({ name: s.name, items: splitBlocks(s.markdown) })),
    [sections]
  )

  /** 双击进入编辑。AI 正在落字时不许进（见本函数开头的判据）。 */
  const beginEdit = useCallback(
    (sectionName: string, blockIndex: number): void => {
      if (!onEditBlock || writing) return
      const sec = sections.find((s) => s.name === sectionName)
      if (!sec) return
      const source = blockSourceAt(sec.markdown, blockIndex)
      if (source === null) return
      // 清掉浏览器选区：双击本身会选中一个词，不清的话选区改写气泡会同时冒出来，
      // 两条修改通道各有一套定位，同时开着必然打架。
      window.getSelection()?.removeAllRanges()
      setEditing({
        sectionName,
        blockIndex,
        base: source,
        draft: source,
        baseMtimeMs: sec.mtimeMs
      })
    },
    [onEditBlock, writing, sections]
  )

  /**
   * 【2026-07-31 复审 M-8】轮询 / 撤销可能把某一节的块数改少（AI 重写、用户点了顶栏
   * 撤销……），若正编辑的那个 `blockIndex` 因此越界，这一块在 `blocks` 里已经渲染
   * 不出来了，但 `editing` 还非 null——表现为 textarea 静默消失、草稿静默丢失，
   * 且选区改写气泡因为下面 `editing === null` 的判据被一直压着不出来，界面像卡死
   * 一样，直到用户凑巧再双击别的块才恢复。这里做一次结构性兜底：块本身已经不在了，
   * 就没有「保留草稿」的意义，只能清掉。
   *
   * 注意这与「AI 正在落字时不踢出已在编辑的用户」（见 beginEdit 开头的判据）是两回事：
   * 那条防的是 `writing` 变 true 本身不该清 `editing`；这里防的是块**结构性消失**
   * （下标越界），只要块还在，`writing` 再怎么变都不会走到这个分支。
   */
  useEffect(() => {
    if (!editing) return
    const sec = blocks.find((s) => s.name === editing.sectionName)
    if (!sec || editing.blockIndex >= sec.items.length) {
      setEditing(null)
    }
  }, [blocks, editing])

  /**
   * 提交当前编辑。返回 true = 可以离开这一块（存成功、或内容压根没变）。
   *
   * 内容没变时直接返回 true 不写盘：省掉一次无意义 IPC，也省掉一格撤销额度——用户点开
   * 看一眼再点走，不该消耗掉一次真正的后悔机会。
   */
  const commitEdit = useCallback(async (): Promise<boolean> => {
    if (!editing || !onEditBlock) return true
    /**
     * 【2026-07-31 复审 I-3：disabled 会让浏览器对聚焦元素派发 blur，从而重入】
     * 保存期间给 textarea 加 `disabled`，浏览器对「已聚焦元素被禁用」这件事会自己
     * 派发一次 blur，而 onBlur 又挂着 `void commitEdit()`——这一次调用与正在进行
     * 的那次共享同一个 `editing` 闭包（这段时间内 `editing` 没变，`commitEdit`
     * 这个函数引用本身也不会变，没有别的东西能拦住它），于是同一块内容会用同一个
     * `baseMtimeMs` 再写一次盘。第二次写必然撞乐观锁（第一次已经把 mtime 往前推
     * 了），用户看到的是「刚存成功」紧跟着一条误导性的「这一节刚被 AI 改过」。
     * 用 ref 而非 state 判重入：state 更新是异步的，重入发生在同一个 tick 里，
     * 读到的还是这次调用开始前的旧值，拦不住。
     */
    if (savingRef.current) return false
    const mine = editing
    const mineKey = `${mine.sectionName}:${mine.blockIndex}`
    /**
     * 只在「当前编辑态还是我这一块」时才关掉编辑框。
     *
     * 【为什么不能直接 setEditing(null) —— 这是一条真实的竞态】用户双击 B 块时事件顺序是：
     * B 的 mousedown 让 A 的 textarea 失焦 → onBlur 触发 commitEdit（**异步**，要 await 写盘）
     * → B 的 dblclick 触发 beginEdit(B) → setEditing(B) → A 的 await 这才返回。
     * 此时无条件 setEditing(null) 会把刚进入编辑的 B 一起清掉，用户看到的是「A 存上了，
     * 但 B 闪一下就退出了」。
     */
    const closeIfStillMine = (): void =>
      setEditing((cur) =>
        cur && cur.sectionName === mine.sectionName && cur.blockIndex === mine.blockIndex
          ? null
          : cur
      )
    if (isBlockUnchanged(mine.base, mine.draft)) {
      closeIfStillMine()
      return true
    }
    savingRef.current = true
    setSavingKey(mineKey)
    try {
      const ok = await onEditBlock({
        sectionName: mine.sectionName,
        blockIndex: mine.blockIndex,
        nextBlockMarkdown: mine.draft,
        baseMtimeMs: mine.baseMtimeMs
      })
      if (ok) closeIfStillMine()
      return ok
    } finally {
      savingRef.current = false
      // 只清「还是我这一份」的 savingKey：理论上（见上面 I-3 注释）重入已经被
      // savingRef 挡住，不会有第二份 in-flight 覆盖它，这里的现读比较仅作为
      // 双重保险，不依赖它也不会错。
      setSavingKey((cur) => (cur === mineKey ? null : cur))
    }
  }, [editing, onEditBlock])

  /** Esc 取消：丢弃修改，不写盘。 */
  const cancelEdit = useCallback((): void => setEditing(null), [])

  if (status === 'missing') {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div className="text-[12.5px] leading-relaxed text-muted-foreground">
          写作项目目录已不存在
          <br />
          可能被移动或删除了
        </div>
      </div>
    )
  }

  // 扫描 / 读取 IPC 失败。**必须排在下面那条空态分支之前**：status='error' 时 sections 通常
  // 也是空的，若不先拦一道，报错会被伪装成「还没有正文，AI 写完第一节后会自动出现在这里」
  // ——用户看到的是一个永远等不来内容的正常等待态，而 store 里其实躺着一条谁也读不到的
  // errMsg（那个字段此前是「只写不读」的死字段，这就是它的读者）。
  // 权限不足 / 磁盘卸载 / 文件名编码异常这类错误只能靠这条文案暴露出来。
  if (status === 'error' && sections.length === 0) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div className="text-[12.5px] leading-relaxed text-muted-foreground">
          读取文稿失败
          {errMsg && (
            <>
              <br />
              <span className="break-all text-rose-600 dark:text-rose-400">{errMsg}</span>
            </>
          )}
        </div>
      </div>
    )
  }

  if (sections.length === 0) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div className="text-[12.5px] leading-relaxed text-muted-foreground">
          还没有正文
          <br />
          AI 写完第一节后会自动出现在这里
        </div>
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      // relative：选区气泡是它的 absolute 子节点，靠这层建立包含块（气泡坐标已含 scrollTop，
      // 故会随内容一起滚，不需要在 scroll 上重算）。
      className="relative flex-1 overflow-y-auto"
    >
      {/* 顶部单条状态提示。两条可能同时成立时「刷新失败」优先——它关乎「你现在看的内容是不是
          最新的」，比「现在不能编辑」更要紧；叠成两行会把纸面顶部占掉两条。 */}
      {status === 'error' ? (
        <div className="sticky top-0 z-10 border-b border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 backdrop-blur-sm dark:text-amber-400">
          刷新文稿失败，下面显示的可能不是最新内容{errMsg ? `：${errMsg}` : ''}
        </div>
      ) : writing && onEditBlock ? (
        <div className="sticky top-0 z-10 border-b border-border bg-muted/60 px-3 py-1.5 text-[11px] text-muted-foreground backdrop-blur-sm">
          AI 正在写这篇稿子，暂时不能编辑
        </div>
      ) : null}
      {/* writing-paper / writing-block：目前全仓没有对应的 CSS 规则，是留给后续任务
          （选区改写的定位/高亮等）的稳定钩子——不要当成废代码清掉。 */}
      <div className={cn('writing-paper', paperSkinClass(genre))}>
        {blocks.map((sec) =>
          sec.items.map((block, i) => {
            const isEditing =
              editing !== null && editing.sectionName === sec.name && editing.blockIndex === i
            const blockKey = `${sec.name}:${i}`
            const isSavingThis = isEditing && savingKey === blockKey
            return (
              <div
                key={`${sec.name}:${i}`}
                data-section-name={sec.name}
                data-block-index={i}
                className="writing-block"
                onDoubleClick={isEditing ? undefined : () => beginEdit(sec.name, i)}
              >
                {isEditing ? (
                  <div className="my-1">
                    {writing && (
                      <div className="mb-1 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
                        AI 正在改这篇稿子，保存时可能冲突
                      </div>
                    )}
                    <textarea
                      autoFocus
                      value={editing.draft}
                      disabled={isSavingThis}
                      // 函数式更新：onChange 高频触发，吃闭包里的 editing 会用到过期快照。
                      onChange={(e) => {
                        const v = e.target.value
                        setEditing((cur) => (cur ? { ...cur, draft: v } : cur))
                      }}
                      onKeyDown={(e) => {
                        // 【2026-07-31 复审 I-1：中文输入法组词期间的 Esc 不是「取消编辑」】
                        // `isComposing`（true = 拼音已经敲了字符、汉字还没上屏那一小段
                        // 组词窗口）为真时，用户按 Esc 十有八九是在关输入法自己的候选词
                        // 弹窗，不是要放弃这段编辑。这是中文写作产品里极高频的操作——
                        // 不判这一条，中文用户敲字敲到一半按 Esc 收起候选词，会被误判成
                        // 整段丢弃、无确认无撤销。`keyCode === 229` 是部分浏览器 / 输入法组合
                        // 下 `isComposing` 已经变回 false、但 keyCode 仍报 229 的兼容兜底。
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelEdit()
                          return
                        }
                        // Cmd/Ctrl+Enter 存盘。裸 Enter 不能当存盘键 —— 段落里换行是正常写作动作。
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault()
                          void commitEdit()
                        }
                      }}
                      onBlur={() => void commitEdit()}
                      // 高度随内容长：不这么做就是滚动条套滚动条（纸面本身已经是滚动容器）。
                      rows={Math.max(2, editing.draft.split('\n').length + 1)}
                      className="w-full resize-none rounded-md border border-accent bg-muted/40 px-2 py-1.5 font-mono text-[13px] leading-relaxed text-foreground outline-none"
                    />
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {isSavingThis ? '保存中…' : 'Esc 取消 · 点击别处保存'}
                    </div>
                  </div>
                ) : (
                  <AssistantMarkdown text={block} />
                )}
              </div>
            )
          })
        )}

        {/* 进度骨架：节级实时的代价是写一节的几十秒里页面不动，用它告诉用户「在写、还剩几节」。
            总数解析不到时只说「正在写下一节」——显示错的总数比不显示更糟。

            【为什么要判 sections.length >= outlineTotal 这一路】`writing` 的判据是「这一轮有
            写 drafts/ 的文件调用」，它分不清 AI 是在往下写新的一节、还是质检后回头重写第 3 节。
            全文写完（sections.length === outlineTotal）后 AI 回头润色，序号会算成
            `已有 6 节 + 1` = 第 7 节，于是冒出「正在写第 7 节 · 共 6 节」这种越界数字。
            此时正确的信息本来就不是序号（我们并不知道它在改哪一节），换成不带序号的文案。
            **注意判据是 `>`（即 sections.length >= outlineTotal）而不是「夹紧后 == outlineTotal」**：
            后者会把「已写 5 节、正在写第 6 节（共 6 节）」这个完全正常的最后一节也误报成
            「正在修改」——那恰恰是最需要显示进度的一刻。
            残余局限（本次不修）：写到一半时回头改前面某节（如已 4 节 / 共 6 节时重写第 2 节），
            仍会显示「正在写第 5 节」。要根治得让 isWritingInProgress 回传「在写哪个文件」再
            与 sections 比对，属于另一个改动，这里只保证不出越界数字。 */}
        {writing && (
          <div className="mt-6 flex items-center gap-2 text-[12px] text-muted-foreground">
            <div className="size-3 animate-spin rounded-full border-[2px] border-border border-t-accent" />
            {!outlineTotal
              ? '正在写下一节…'
              : sections.length + 1 > outlineTotal
                ? 'AI 正在修改这篇稿子…'
                : `正在写第 ${sections.length + 1} 节 · 共 ${outlineTotal} 节`}
          </div>
        )}
      </div>

      {/* 选区即改浮层。挂在滚动容器内（而非 portal 到 body）：坐标是容器相对的，随内容滚动
          天然对齐；也免了 portal 子树脱离 .chat-app 豁免后要给每个交互元素补 data-slot
          的那一串坑（见 CLAUDE.md 样式铁律）。 */}
      {/* 编辑中隐藏气泡：同一时刻只走一条修改通道。两套定位（气泡按块区间、编辑按块序号）
          同时开着必然打架。 */}
      {onRevise && editing === null && (
        <WritingSelectionBubble containerRef={scrollRef} busy={busy} onSubmit={onRevise} />
      )}
    </div>
  )
}
