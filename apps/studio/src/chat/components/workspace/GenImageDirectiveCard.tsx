import type { GenImageJob } from '../../stores/proposal'
import { SpinnerIcon, AlertTriangleIcon, ImageIcon } from './proposalIcons'

// genimage 指令块的编辑态卡片（配图密度③）：指令块本身留在草稿 markdown 里当锚点，编辑态
// 不渲染成代码块而渲染成此卡。四态：
//   pending → 转圈「正在生成」；failed → 错误 + 重试（+缺配置时「去设置」）；
//   done+hasReview → 一行提示看下方审阅卡（审阅卡与本卡同 blockIndex，紧挨着渲染）；
//   done+!hasReview → 「重新生成」态（见下方 hasReview 注释）；
//   无 job 或 job.status==='manual' → 「点此生成」手动态：无 job 是超防御上限的溢出指令块/
//   选区改写落地等尚未发起过的新块；manual 是 restore 重建预登记的旧指令块哨兵（见
//   stores/proposal.ts seedManualGenImageJobs，终审 I-1）——两者渲染态相同、成因不同，
//   故文案给中性表述，不单点某一种成因。
// 纯展示 + 回调，不碰 store/IPC（与 ProposalImageReview 同纪律）。
export interface GenImageDirectiveCardProps {
  caption: string
  job: GenImageJob | undefined
  // job.status==='done' 时是否还能在 imageReviews 里找到对应的审阅卡（按 sectionId +
  // directiveRaw + directiveOccurrence 匹配，由 ProposalPaper 判定）。
  //
  // 搁浅态的来龙去脉：reopen/leaveMode 会清空 imageReviews（未决提议不跨离开/再入留存），
  // 但【保留】genImageJobs（幂等记录必须随 sections 存活，防再入后旧指令被当新指令自动重发，
  // 见 stores/proposal.ts reopen 注释）。这个不对称的代价是：用户在 job 变 done、审阅卡还没
  // 来得及点「应用/丢弃」之前离开工作台再回来，会看到「job 说已完成，但审阅卡（连同它绑定的
  // resultPath）已经没了」——图生成出来了却无从确认，是个搁浅态。hasReview=false 时本卡片
  // 用「重新生成」兜底：点击复用与手动态相同的 onGenerate 回调，fireGenImageDirective 会把
  // 该键覆写回 pending 重新走一遍生图，天然自愈，不需要额外状态机。
  hasReview: boolean
  /** AI 流式生成中：手动「生成」按钮禁用（与其它编辑操作的 generating 冻结纪律一致）。 */
  generating: boolean
  onGenerate: () => void
  onOpenSettings: () => void
}

export function GenImageDirectiveCard({
  caption,
  job,
  hasReview,
  generating,
  onGenerate,
  onOpenSettings
}: GenImageDirectiveCardProps): React.JSX.Element {
  const needsSettings = job?.status === 'failed' && (job.error ?? '').includes('未配置')
  return (
    <div className="my-2 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2.5 text-[12.5px]">
      <div className="flex items-center gap-2 text-neutral-600">
        <ImageIcon />
        <span className="font-medium">方案配图：{caption}</span>
      </div>
      {job?.status === 'pending' && (
        <div className="mt-1.5 flex items-center gap-1.5 text-neutral-500">
          {/* SpinnerIcon 自身不动画（见 proposalIcons.tsx 约定），必须由调用处加 animate-spin。 */}
          <SpinnerIcon className="shrink-0 animate-spin text-accent" />
          <span>正在调用生图模型绘制，完成后会出现审阅卡供你确认…</span>
        </div>
      )}
      {job?.status === 'failed' && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-rose-600">
          <AlertTriangleIcon />
          <span>{job.error ?? '生成失败，请稍后重试。'}</span>
          <button
            type="button"
            className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-neutral-700 hover:border-accent hover:text-accent disabled:opacity-40"
            disabled={generating}
            onClick={onGenerate}
          >
            重试
          </button>
          {needsSettings && (
            <button
              type="button"
              className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-neutral-700 hover:border-accent hover:text-accent"
              onClick={onOpenSettings}
            >
              去设置
            </button>
          )}
        </div>
      )}
      {job?.status === 'done' &&
        (hasReview ? (
          <div className="mt-1.5 text-neutral-500">已生成，请在下方审阅卡里确认「应用」或「丢弃」。</div>
        ) : (
          // 搁浅态兜底（见 hasReview 注释）：审阅卡已随 reopen/leaveMode 清空，resultPath 随之
          // 丢失，唯一出路是重新生成。
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-neutral-500">
            <span>生成结果已失效（离开工作台会清掉未确认的审阅卡），可重新生成。</span>
            <button
              type="button"
              className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-neutral-700 hover:border-accent hover:text-accent disabled:opacity-40"
              disabled={generating}
              onClick={onGenerate}
            >
              重新生成
            </button>
          </div>
        ))}
      {(!job || job.status === 'manual') && (
        <div className="mt-1.5 flex items-center gap-2 text-neutral-500">
          <span>尚未生成，可点击按钮生成这张图。</span>
          <button
            type="button"
            className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-neutral-700 hover:border-accent hover:text-accent disabled:opacity-40"
            disabled={generating}
            onClick={onGenerate}
          >
            生成这张图
          </button>
        </div>
      )}
    </div>
  )
}
