/**
 * CanvasQuestionnaire 的「演示驱动接口」注册表——回放 ui 轨与真实问卷组件
 * 之间的唯一耦合点。同 imageEditDemoRegistry/confirmDemoRegistry 的窄接口
 * 模式：组件在回放态挂载时注册一个 handle，卸载时注销；ReplayController
 * 拿 handle 命令式驱动。
 *
 * 与 confirmDemoRegistry 的差异：AskUserQuestion 的题目内容本来就在
 * transcript 的 tool-call args 里（不像 confirm_ui 需要额外埋点+离线数据
 * 源），所以这里不需要 open(toolUseId) 去找快照——题目由
 * SlidesWorkspace 直接从 chat store 的（回放态）tool item 派生并作为
 * replayQuestions prop 传给 CanvasQuestionnaire（组件始终知道题目是什么），
 * handle 只管「选中态」这一层表演。
 */

export interface QuestionDemoHandle {
  /** 把某一题的选中态设为 label（对应 CanvasQuestionnaire 的 answers[q]，
   *  但绝不触发真实 respond()）。 */
  select(question: string, label: string): void
  /** 逐字表演「其他」输入框（对应 otherDraft[q] + answers[q] 同步写入，
   *  与真实组件的 typeOther 语义一致）。 */
  typeOther(question: string, text: string): void
  /** 提交视觉（按钮态变化），不调用 respond()——回放的「结果」已经由 chat
   *  轨的 tool_result 呈现。 */
  submit(): void
}

let current: QuestionDemoHandle | null = null
const readyListeners = new Set<() => void>()

export function registerQuestionDemoHandle(h: QuestionDemoHandle): void {
  current = h
  for (const cb of readyListeners) cb()
}

export function unregisterQuestionDemoHandle(h?: QuestionDemoHandle): void {
  if (h === undefined || current === h) current = null
}

export function getQuestionDemoHandle(): QuestionDemoHandle | null {
  return current
}

export function onQuestionDemoReady(cb: () => void): () => void {
  readyListeners.add(cb)
  return () => readyListeners.delete(cb)
}
