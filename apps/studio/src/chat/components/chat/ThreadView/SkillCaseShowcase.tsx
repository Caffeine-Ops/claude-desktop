/**
 * 空态 composer 下方的「最佳实践案例」区（原型：WorkBuddy 空态，2026-08-17）。
 *
 * 通用组件：**不知道任何具体技能**。它只做三件事——
 *   1. 从 composer.text 派生「当前选中的技能」（与 ScenarioRail 同一真源、同一
 *      正则 LEADING_SLASH_COMMAND_RE：以 slash 命令开头即视为选中该技能）；
 *   2. 从 stores/scenarioCases 里按裸名取出该技能的案例（后台「客户端技能案例」
 *      页配置，无案例的技能整块不渲染）；
 *   3. 一排封面卡 + 「换一批」顺序翻页 + 点卡片弹详情（大图轮播 / 说明 /
 *      「用这个提示词试试」→ onFillPrompt 走推荐 prompt 的同一条 fillBody 通道）。
 *
 * 所以后台给任何技能配了案例，这里就自动出现，不用改客户端代码。
 *
 * 只在「刚选完技能、正文还空着」时显示（bodyAfterChip === ''）——与 ScenarioRail
 * 的推荐 prompt 行同一判定：正文有了内容，案例的使命（帮忙起草）就完成了，继续
 * 占着 composer 下面一整排会挤掉用户正在看的东西。
 *
 * 图片一律 `<img src=URL>` 直连（服务端与 main 侧都只放行 http/https）；加载失败
 * 的封面退化成纯色底 + 标题，不显示破图。
 */
'use client'

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ScenarioCase } from '@desktop-shared/ipc-channels'

import { Button } from '@/src/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/src/components/ui/dialog'
import { GLASS_DIALOG_SURFACE } from '@/src/components/ui/glassDialogSurface'

import { useT } from '../../../i18n'
import { pageCount, pageSlice, SHOWCASE_PAGE_SIZE } from '../../../lib/scenarioCases'
import { useSkillCases } from './useSkillCases'

export interface SkillCaseShowcaseProps {
  /** 把案例的 prompt 填进 composer 正文（保留 leading chip）。 */
  onFillPrompt: (text: string) => void
}

export function SkillCaseShowcase({ onFillPrompt }: SkillCaseShowcaseProps): React.JSX.Element | null {
  const t = useT()
  const { skillValue, cases, visible } = useSkillCases()

  const [page, setPage] = useState(0)
  const [active, setActive] = useState<ScenarioCase | null>(null)

  // 换技能就回到第一页——上一个技能翻到第 3 页，不该让下一个技能也从第 3 页起。
  useEffect(() => {
    setPage(0)
  }, [skillValue])

  const pages = pageCount(cases.length, SHOWCASE_PAGE_SIZE)
  const pageItems = pageSlice(cases, page, SHOWCASE_PAGE_SIZE)

  if (!visible) return null

  // 高度预算：这一块必须和 hero 标题、rail、composer 一起在 800px 高的窗口里
  // 不滚动放下（用户硬要求，2026-08-17）。EmptyState 在案例可见时会把大标题
  // 收成一行（useSkillCases().visible 同一判定），这里则压紧上边距与卡片比例。
  return (
    <div className="mt-4" data-testid="skill-case-showcase">
      <div className="mb-2 flex items-center justify-between gap-3 px-0.5">
        <span className="text-[13px] text-foreground/80">{t('skillCaseTitle')}</span>
        {pages > 1 ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12.5px] text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
            onClick={() => setPage((p) => (p + 1) % pages)}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            {t('skillCaseShuffle')}
          </button>
        ) : null}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${skillValue}:${page}`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="grid grid-cols-5 gap-3 max-[900px]:grid-cols-3 max-[620px]:grid-cols-2"
        >
          {pageItems.map((c) => (
            <CaseCard key={c.id} item={c} onOpen={() => setActive(c)} openLabel={t('skillCaseOpen')} />
          ))}
        </motion.div>
      </AnimatePresence>

      <CaseDetailDialog
        item={active}
        onClose={() => setActive(null)}
        onUsePrompt={(text) => {
          onFillPrompt(text)
          setActive(null)
        }}
      />
    </div>
  )
}

/* ───────────────────────── 卡片 ───────────────────────── */

function CaseCard({
  item,
  onOpen,
  openLabel
}: {
  item: ScenarioCase
  onOpen: () => void
  openLabel: string
}): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${openLabel}: ${item.title}`}
      className="group relative aspect-[16/10] overflow-hidden rounded-[12px] border border-border/60 bg-muted text-left transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-[2px] hover:border-border hover:shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--accent))] active:-translate-y-px"
    >
      {!broken ? (
        <img
          src={item.cover}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setBroken(true)}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
      ) : (
        <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_20%_0%,hsl(var(--accent)/0.18),transparent_60%)]" />
      )}
      {/* 底部渐变压暗，保证白字标题在任何封面上都可读 */}
      <div className="absolute inset-x-0 bottom-0 h-[62%] bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
      <span className="absolute inset-x-0 bottom-0 line-clamp-2 px-2.5 pb-2 text-[12.5px] font-semibold leading-snug text-white drop-shadow-sm">
        {item.title}
      </span>
    </button>
  )
}

/* ───────────────────────── 详情弹窗 ───────────────────────── */

function CaseDetailDialog({
  item,
  onClose,
  onUsePrompt
}: {
  item: ScenarioCase | null
  onClose: () => void
  onUsePrompt: (text: string) => void
}): React.JSX.Element {
  const t = useT()
  // 大图列表：详情图为空时退化成只看封面。
  const images = item ? (item.images.length > 0 ? item.images : [item.cover]) : []
  const [index, setIndex] = useState(0)
  useEffect(() => {
    setIndex(0)
  }, [item?.id])
  const current = images[Math.min(index, Math.max(images.length - 1, 0))]

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className={`${GLASS_DIALOG_SURFACE} sm:max-w-[720px]`}>
        {item ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-[19px]">{item.title}</DialogTitle>
              {item.description ? (
                <DialogDescription className="whitespace-pre-line text-[13px] leading-relaxed">
                  {item.description}
                </DialogDescription>
              ) : (
                <DialogDescription className="sr-only">{item.title}</DialogDescription>
              )}
            </DialogHeader>

            {/* 大图 + 左右切换 */}
            <div className="relative overflow-hidden rounded-xl border border-border/60 bg-muted">
              <div className="aspect-video w-full">
                {current ? (
                  <img
                    key={current}
                    src={current}
                    alt=""
                    draggable={false}
                    className="h-full w-full object-contain"
                  />
                ) : null}
              </div>
              {images.length > 1 ? (
                <>
                  <button
                    type="button"
                    aria-label={t('skillCasePrev')}
                    className="absolute left-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm transition hover:bg-black/60"
                    onClick={() => setIndex((i) => (i - 1 + images.length) % images.length)}
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    aria-label={t('skillCaseNext')}
                    className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm transition hover:bg-black/60"
                    onClick={() => setIndex((i) => (i + 1) % images.length)}
                  >
                    ›
                  </button>
                  <span className="absolute bottom-2 right-2.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] tabular-nums text-white backdrop-blur-sm">
                    {index + 1} / {images.length}
                  </span>
                </>
              ) : null}
            </div>

            {/* 提示词预览 */}
            <div className="rounded-xl bg-foreground/[0.04] px-3.5 py-3 dark:bg-white/[0.05]">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('skillCasePromptLabel')}
              </div>
              <div className="line-clamp-4 whitespace-pre-line text-[13px] leading-relaxed text-foreground/90">
                {item.prompt}
              </div>
            </div>

            <DialogFooter>
              <Button type="button" onClick={() => onUsePrompt(item.prompt)}>
                {t('skillCaseUsePrompt')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
