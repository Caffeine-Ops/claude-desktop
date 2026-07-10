import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ListChecks, MoreHorizontal } from 'lucide-react'

import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/src/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/src/components/ui/dropdown-menu'
import { Button } from '@/src/components/ui/button'
import { useI18n, useT } from '../../../i18n'
import { useChatStore } from '../../../stores/chat'
import {
  useImageEditStore,
  useSheetPreviewStore,
  useSplitWorkspaceBusy
} from '../../../stores/filePreview'
import { deliverableKind, DELIVERABLE_PATH_RE } from './AssistantMessage'
import { detectImageGen } from './ImageGenCard'

/* ─────────────────────── session outputs popover ─────────────────────── */

/**
 * Every deliverable-looking path the foreground session has produced, newest
 * first. Two detection sources, mirroring what already renders inline so the
 * panel never surprises the user with a file they haven't seen a card for:
 *
 *   - Prose mentions (AssistantDeliverables' contract): any assistant text
 *     matching DELIVERABLE_PATH_RE — the "here are your files" moment at the
 *     end of a ppt-master / spreadsheets run.
 *   - Generated images (ImageGenCard's contract): imagegen/gpt-image-2 Bash
 *     calls, whose result stdout carries the output paths — these rarely get
 *     re-mentioned in prose, so the text scan alone would miss them.
 *
 * Candidates are deduped by path and verified against disk via statFiles in
 * one batch (same pattern as AssistantDeliverables) — a path the model only
 * *mentioned* never earns a row.
 */
function useSessionOutputs(): { files: readonly string[]; loading: boolean } {
  const messages = useChatStore((s) => s.messages)
  const candidatesKey = useMemo(() => {
    const seen = new Set<string>()
    for (const m of messages) {
      const running =
        (m as { status?: { type?: string } }).status?.type === 'running'
      const content = (m as { content?: readonly unknown[] }).content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        const p = part as { type?: string; text?: string; [k: string]: unknown }
        if (!running && p.type === 'text' && typeof p.text === 'string') {
          for (const match of p.text.matchAll(DELIVERABLE_PATH_RE)) {
            seen.add(match[0])
          }
        }
        if (p.type === 'tool-call' && p.toolName === 'Bash') {
          const settled = typeof p.endedAt === 'number'
          if (!settled) continue
          const info = detectImageGen(p.args, p.result, false)
          if (info) for (const path of info.paths) seen.add(path)
        }
      }
    }
    return [...seen].slice(0, 40).join('\n')
  }, [messages])

  const [files, setFiles] = useState<readonly string[]>([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!candidatesKey) {
      setFiles([])
      return
    }
    let cancelled = false
    setLoading(true)
    void window.chatApi
      .statFiles({ paths: candidatesKey.split('\n') })
      .then((r) => {
        if (!cancelled) setFiles([...r.files].reverse())
      })
      .catch(() => {
        /* transient IPC failure — keep the previous list */
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [candidatesKey])

  return { files, loading }
}

/** One row in the outputs popover: type badge + filename (click = smart open,
 *  same branching as DeliverableCard) plus a 更多 menu offering an explicit
 *  「打开」（system app）/「在文件夹中显示」pair — mirrors DeliverableCard's
 *  「打开方式」pill so the same file behaves identically whether the user
 *  meets it inline in a message or here in the aggregated list. */
function OutputRow({ path }: { path: string }): React.JSX.Element {
  const lang = useI18n((s) => s.lang)
  const zh = lang === 'zh'
  const name = path.split('/').pop() ?? path
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const kind = deliverableKind(ext)
  const previewableSheet = ext === 'xlsx' || ext === 'xls' || ext === 'csv'
  const editableImage = ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp'
  const splitBusy = useSplitWorkspaceBusy()

  const openExternal = (): void => {
    void window.chatApi.openPath({ absPath: path })
  }

  const open = (): void => {
    if (previewableSheet && !splitBusy) {
      useSheetPreviewStore.getState().openPreview(path)
      return
    }
    if (editableImage && !splitBusy) {
      useImageEditStore.getState().openEditor(path)
      return
    }
    openExternal()
  }

  return (
    <div className="group/orow flex items-center gap-1 rounded-xl px-2 py-2 transition-colors hover:bg-muted/50">
      <button
        type="button"
        onClick={open}
        title={path}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <span
          aria-hidden
          className={
            'grid size-6 shrink-0 place-items-center rounded-md text-[9px] font-bold text-white ' +
            kind.badgeClass
          }
        >
          {kind.isImage ? (
            <svg viewBox="0 0 20 20" className="size-3.5 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
              <circle cx="7.2" cy="8" r="1.4" fill="currentColor" stroke="none" />
              <path d="M4 14.5l4-4 3 3 2.5-2.5 2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            kind.badge
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground group-hover/orow:underline">
          {name}
        </span>
        <span className="shrink-0 text-[10.5px] text-muted-foreground">
          {zh ? kind.zh : kind.en}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={zh ? '更多' : 'More'}
            title={zh ? '更多' : 'More'}
            className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/orow:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={openExternal}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5M4 16h12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {zh ? '打开' : 'Open'}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void window.chatApi.revealPath({ absPath: path })
            }}
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path
                d="M3 5.5h5l1.5 2h7.5v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11z"
                strokeLinejoin="round"
              />
            </svg>
            {zh ? '在文件夹中显示' : 'Reveal in folder'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** Chat header entry point: icon button + popover listing every deliverable
 *  the foreground session has produced so far (see useSessionOutputs). */
export function OutputsButton(): React.JSX.Element {
  const t = useT()
  const { files } = useSessionOutputs()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('chatHeaderOutputs')}
          title={t('chatHeaderOutputs')}
          className="relative shrink-0 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
        >
          <ListChecks className="size-4" />
          {/* 数量徽标：0 不渲染（没产出物就没有角标可言）。key={files.length}
              让数字每次变化都触发一次全新挂载——不只是新增出现时弹一下，
              数字本身递增/递减也重播同一下 spring pop，读作"这里有变化"。 */}
          <AnimatePresence>
            {files.length > 0 ? (
              <motion.span
                key={files.length}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 500, damping: 22 }}
                className="absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-brand px-[3px] text-[9px] font-semibold leading-none text-brand-foreground"
              >
                {files.length > 99 ? '99+' : files.length}
              </motion.span>
            ) : null}
          </AnimatePresence>
        </Button>
      </PopoverTrigger>
      {/* 圆角/阴影配方与 AssistantDeliverables 的成果卡片同源（"浮在内容上的
          柔和卡片"语言），比 popover 基件默认的 rounded-md + shadow-md 更贴合
          参考设计的圆润浮层观感；border 淡化到 /50 而非基件默认 border-border，
          浮层本身已靠阴影立起来，粗边框反而显生硬。 */}
      <PopoverContent
        align="end"
        className="w-80 rounded-[20px] border-border/50 p-4 shadow-[0_2px_8px_rgba(0,0,0,0.06),0_16px_40px_-20px_rgba(0,0,0,0.35)]"
      >
        <div className="flex items-center px-0.5 pb-3">
          <span className="text-[14px] font-semibold text-foreground">
            {t('chatHeaderOutputs')}
          </span>
          {files.length > 0 ? (
            <span className="ml-2 text-[12px] text-muted-foreground">{files.length}</span>
          ) : null}
        </div>
        {files.length === 0 ? (
          <div className="px-0.5 pb-1 text-[13px] text-muted-foreground/80">
            {t('chatHeaderOutputsEmpty')}
          </div>
        ) : (
          <div className="max-h-[360px] space-y-0.5 overflow-y-auto">
            {files.map((f) => (
              <OutputRow key={f} path={f} />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
