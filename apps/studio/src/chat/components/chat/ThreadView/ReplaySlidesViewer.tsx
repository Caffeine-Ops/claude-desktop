/**
 * 回放形态的「预览幻灯片」tab 体——SlidesWorkspace 在 replay 会话里用它
 * 替换 LivePreviewEditor（后者依赖 ppt-master 的 live 预览 server，回放
 * 时早已不在）。数据源是【录像包里的 svg 资产】，零服务依赖。
 *
 * 页数与页序的权威来源是 manifest.meta.slides（导出时在导出机上落定，
 * 见 replayPackage.deriveSlides）——不能从消息扫 svg 自推：消息里混着
 * ppt-master 的模板参考图（13 页会被扫成 17 页），且导入重写后文件名是
 * 内容哈希，按名排序=按哈希排序。消息扫描只用来做【揭示判定】：清单里
 * 某页的路径在已播消息文本中出现 = 这页「生成到了」，进缩略列（重现
 * 幻灯片逐页出现的过程感）。旧格式包没有清单 → 退回全量扫描兜底（页序
 * 尽力而为）。
 *
 * 就绪进度写 usePreviewReadinessStore（tab 栏右端的「N / M 已就绪」胶囊
 * ——与 live 的 LivePreviewEditor 同一根管子），卸载清空。
 */
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { useChatStore } from '../../../stores/chat'
import { useT } from '../../../i18n'
import { usePreviewReadinessStore } from '../LivePreviewEditor'
import { isReplaySessionId, useReplayStore, type ReplaySlide } from '../../../replay/replayStore'

/** 与 main 侧资产收集同款的 svg 路径匹配（JSON 转义形态，parse 还原）。
 *  排除反斜杠的理由同 replayPackage.IMAGE_PATH_RE——扫描对象 stringify
 *  产物时，`\n`/`\"` 转义序列必须让匹配立即停，否则跨段吞路径。 */
const SVG_PATH_RE = /\/(?:[^\n"'`\\]+?)\.svg/gi

type MsgLike = { content?: unknown }

/**
 * part 级扫描缓存 + 字段级抽取。两层防线，都为同一件事：回放的揭示扫描
 * 绝不能是 O(会话全部内容)。
 *
 * ① 缓存（WeakMap）：回放每 tick（33ms）更新 messages，chat store 的更新
 *    是不可变的——只有正在流式的最后一个 part 换新引用，已完成 part 引用
 *    永远稳定。按 part 对象缓存后每 tick 只重扫那一个流式 part。
 *    （2026-07-13 第一轮事故：全量重扫每 tick 跑，播到 SVG 密集段主线程
 *    饱和 + GC 风暴，UI 冻死。）
 * ② 字段级抽取：缓存救不了「首扫」——seek 一次性灌入全部历史，每个 part
 *    都是新引用要扫第一次。原实现对整个 args/result JSON.stringify 再正则
 *    全文，13 页 SVG 源码（几十 KB × 多轮编辑）全被喂给正则——CPU profile
 *    实测 seek 到 15 分钟冻结 4.4s，54% 在这个正则、15% 在 GC。而揭示要找
 *    的磁盘路径只会出现在 file_path/command 这类【小字符串字段】和 result
 *    文本里，文件内容字段（Write.content 的 SVG 源码）根本不含它——按
 *    字段递归、跳过长字符串后，全量首扫从秒级降到毫秒级。
 */
const partScanCache = new WeakMap<object, string[]>()

/** 单段文本抽 svg 路径。正则字符集排除引号/反斜杠，原始文本与 JSON 转义
 *  两种形态通吃（对不含转义的匹配段，JSON.parse 还原是恒等操作）。 */
function extractInto(text: string, out: string[]): void {
  for (const match of text.matchAll(SVG_PATH_RE)) {
    try {
      out.push(JSON.parse(`"${match[0]}"`) as string)
    } catch {
      /* 截断的转义碎片 → 跳过 */
    }
  }
}

/** 超过这个长度的字符串字段视为「文件内容/长日志」跳过——揭示路径都在
 *  短字段（file_path ~100B、Bash command 几百 B）或几 KB 的 result 文本
 *  里。极端情况下某页只在超长日志中段被首次提及会揭示滞后到下次出现，
 *  可接受（页序页数由 manifest 清单保证，这里只影响出现时刻）。 */
const MAX_FIELD_SCAN = 4096

/** 流式 argsText 只扫头部：file_path 是模型吐出的第一个字段，2KB 内必到；
 *  后面跟着的几十 KB SVG content 不含磁盘路径。写完 finalize 后 args 变
 *  对象，字段级扫描兜住全量。 */
const ARGS_TEXT_SCAN_HEAD = 2048

function scanValue(v: unknown, out: string[], depth: number): void {
  if (typeof v === 'string') {
    if (v.length <= MAX_FIELD_SCAN) extractInto(v, out)
    return
  }
  if (depth <= 0 || v === null || typeof v !== 'object') return
  if (Array.isArray(v)) {
    for (const x of v) scanValue(x, out, depth - 1)
    return
  }
  for (const x of Object.values(v)) scanValue(x, out, depth - 1)
}

function scanPart(p: Record<string, unknown>): string[] {
  const hit = partScanCache.get(p)
  if (hit) return hit
  const found: string[] = []
  if (p.type === 'text' && typeof p.text === 'string') {
    extractInto(p.text.slice(0, 65536), found)
  } else if (p.type === 'tool-call') {
    scanValue(p.args, found, 2)
    if (typeof p.argsText === 'string') {
      extractInto(p.argsText.slice(0, ARGS_TEXT_SCAN_HEAD), found)
    }
    // result 常见形态：整段 string，或 {content:[{type:'text',text}]} 块。
    if (typeof p.result === 'string') {
      if (p.result.length <= MAX_FIELD_SCAN * 4) extractInto(p.result, found)
    } else {
      scanValue(p.result, found, 3)
    }
  }
  partScanCache.set(p, found)
  return found
}

/** 扫已播消息里出现过的 svg 路径（tool args/argsText/result + 正文）。 */
function scanSvgPaths(messages: readonly MsgLike[]): Set<string> {
  const seen = new Set<string>()
  for (const m of messages) {
    const parts = Array.isArray(m.content) ? m.content : []
    for (const p of parts as Array<Record<string, unknown>>) {
      for (const path of scanPart(p)) seen.add(path)
    }
  }
  return seen
}

export interface ReplaySlideDeck {
  /** 全集（页序权威）。 */
  slides: ReplaySlide[]
  /** 已在播放进度内「生成出来」的页（slides 的有序子集）。 */
  ready: ReplaySlide[]
}

/**
 * SlidesWorkspace 的回放数据源：非 replay 会话返回 null（live 逻辑照旧）。
 * ready.length > 0 即是回放版的「预览 tab 该出现了」信号——对齐 live 的
 * 「server 起来 tab 才出现」语义，第一页揭示前用户看到的是大纲/文件。
 */
export function useReplaySlideDeck(): ReplaySlideDeck | null {
  const sessionId = useChatStore((s) => s.sessionId)
  const messages = useChatStore((s) => s.messages)
  const manifestSlides = useReplayStore((s) => s.slides)
  const isReplay = isReplaySessionId(sessionId)

  return useMemo(() => {
    if (!isReplay) return null
    const scanned = scanSvgPaths(messages)
    if (manifestSlides && manifestSlides.length > 0) {
      return {
        slides: manifestSlides,
        ready: manifestSlides.filter((s) => scanned.has(s.path))
      }
    }
    // 旧格式包兜底：扫描全集即页集，按文件名排序（重写后是哈希名，页序
    // 尽力而为——重导一次即可升级到权威清单）。
    const slides = Array.from(scanned)
      .sort((a, b) => {
        const an = a.slice(a.lastIndexOf('/') + 1)
        const bn = b.slice(b.lastIndexOf('/') + 1)
        return an.localeCompare(bn, undefined, { numeric: true })
      })
      .map((path) => ({ path, title: '' }))
    return { slides, ready: slides }
  }, [isReplay, messages, manifestSlides])
}

/** 展示名：去掉 ppt-master 的数字前缀（'13_closing课堂讨论框架' → 'closing课堂讨论框架'）。 */
function displayTitle(s: ReplaySlide): string {
  return s.title.replace(/^\d+[_-]?/, '')
}

export function ReplaySlidesViewer({ deck }: { deck: ReplaySlideDeck }): React.JSX.Element {
  const t = useT()
  const { slides, ready } = deck
  /** path → dataUrl；读失败标 'x'（资产未打包/超上限），缩略位隐藏。 */
  const [loaded, setLoaded] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  /** 自动跟随最新页；用户手动点过缩略图后关闭。 */
  const followRef = useRef(true)

  // 增量加载新揭示的页（readImageFile 支持 svg mime）。
  useEffect(() => {
    for (const s of ready) {
      if (loaded[s.path] !== undefined) continue
      setLoaded((prev) => ({ ...prev, [s.path]: '' })) // 占位防并发重复读
      void window.chatApi
        .readImageFile({ absPath: s.path })
        .then((r) => {
          setLoaded((prev) => ({ ...prev, [s.path]: r.ok && r.dataUrl ? r.dataUrl : 'x' }))
        })
        .catch(() => setLoaded((prev) => ({ ...prev, [s.path]: 'x' })))
    }
    // loaded 刻意不进 deps：它在本 effect 里自增，进 deps 会空转循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  const shown = ready.filter((s) => loaded[s.path] && loaded[s.path] !== 'x')

  // 就绪进度 → tab 栏胶囊（与 LivePreviewEditor 同一根管子），卸载清空。
  useEffect(() => {
    usePreviewReadinessStore
      .getState()
      .setReadiness({ ready: shown.length, total: Math.max(slides.length, shown.length) })
  }, [shown.length, slides.length])
  useEffect(() => () => usePreviewReadinessStore.getState().setReadiness(null), [])

  // 播放跟随：新页就绪自动选中最新。
  useEffect(() => {
    if (followRef.current && shown.length > 0) {
      setSelected(shown[shown.length - 1].path)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.length])

  const current =
    (selected && shown.find((s) => s.path === selected)) || shown[shown.length - 1] || null

  if (shown.length === 0) {
    // 空态：幻灯片还没生成到（或该录像未打包 svg 资产）。
    return (
      <div className="grid flex-1 place-items-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <span className="size-5 animate-spin rounded-full border-2 border-[hsl(var(--brand)/0.25)] border-t-[hsl(var(--brand))]" />
          <span className="text-[13px]">{t('replaySlidesEmpty')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* 缩略列 */}
      <div className="flex w-[132px] shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-border/40 p-3">
        {shown.map((s, i) => (
          <button
            key={s.path}
            type="button"
            onClick={() => {
              followRef.current = false
              setSelected(s.path)
            }}
            aria-label={`${t('replaySlidesTitle')} ${i + 1}`}
            className={
              'relative shrink-0 overflow-hidden rounded-md border bg-white transition-[border-color,box-shadow] ' +
              (current && s.path === current.path
                ? 'border-[hsl(var(--brand))] shadow-[0_0_0_1px_hsl(var(--brand))]'
                : 'border-border/60 hover:border-border')
            }
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={loaded[s.path]} alt="" className="aspect-video w-full object-contain" />
            <span className="absolute left-1 top-1 rounded bg-black/45 px-1 text-[9px] tabular-nums text-white">
              {String(i + 1).padStart(2, '0')}
            </span>
          </button>
        ))}
      </div>
      {/* 大图 + 页标题行（对齐 live 编辑器的「N 标题」头部信息） */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {current ? (
          <div className="flex shrink-0 items-baseline gap-2 px-6 pt-4">
            <span className="text-[13px] font-semibold tabular-nums text-muted-foreground">
              {String(shown.findIndex((s) => s.path === current.path) + 1).padStart(2, '0')}
            </span>
            {displayTitle(current) && (
              <span className="truncate text-[13px] font-semibold text-foreground">
                {displayTitle(current)}
              </span>
            )}
          </div>
        ) : null}
        <div className="grid min-h-0 min-w-0 flex-1 place-items-center overflow-hidden p-6 pt-3">
          {current ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={loaded[current.path]}
              alt=""
              className="max-h-full max-w-full rounded-lg border border-border/50 bg-white object-contain shadow-sm"
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
