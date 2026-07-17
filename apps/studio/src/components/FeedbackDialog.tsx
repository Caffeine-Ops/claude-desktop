'use client'

/*
 * 问题反馈弹窗——受控组件，开关状态挂在共享的 useDialogStore（'feedback'
 * kind）上，而不是自带 trigger + 内部 open 状态。两个入口（rail「帮助与
 * 反馈」菜单项、设置页 about 区的按钮）共用同一个弹窗实例，各自只需调
 * `useDialogStore.getState().openDialog('feedback')`。
 *
 * 挂载点必须是 RailShell.tsx（根 layout，随 app 启动即常驻）而不是
 * canvas/AppRoot.tsx——canvas 面走「首次访问后才挂载并永久保活」的懒挂载
 * （SurfaceHost 的 visited.current.canvas 只在 chatShowing 为 false 的
 * 某次渲染才翻真），多数用户默认落在 chat 面，从未主动切过画布/设置页时
 * canvas 树根本没挂载——这时候点 rail 菜单项只是往 store 里写了个没人听的
 * 状态，弹窗不会出现（2026-07-14 实锤：必须先访问一次画布/设置页才能打开）。
 *
 * 本组件因此不用 canvas 的 useI18n()——canvas 的 I18nProvider 被刻意限制
 * 只活在 canvas 自己的模块图里（不进 SSR/静态导出的根 layout 包，见
 * canvas/AppRoot.tsx 头注释），把它拽到这里会违反那条边界。文案直接硬编码
 * 中文，与 AppRail.tsx 本身的其它菜单项（同样零 i18n）保持一致。
 *
 * UI 形态（2026-07-16 重设计，docs/ui-prototype-feedback.html 的 V3
 * 「成功叙事」变体落地）：
 *  - 反馈类型分段（问题/建议/其他）——反馈不只是报 bug；类型经 description
 *    前缀传递（「问题」不加前缀与旧数据同形，别的类型加「类型：」行），
 *    刻意不动 FeedbackSubmitPayload 的 IPC 契约（加字段要连改 ipc-channels/
 *    preload 双件/main handler/feedback-worker 五处，收益配不上）。
 *  - 附件整行热区：点击、拖拽、⌘V 粘贴三条路都通（报 bug 场景截图九成来自
 *    剪贴板）；有图后热区缩成尾部小方块。
 *  - 失败态是可重试的错误条（「内容已为你保留」）——表单内容在 error 态
 *    完整保留，重试直接重跑提交。
 *  - 成功态整卡切换成叙事视图：对勾描线动画（keyframes 在 globals.css 的
 *    fb-disc-pop / fb-check-draw）+ issue 链接卡 + 「再提一条/完成」。
 *  - 排版吃「Notion 精修档」（与重命名/删除弹窗同族）：19px 标题 / 13px
 *    副文 / rounded-2xl / 品牌绿渐变主按钮（disabled 中性灰、transition
 *    只留 opacity/shadow——background-image 不可过渡，2026-07-07 教训）。
 *  - 本弹窗 portal 到 body、脱离 .chat-app 豁免——裸交互元素一律带
 *    data-slot 逃逸 canvas 的裸元素 reset（2026-07-04 事故家族）。
 *
 * 数据面：window.chatApi.submitFeedback —— main 进程补齐 appVersion/
 * platform/osVersion 并签名后转发给 apps/feedback-worker，本组件和 IPC
 * payload 都不接触 GitHub Token（见 electron/main/services/feedbackService.ts）。
 * 纯浏览器直开（无 chatApi）时渲染为空，因为反馈必须走 main 签名，没有
 * 绕过的降级路径。底部小字明示「会附带应用版本与系统信息」——main 确实
 * 在补这些字段，用户应当知情。
 *
 * 截图压缩复用 chat 侧 imageAttachmentAdapter 的 processImageFile——同一套
 * 尺寸/体积预算（Anthropic vision 的 1568px + 3.5MB 上限），恰好落在
 * feedback-worker 每张图 6MB 的收件预算内，不需要另起一份压缩逻辑。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Paperclip, X } from 'lucide-react'

import { Button } from '@/src/components/ui/button'
import { Textarea } from '@/src/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/src/components/ui/dialog'
import { cn } from '@/src/lib/utils'
import { processImageFile } from '@/src/chat/runtime/imageAttachmentAdapter'
import { useDialogStore, type FeedbackKind } from '@/src/chat/stores/dialogs'

const MAX_IMAGES = 4

/** 反馈类型。placeholder 按类型引导；prefix 拼进 description 传给 worker
 * ——「问题」留空保持与旧 payload 同形（bug 是默认场景，别让存量 issue
 * 突然都多出一行类型标）。FeedbackKind 本身定义在 stores/dialogs.ts——
 * 消息操作栏的喜欢/不喜欢按钮（openFeedbackDialog）也要引用同一个类型。 */
const KIND_META: Record<
  FeedbackKind,
  { label: string; placeholder: string; prefix: string }
> = {
  bug: {
    label: '问题',
    placeholder: '发生了什么？你原本期望的是什么？',
    prefix: ''
  },
  idea: {
    label: '建议',
    placeholder: '你希望我们加上或改进什么？',
    prefix: '类型：建议\n\n'
  },
  other: {
    label: '其他',
    placeholder: '想说什么都可以。',
    prefix: '类型：其他\n\n'
  }
}
const KIND_ORDER: readonly FeedbackKind[] = ['bug', 'idea', 'other']

interface PendingImage {
  id: string
  file: File
  previewUrl: string
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; issueUrl: string }
  | { kind: 'error'; message: string }

/** data:image/png;base64,AAAA... → { contentType, dataBase64 } */
function splitDataUrl(dataUrl: string): { contentType: string; dataBase64: string } {
  const commaIdx = dataUrl.indexOf(',')
  const header = dataUrl.slice(5, dataUrl.indexOf(';'))
  return { contentType: header || 'image/png', dataBase64: dataUrl.slice(commaIdx + 1) }
}

export function FeedbackDialog(): React.JSX.Element | null {
  const chatApi = typeof window !== 'undefined' ? window.chatApi : undefined

  const open = useDialogStore((s) => s.open === 'feedback')
  const feedbackPrefill = useDialogStore((s) => s.feedbackPrefill)
  const closeDialog = useDialogStore((s) => s.closeDialog)

  const [kind, setKind] = useState<FeedbackKind>('bug')
  const [description, setDescription] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const [state, setState] = useState<SubmitState>({ kind: 'idle' })
  const [dragActive, setDragActive] = useState(false)
  // 消息操作栏喜欢/不喜欢触发时携带的被评价消息原文——静默附加进
  // description（见 handleSubmit），不进用户可见/可编辑的 textarea。
  const [attachedContext, setAttachedContext] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 打开这一刻（false→true）按 store 里的 feedbackPrefill 预选类型 + 记下
  // 附带上下文；通用入口（rail 菜单/设置页）没有 prefill，维持原样默认值。
  // 依赖数组只放 open——只关心「打开」这个瞬间，prefill 引用变化不重触发。
  useEffect(() => {
    if (!open || !feedbackPrefill) return
    setKind(feedbackPrefill.kind)
    setAttachedContext(feedbackPrefill.context)
  }, [open])

  const resetForm = useCallback(() => {
    setKind('bug')
    setDescription('')
    setImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.previewUrl)
      return []
    })
    setState({ kind: 'idle' })
    setDragActive(false)
    setAttachedContext(null)
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        closeDialog()
        resetForm()
      }
    },
    [closeDialog, resetForm]
  )

  const handleFilesPicked = useCallback((files: File[]) => {
    if (files.length === 0) return
    setImages((prev) => {
      const room = MAX_IMAGES - prev.length
      const picked = files.filter((f) => f.type.startsWith('image/')).slice(0, Math.max(0, room))
      const next = picked.map((file) => ({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        file,
        previewUrl: URL.createObjectURL(file)
      }))
      return [...prev, ...next]
    })
  }, [])

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const target = prev.find((img) => img.id === id)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((img) => img.id !== id)
    })
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!chatApi?.submitFeedback || !description.trim()) return
    setState({ kind: 'submitting' })
    try {
      const encodedImages = await Promise.all(
        images.map(async (img) => {
          const dataUrl = await processImageFile(img.file)
          const { contentType, dataBase64 } = splitDataUrl(dataUrl)
          return { filename: img.file.name || 'screenshot.png', contentType, dataBase64 }
        })
      )
      // 消息级反馈的隐藏上下文块——与下面 KIND_META[kind].prefix 同一手法
      // （静默拼接，不进用户可见的 textarea）：把触发这次反馈的 AI 回复
      // 原文带给处理反馈的人，方便定位是哪条回复的问题。
      const contextBlock = attachedContext
        ? `> 针对以下 AI 回复：\n\n${attachedContext
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')}\n\n---\n\n`
        : ''
      const result = await chatApi.submitFeedback({
        description: contextBlock + KIND_META[kind].prefix + description.trim(),
        images: encodedImages
      })
      if (!result.issueUrl) {
        setState({ kind: 'error', message: result.error ?? 'unknown error' })
        return
      }
      setState({ kind: 'success', issueUrl: result.issueUrl })
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [chatApi, description, images, kind, attachedContext])

  const submitting = state.kind === 'submitting'
  const success = state.kind === 'success'
  const canSubmit = Boolean(description.trim()) && !submitting
  const maxImagesReached = images.length >= MAX_IMAGES

  // 无 chatApi（纯浏览器直开）——反馈必须走 main 签名转发，没有可降级的路径。
  if (!chatApi) return null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="rounded-2xl sm:max-w-[480px]"
        // ⌘V 粘贴截图：挂在弹窗根上，焦点在弹窗内任何位置都收图——报 bug
        // 场景截图九成来自剪贴板，别要求用户先点中某个热区。只在剪贴板里
        // 真有图片文件时拦截默认行为，普通文字粘贴照常进 textarea。
        onPaste={(e) => {
          if (submitting || success || maxImagesReached) return
          const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
            f.type.startsWith('image/')
          )
          if (files.length === 0) return
          e.preventDefault()
          handleFilesPicked(files)
        }}
      >
        {success ? (
          /* ── 成功叙事视图：整卡切换（原型 V3）。表单已经完成使命，让
           * 确认感（对勾）和后续动线（看 issue / 再提一条）占满舞台。 */
          <div className="px-2 pb-1 pt-3 text-center">
            <div className="fb-disc-pop mx-auto mt-2 grid size-14 place-items-center rounded-full bg-[hsl(var(--brand)/0.12)]">
              <svg viewBox="0 0 26 26" className="size-[26px]" aria-hidden>
                <path
                  d="M7 13.5l4.5 4.5L19.5 9"
                  fill="none"
                  stroke="hsl(var(--brand))"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="fb-check-draw"
                />
              </svg>
            </div>
            <h3 className="mt-4 text-[17px] font-semibold">已收到你的反馈</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              我们会尽快跟进，谢谢你的反馈。
            </p>
            <div className="mt-5 flex justify-center gap-2.5">
              <Button
                variant="outline"
                onClick={() => {
                  // 「再提一条」：清空重来但弹窗留着——连报几个问题的用户
                  // 不该每条都重走一遍入口菜单。
                  resetForm()
                }}
              >
                再提一条
              </Button>
              <Button
                className="bg-[linear-gradient(135deg,hsl(var(--brand)),color-mix(in_srgb,hsl(var(--brand))_85%,#000))] text-white shadow-[0_1px_2px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.18)] transition-[opacity,box-shadow] hover:opacity-95"
                onClick={() => handleOpenChange(false)}
              >
                完成
              </Button>
            </div>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-[19px]">问题反馈</DialogTitle>
              <DialogDescription className="text-[13px]">
                告诉我们发生了什么，或想要什么。
              </DialogDescription>
            </DialogHeader>

            {/* 反馈类型分段：胶囊单选。裸 button 带 data-slot 逃逸 canvas
              * reset（portal 子树不在 .chat-app 豁免里）。 */}
            <div className="flex gap-1.5" role="radiogroup" aria-label="反馈类型">
              {KIND_ORDER.map((k) => (
                <button
                  key={k}
                  type="button"
                  data-slot="button"
                  role="radio"
                  aria-checked={kind === k}
                  disabled={submitting}
                  onClick={() => setKind(k)}
                  className={cn(
                    'rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors',
                    kind === k
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground',
                    submitting && 'pointer-events-none opacity-60'
                  )}
                >
                  {KIND_META[k].label}
                </button>
              ))}
            </div>

            {/* 消息级反馈的透明披露：附带内容不进 textarea（用户仍只看到/编辑
              * 自己写的话），但提交前必须让用户知道这条 AI 回复的原文会一并
              * 发出——与下面「提交时会附带应用版本与系统信息」同一诚实披露
              * 原则。 */}
            {attachedContext ? (
              <p className="-mt-1 text-[11.5px] leading-snug text-muted-foreground/80">
                已附带这条 AI 回复的内容，帮助我们定位具体是哪次回答的问题。
              </p>
            ) : null}

            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={KIND_META[kind].placeholder}
              rows={5}
              className="min-h-[120px] rounded-xl text-[15px] leading-relaxed md:text-[15px]"
              disabled={submitting}
            />

            {/* 附件行：缩略图 + 热区。热区在无图时占满整行、写清三条添加
              * 路径；有图后缩成 64px 尾格（此时用户已会用，不用再教）。 */}
            <div className="flex items-stretch gap-2">
              {images.map((img) => (
                <div
                  key={img.id}
                  className="group relative size-16 shrink-0 overflow-hidden rounded-[10px] border border-border"
                >
                  <img src={img.previewUrl} alt="" className="size-full object-cover" />
                  <button
                    type="button"
                    data-slot="button"
                    aria-label="移除截图"
                    onClick={() => removeImage(img.id)}
                    disabled={submitting}
                    className="absolute top-1 right-1 grid size-[18px] place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 disabled:pointer-events-none"
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              ))}
              {!maxImagesReached ? (
                <button
                  type="button"
                  data-slot="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={submitting}
                  // 拖拽落图：dragover 必须 preventDefault 否则 drop 不触发。
                  // 悬停高亮用品牌绿（「即将落下」是积极确认语义，配得上身份
                  // 色）；普通 hover 走中性，绿只留给这一刻。
                  onDragOver={(e) => {
                    e.preventDefault()
                    if (!submitting) setDragActive(true)
                  }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragActive(false)
                    if (submitting) return
                    handleFilesPicked(Array.from(e.dataTransfer?.files ?? []))
                  }}
                  className={cn(
                    'flex min-h-16 items-center justify-center gap-2 rounded-[10px] border-[1.5px] border-dashed text-[12.5px] transition-colors',
                    images.length > 0 ? 'w-16 shrink-0' : 'flex-1',
                    dragActive
                      ? 'border-[hsl(var(--brand)/0.55)] bg-[hsl(var(--brand)/0.05)] text-foreground'
                      : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
                    submitting && 'pointer-events-none opacity-50'
                  )}
                >
                  <Paperclip className="size-3.5 shrink-0" />
                  {images.length === 0 ? (
                    <span>
                      点击、拖拽或{' '}
                      <kbd className="rounded border border-border bg-muted/60 px-1 py-px font-sans text-[11px] text-muted-foreground">
                        ⌘V
                      </kbd>{' '}
                      粘贴截图
                    </span>
                  ) : null}
                </button>
              ) : null}
            </div>
            {images.length > 0 ? (
              <p className="text-[11.5px] text-muted-foreground/80">
                {maxImagesReached ? '已达 4 张上限' : `${images.length} / 4 张截图`}
              </p>
            ) : null}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                // 必须在这里同步转成普通数组：`e.target.files` 是活引用，若把它原样
                // 传给下面 setImages 的 updater 函数（React 会延迟到渲染阶段才执行），
                // 紧接着的 `e.target.value = ''` 会把这同一个 FileList 提前清空，
                // 第二次选图时 updater 读到的就是空列表——症状是"只能加成功一次"。
                const files = Array.from(e.target.files ?? [])
                e.target.value = ''
                handleFilesPicked(files)
              }}
            />

            {state.kind === 'error' ? (
              /* 失败 = 可重试的错误条，表单内容原地保留——用户辛苦写的描述
               * 绝不能因为一次网络失败就要重打。 */
              <div className="flex items-start gap-2 rounded-[10px] border border-destructive/25 bg-destructive/8 px-3 py-2.5 text-[13px] leading-relaxed text-destructive">
                <span className="min-w-0 flex-1">
                  提交失败：{state.message}，内容已为你保留。
                </span>
                <button
                  type="button"
                  data-slot="button"
                  onClick={() => void handleSubmit()}
                  className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
                >
                  重试
                </button>
              </div>
            ) : null}

            <div className="flex flex-col gap-2.5">
              {/* 主按钮整行宽（原型 V3）：弹窗只有这一个主动作，占满一行的
                * 按压感配得上「提交」的分量。渐变/disabled/transition 纪律
                * 与重命名弹窗同源。 */}
              <Button
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                className="h-[42px] w-full bg-[linear-gradient(135deg,hsl(var(--brand)),color-mix(in_srgb,hsl(var(--brand))_85%,#000))] text-white shadow-[0_1px_2px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.18)] transition-[opacity,box-shadow] hover:opacity-95 disabled:bg-none disabled:bg-muted disabled:text-muted-foreground/70 disabled:opacity-100 disabled:shadow-none"
              >
                {submitting ? (
                  <>
                    <Loader2 className="animate-spin" />
                    提交中…
                  </>
                ) : (
                  '提交'
                )}
              </Button>
              {/* 诚实披露：main 会补 appVersion/platform/osVersion，用户
                * 应当在提交前知情，而不是事后在 issue 里发现。 */}
              <p className="text-center text-[11.5px] leading-snug text-muted-foreground/75">
                提交时会附带应用版本与系统信息，帮助我们定位问题。
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
