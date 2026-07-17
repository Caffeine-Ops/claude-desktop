import { useEffect, useState } from 'react'
import {
  PROPOSAL_TEMPLATES,
  mergeTemplateSwitch,
  FONT_ORDER,
  SIZE_ORDER,
  MARGIN_LABEL,
  type ProposalStyleConfig,
  type ProposalTemplateKey,
  type ProposalLevelStyle,
  type ProposalFontName,
  type ProposalSizeName,
  type ProposalAlign
} from '@desktop-shared/proposalStyle'
import { useProposalStyleStore } from '../../stores/proposalStyle'
import { ProposalPreview } from './ProposalPreview'
import { XIcon, RotateCcwIcon } from './proposalIcons'

/**
 * 「样式模板」弹窗：左侧实时预览（复用 ProposalPreview 的真 PDF 渲染——printToPDF 出真 PDF 塞
 * <iframe>，传入本地 draft 样式，故边调边看、且与最终导出逐字节一致），右侧模板选择 + 逐级别微调。
 *
 * 重设计 A 后【纯调样式、不再是导出入口】——导出统一收敛到草稿页顶栏的「导出 ▾」下拉，消除
 * 「两处导出」。本弹窗只负责把样式调好并【应用】到 store；应用后用户回下拉选格式导出。
 *
 * draft 模式：进入时从 store 的已生效样式拷一份 draft，所有微调只动 draft；点「应用样式」
 * 才 setConfig(draft) 提交（让编辑/预览面板与后续导出都用新样式）。点「取消」丢弃 draft，
 * store 不变。
 */

// 五个可调层级行：封面标题映射到「文档第一个一级标题」，其余按 markdown 标题层级。
const ROWS: { key: 'title' | 'h1' | 'h2' | 'h3' | 'body'; label: string; sub: string }[] = [
  { key: 'title', label: '封面标题', sub: '文档大标题' },
  { key: 'h1', label: '一级标题', sub: '# 第一章' },
  { key: 'h2', label: '二级标题', sub: '## 第一节' },
  { key: 'h3', label: '三级标题', sub: '### 一、' },
  { key: 'body', label: '正文', sub: '段落正文' }
]

const TEMPLATE_META: { key: ProposalTemplateKey; name: string; desc: string }[] = [
  { key: 'classic', name: '经典正式', desc: '公文标书体 · 宋黑搭配' },
  { key: 'business', name: '简洁商务', desc: '无衬线 · 靛蓝点缀' },
  { key: 'academic', name: '专业学术', desc: '宋体 Times · 严谨紧凑' }
]

const ALIGN_OPTS: { value: ProposalAlign; label: string }[] = [
  { value: 'left', label: '左' },
  { value: 'center', label: '中' },
  { value: 'justify', label: '两端' }
]

export function ProposalStyleModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const committed = useProposalStyleStore((s) => s.config)
  const setConfig = useProposalStyleStore((s) => s.setConfig)
  const [draft, setDraft] = useState<ProposalStyleConfig>(committed)

  // 每次打开时以当前已生效样式为起点重置 draft（关掉再开不残留上次未提交的微调）。
  useEffect(() => {
    if (open) setDraft(structuredClone(committed))
    // committed 仅在打开瞬间取一次；不进依赖，避免微调期间被外部变更打断。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  // 选模板卡：智能合并——保留用户已微调的字段，只换走「没动过的」字段（见 mergeTemplateSwitch）。
  // 切模板不再丢全部微调；点当前已选中的卡是 no-op。彻底复位走下方「还原模板默认」按钮。
  const selectTemplate = (key: ProposalTemplateKey): void =>
    setDraft((d) => mergeTemplateSwitch(d, key))

  // 还原模板默认：丢弃当前模板上的所有微调，整份回到该模板纯默认（与智能合并的「保留」相反，
  // 这是显式的「我要重来」入口）。
  const resetToTemplateDefault = (): void =>
    setDraft((d) => structuredClone(PROPOSAL_TEMPLATES[d.templateKey]))

  const patchLevel = (
    rowKey: (typeof ROWS)[number]['key'],
    patch: Partial<ProposalLevelStyle>
  ): void => setDraft((d) => ({ ...d, [rowKey]: { ...d[rowKey], ...patch } }))

  const patchField = (patch: Partial<ProposalStyleConfig>): void =>
    setDraft((d) => ({ ...d, ...patch }))

  // 应用样式：把 draft 提交进 store（编辑/预览面板与后续导出都随之用新样式），然后关闭。
  // 不再触发导出——导出走草稿页顶栏的「导出 ▾」下拉。
  const doApply = (): void => {
    setConfig(draft)
    onClose()
  }

  const selectCls =
    'h-7 rounded-md border border-border bg-card px-1.5 text-[12px] text-foreground outline-none focus:border-accent'

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-6">
      {/* 背景遮罩 */}
      <button
        type="button"
        aria-label="关闭"
        tabIndex={-1}
        className="proposal-anim-fade absolute inset-0 cursor-default bg-black/45 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* 弹窗主体 */}
      <div className="proposal-anim-pop relative flex h-[min(760px,calc(100vh-56px))] w-[min(1180px,100%)] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div>
            <div className="text-[15px] font-medium text-foreground">样式模板</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              选择风格 → 左侧实时预览 → 微调字体字号 → 应用（导出走顶栏「导出 ▾」）
            </div>
          </div>
          <button
            className="grid size-8 place-items-center rounded-lg border border-border text-muted-foreground hover:bg-hover hover:text-foreground"
            onClick={onClose}
            aria-label="关闭"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {/* 主体两栏 */}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,42%)_1fr]">
          {/* 左：实时预览（真 PDF，与导出一致）。必须是 flex-col：ProposalPreview 根用 flex-1 撑
              满高度，而 grid 单元格是 block、flex-1 不生效 → 预览拿不到框定高度、内部滚动视口建不
              起来，多页内容滚不到（实测 bug）。与右栏 / 主面板的 flex min-h-0 容器对齐即修复。 */}
          <div className="flex min-h-0 flex-col border-r border-border">
            <ProposalPreview active styleConfig={draft} />
          </div>

          {/* 右：控制台 */}
          <div className="flex min-h-0 flex-col">
            <div className="flex-1 space-y-5 overflow-auto px-5 py-4">
              {/* 模板卡片 */}
              <div>
                <div className="mb-2.5 flex items-center justify-between">
                  <span className="text-[13px] font-semibold text-foreground">标书下载风格</span>
                  <span className="text-[11px] text-muted-foreground">默认套用「经典正式」</span>
                </div>
                <div className="grid grid-cols-3 gap-2.5">
                  {TEMPLATE_META.map((t) => {
                    const activeTpl = draft.templateKey === t.key
                    return (
                      <button
                        key={t.key}
                        onClick={() => selectTemplate(t.key)}
                        className={
                          'relative rounded-lg border px-2.5 py-2.5 text-left transition ' +
                          (activeTpl
                            ? 'border-accent bg-accent/10 ring-2 ring-accent/15'
                            : 'border-border bg-card hover:border-muted-foreground/40')
                        }
                      >
                        {t.key === 'classic' && (
                          <span className="absolute right-1.5 top-1.5 rounded bg-accent px-1 py-px text-[10px] font-semibold text-white">
                            默认
                          </span>
                        )}
                        <MiniPreview tplKey={t.key} />
                        <div
                          className={
                            'text-[12px] font-semibold ' +
                            (activeTpl ? 'text-accent' : 'text-foreground')
                          }
                        >
                          {t.name}
                        </div>
                        <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                          {t.desc}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* 品牌化开关（P2-1）：Fusion Ai 页眉横幅 logo + 封面 logo。左侧预览实时反映；
                  关掉回退裸样式（无品牌），不破坏现有方案。 */}
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <input
                  type="checkbox"
                  checked={draft.brand}
                  onChange={(e) => patchField({ brand: e.target.checked })}
                  className="size-4 accent-accent"
                />
                <span className="text-[12px] font-medium text-foreground">Fusion Ai 品牌</span>
                <span className="text-[11px] text-muted-foreground">每页页眉 logo + 封面 logo</span>
              </label>

              {/* 风格名 + 还原 */}
              <div className="flex items-end gap-3">
                <label className="flex-1">
                  <span className="mb-1.5 block text-[11px] text-muted-foreground">风格名称</span>
                  <input
                    value={draft.name}
                    onChange={(e) => patchField({ name: e.target.value })}
                    className="h-8 w-full rounded-md border border-border bg-card px-2.5 text-[12px] text-foreground outline-none focus:border-accent"
                  />
                </label>
                <button
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border px-3 text-[11px] text-accent hover:bg-accent/5"
                  onClick={resetToTemplateDefault}
                  title="放弃微调，回到该模板默认值"
                >
                  <RotateCcwIcon />
                  还原模板默认
                </button>
              </div>

              {/* 高级折叠（方案二）：模板默认值覆盖 99% 场景，逐级字体/字号/排版微调收进
                  details 默认折叠，把「导出」从重弹窗解放出来——选个模板就能导出，无需逐级调。 */}
              <details className="rounded-lg border border-border bg-card/40 px-3 py-2">
                <summary className="cursor-pointer select-none text-[12px] text-muted-foreground">
                  高级 · 逐级字体字号与排版（一般无需调整）
                </summary>
                <div className="mt-3 space-y-5">
              {/* 格式表 */}
              <div>
                <div className="mb-2 text-[13px] font-semibold text-foreground">标题格式</div>
                <div className="space-y-2">
                  {ROWS.map((r) => {
                    const cfg = draft[r.key]
                    return (
                      <div
                        key={r.key}
                        className="grid grid-cols-[68px_1fr] items-center gap-3 rounded-lg border border-border bg-card px-2.5 py-2"
                      >
                        <div className="text-[12px] font-semibold leading-tight text-accent">
                          {r.label}
                          <div className="text-[10px] font-normal text-muted-foreground">{r.sub}</div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <select
                            className={selectCls + ' w-[84px]'}
                            value={cfg.font}
                            onChange={(e) =>
                              patchLevel(r.key, { font: e.target.value as ProposalFontName })
                            }
                          >
                            {FONT_ORDER.map((f) => (
                              <option key={f} value={f}>
                                {f}
                              </option>
                            ))}
                          </select>
                          <select
                            className={selectCls + ' w-[68px]'}
                            value={cfg.size}
                            onChange={(e) =>
                              patchLevel(r.key, { size: e.target.value as ProposalSizeName })
                            }
                          >
                            {SIZE_ORDER.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => patchLevel(r.key, { bold: !cfg.bold })}
                            className={
                              'grid size-7 place-items-center rounded-md border font-serif text-[13px] font-bold ' +
                              (cfg.bold
                                ? 'border-accent bg-accent text-white'
                                : 'border-border bg-card text-muted-foreground')
                            }
                          >
                            B
                          </button>
                          <div className="inline-flex overflow-hidden rounded-md border border-border">
                            {ALIGN_OPTS.map((a) => (
                              <button
                                key={a.value}
                                onClick={() => patchLevel(r.key, { align: a.value })}
                                className={
                                  'border-r border-border px-2 py-1 text-[11px] last:border-r-0 ' +
                                  (cfg.align === a.value
                                    ? 'bg-accent text-white'
                                    : 'bg-card text-muted-foreground hover:bg-hover')
                                }
                              >
                                {a.label}
                              </button>
                            ))}
                          </div>
                          <select
                            className={selectCls + ' w-[92px]'}
                            value={cfg.indentChars}
                            onChange={(e) =>
                              patchLevel(r.key, { indentChars: Number(e.target.value) })
                            }
                          >
                            <option value={0}>无缩进</option>
                            <option value={1}>首行 1 字</option>
                            <option value={2}>首行 2 字</option>
                          </select>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* 全局排版 */}
              <div>
                <div className="mb-2 text-[13px] font-semibold text-foreground">全局排版</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <Slider
                    label="行间距"
                    value={draft.lineMultiple}
                    display={draft.lineMultiple.toFixed(2)}
                    min={1.2}
                    max={2.4}
                    step={0.05}
                    onChange={(v) => patchField({ lineMultiple: v })}
                  />
                  <Slider
                    label="段后距"
                    value={draft.spaceAfterPt}
                    display={`${draft.spaceAfterPt}pt`}
                    min={0}
                    max={24}
                    step={1}
                    onChange={(v) => patchField({ spaceAfterPt: v })}
                  />
                  <label className="block">
                    <span className="mb-1.5 block text-[11px] text-muted-foreground">
                      页边距 · <b className="font-semibold text-accent">{MARGIN_LABEL[draft.margin]}</b>
                    </span>
                    <select
                      className={selectCls + ' w-full'}
                      value={draft.margin}
                      onChange={(e) =>
                        patchField({ margin: e.target.value as ProposalStyleConfig['margin'] })
                      }
                    >
                      <option value="narrow">窄</option>
                      <option value="normal">中</option>
                      <option value="wide">宽</option>
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] text-muted-foreground">有序列表</span>
                      <select
                        className={selectCls + ' w-full'}
                        value={draft.ol}
                        onChange={(e) =>
                          patchField({ ol: e.target.value as ProposalStyleConfig['ol'] })
                        }
                      >
                        <option value="decimal">1. 2. 3.</option>
                        <option value="lowerLetter">a. b. c.</option>
                        <option value="lowerRoman">i. ii. iii.</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] text-muted-foreground">无序列表</span>
                      <select
                        className={selectCls + ' w-full'}
                        value={draft.ul}
                        onChange={(e) =>
                          patchField({ ul: e.target.value as ProposalStyleConfig['ul'] })
                        }
                      >
                        <option value="disc">● 实心圆</option>
                        <option value="circle">○ 空心圆</option>
                        <option value="square">■ 方块</option>
                      </select>
                    </label>
                  </div>
                </div>
              </div>
                </div>
              </details>
            </div>

            {/* 底部操作 */}
            <div className="flex items-center justify-end gap-2.5 border-t border-border px-5 py-3.5">
              <button
                className="rounded-lg border border-border px-3.5 py-2 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground"
                onClick={onClose}
              >
                取消
              </button>
              <button
                className="rounded-lg bg-accent px-5 py-2 text-[13px] font-semibold text-white hover:opacity-90"
                onClick={doApply}
                title="把当前样式应用到草稿，之后用顶栏「导出 ▾」导出 Word / PDF"
              >
                应用样式
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// 模板卡片里的迷你版式缩略：用色块比划标题/正文层次，不同模板节奏不同。
function MiniPreview({ tplKey }: { tplKey: ProposalTemplateKey }): React.JSX.Element {
  const accent = tplKey === 'business'
  const center = tplKey !== 'business'
  return (
    <div className="mb-2 h-12 rounded border border-border bg-background p-1.5">
      <div
        className={
          'mb-1 h-1.5 rounded ' +
          (accent ? 'bg-accent' : 'bg-foreground/70') +
          (center ? ' mx-auto w-3/5' : ' w-3/5')
        }
      />
      <div className="mb-0.5 h-1 w-2/5 rounded bg-foreground/40" />
      <div className="h-0.5 w-full rounded bg-foreground/20" />
      <div className="mt-0.5 h-0.5 w-11/12 rounded bg-foreground/20" />
      <div className="mt-0.5 h-0.5 w-4/5 rounded bg-foreground/20" />
    </div>
  )
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange
}: {
  label: string
  value: number
  display: string
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
        {label}
        <b className="font-semibold text-accent">{display}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-accent"
      />
    </label>
  )
}
