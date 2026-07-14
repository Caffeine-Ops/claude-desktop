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
 * 数据面：window.chatApi.submitFeedback —— main 进程补齐 appVersion/
 * platform/osVersion 并签名后转发给 apps/feedback-worker，本组件和 IPC
 * payload 都不接触 GitHub Token（见 electron/main/services/feedbackService.ts）。
 * 纯浏览器直开（无 chatApi）时渲染为空，因为反馈必须走 main 签名，没有
 * 绕过的降级路径。
 *
 * 截图压缩复用 chat 侧 imageAttachmentAdapter 的 processImageFile——同一套
 * 尺寸/体积预算（Anthropic vision 的 1568px + 3.5MB 上限），恰好落在
 * feedback-worker 每张图 6MB 的收件预算内，不需要另起一份压缩逻辑。
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { Loader2, Paperclip, X } from 'lucide-react'

import { Button } from '@/src/components/ui/button'
import { Textarea } from '@/src/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/src/components/ui/dialog'
import { cn } from '@/src/lib/utils'
import { processImageFile } from '@/src/chat/runtime/imageAttachmentAdapter'
import { useDialogStore } from '@/src/chat/stores/dialogs'

const MAX_IMAGES = 4

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
  const closeDialog = useDialogStore((s) => s.closeDialog)

  const [description, setDescription] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const [state, setState] = useState<SubmitState>({ kind: 'idle' })
  const fileInputRef = useRef<HTMLInputElement>(null)

  const resetForm = useCallback(() => {
    setDescription('')
    setImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.previewUrl)
      return []
    })
    setState({ kind: 'idle' })
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
      const result = await chatApi.submitFeedback({
        description: description.trim(),
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
  }, [chatApi, description, images])

  const submitting = state.kind === 'submitting'
  const canSubmit = Boolean(description.trim()) && !submitting
  const maxImagesReached = images.length >= MAX_IMAGES

  const statusNode = useMemo(() => {
    if (state.kind === 'success') {
      return (
        <p className="text-sm text-[var(--brand)]">
          感谢反馈，我们已收到！{' '}
          <a
            className="underline hover:no-underline"
            href={state.issueUrl}
            target="_blank"
            rel="noreferrer"
          >
            查看反馈
          </a>
        </p>
      )
    }
    if (state.kind === 'error') {
      return <p className="text-sm text-destructive">提交失败：{state.message}</p>
    }
    return null
  }, [state])

  // 无 chatApi（纯浏览器直开）——反馈必须走 main 签名转发，没有可降级的路径。
  if (!chatApi) return null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>问题反馈</DialogTitle>
          <DialogDescription>描述你遇到的问题，最多可以附 4 张截图。</DialogDescription>
        </DialogHeader>

        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="发生了什么？你原本期望的是什么？"
          rows={5}
          disabled={submitting || state.kind === 'success'}
        />

        <div className="flex flex-wrap gap-2">
          {images.map((img) => (
            <div
              key={img.id}
              className="group relative size-16 shrink-0 overflow-hidden rounded-md border border-border"
            >
              <img src={img.previewUrl} alt="" className="size-full object-cover" />
              <button
                type="button"
                data-slot="button"
                onClick={() => removeImage(img.id)}
                disabled={submitting || state.kind === 'success'}
                className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 disabled:pointer-events-none"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          {!maxImagesReached && state.kind !== 'success' ? (
            <button
              type="button"
              data-slot="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={submitting}
              className={cn(
                'grid size-16 shrink-0 place-items-center rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground',
                submitting && 'pointer-events-none opacity-50'
              )}
            >
              <Paperclip className="size-4" />
            </button>
          ) : null}
        </div>
        {maxImagesReached && state.kind !== 'success' ? (
          <p className="text-xs text-muted-foreground">最多只能添加 4 张截图</p>
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

        {statusNode}

        <DialogFooter>
          {state.kind === 'success' ? (
            <Button onClick={() => handleOpenChange(false)}>关闭</Button>
          ) : (
            <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" />
                  提交中…
                </>
              ) : (
                '提交'
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
