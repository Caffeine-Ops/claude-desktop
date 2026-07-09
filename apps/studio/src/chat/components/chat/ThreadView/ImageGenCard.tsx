import { useEffect, useRef, useState } from 'react'

import { useI18n } from '../../../i18n'
import {
  useImageEditStore,
  useSplitWorkspaceBusy
} from '../../../stores/filePreview'
import { extractText, getStringArg } from '../toolHelpers'

/* ───────────────── 图片生成卡（Bash → image_gen.py 特判）───────────────── */

/**
 * 聊天里的「生成图片」是产品级动作（composer 的彩色 skill 按钮背后就是
 * imagegen skill），不该长成一张开发者工具卡。这里把 image_gen.py /
 * gpt-image-2 脚本的 Bash 调用识别出来，整卡替换成产品化的两态渲染：
 *
 *   - running：「正在创建图片」点阵显影占位卡——浅点阵从左上角向外
 *     生长-回落循环（.ig-dots，main.css），复刻 ChatGPT 式的等待隐喻。
 *   - settled：成图原位落卡（readImageFile 拿原始字节的 dataUrl），
 *     点击进标记改图面板（ImageEditPanel，与成果文件卡同一动线）。
 *
 * 识别与成果定位都靠命令/输出的文本契约，对应约束写进了
 * skills/imagegen/SKILL.md 的「聊天卡片渲染契约」节——改这里的正则
 * 前先对照那份契约，两边必须同步。
 */

export interface ImageGenInfo {
  mode: 'generate' | 'edit'
  /** 请求的宽高比（--size WxH 解析），未知/auto = 1（正方形占位）。 */
  ratio: number
  /** --prompt 文本，用作成图 alt 与占位卡 title；提不出来为 null。 */
  prompt: string | null
  /** settled 时从 stdout 解析出的成果图绝对路径（running 时恒空）。 */
  paths: readonly string[]
}

/**
 * 识别一次 Bash 调用是否是图片生成/编辑命令。不是 → null（走原工具卡）。
 *
 * settled 且 stdout 解析不到成果路径（网关报错、脚本崩了）也返回 null：
 * 回退到原卡让错误原文可见，占位卡不该在失败时假装「完成了什么」。
 *
 * dry-run 排除——它只打印请求体不出图，SKILL.md 也禁止把它当用户步骤。
 */
export function detectImageGen(
  args: unknown,
  result: unknown,
  running: boolean
): ImageGenInfo | null {
  const command = getStringArg(args, 'command')
  if (!command) return null
  // imagegen 的 image_gen.py（generate / generate-batch / edit），以及
  // gpt-image-2 skill 的 generate/edit 脚本（stdout 是裸路径行，下面的
  // 解析两种格式都容）。remove_chroma_key.py（抠图后处理）刻意不匹配。
  const isImagegen = /image_gen\.py\s+(?:generate|generate-batch|edit)\b/.test(
    command
  )
  const isGptImage2 = /gpt-image-2\/scripts\/(?:generate|edit)\.(?:py|js)\b/.test(
    command
  )
  if (!isImagegen && !isGptImage2) return null
  if (/--dry-run\b/.test(command)) return null
  // run_in_background 的启动调用不进特判：它的 result 是「任务已启动」的
  // 确认（Wrote 行落在 task output 文件里），占位卡会亮一下又因解析不到
  // 成果而回退——闪卡比不出卡更糟。SKILL.md 契约本身禁止后台跑生成命令，
  // 这里是模型不守纪律时的止损。
  if (
    args !== null &&
    typeof args === 'object' &&
    Boolean((args as Record<string, unknown>).run_in_background)
  ) {
    return null
  }

  const mode: ImageGenInfo['mode'] =
    /image_gen\.py\s+edit\b|\/edit\.(?:py|js)\b/.test(command)
      ? 'edit'
      : 'generate'

  // --size 1024x1536 → 占位卡比例。auto / 缺省 / edit（继承原图，未知）
  // 都落到 1:1——占位只求「大致像那张图」，成图挂载后走自然宽高。
  const sizeMatch = /--size\s+['"]?(\d+)\s*x\s*(\d+)/i.exec(command)
  const ratio =
    sizeMatch && Number(sizeMatch[2]) > 0
      ? Number(sizeMatch[1]) / Number(sizeMatch[2])
      : 1

  const promptMatch = /--prompt\s+(?:"((?:\\.|[^"\\])+)"|'([^']+)')/.exec(
    command
  )
  const prompt = promptMatch ? (promptMatch[1] ?? promptMatch[2] ?? null) : null

  let paths: string[] = []
  if (!running) {
    paths = parseOutputPaths(extractText(result))
    if (paths.length === 0) return null
  }

  return { mode, ratio, prompt, paths }
}

/**
 * 从脚本 stdout 里捞成果图路径。两种行格式：
 *   - imagegen：`Wrote /abs/path.png`
 *   - gpt-image-2：裸的 `/abs/path.png` 一行
 * 只认整行是（剥掉 Wrote 前缀后的）绝对路径且以图片扩展结尾的——宽松
 * 匹配会把日志里顺嘴提到的路径也当成果。路径里允许空格（iCloud 目录）。
 */
function parseOutputPaths(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const t = line.trim().replace(/^Wrote\s+/, '')
    if (/^(?:\/|[A-Za-z]:[\\/])\S.*\.(?:png|jpe?g|webp|gif)$/i.test(t)) {
      out.push(t)
    }
  }
  // batch 一次最多渲染 8 张，防呆（jobs.jsonl 疯长时聊天列不被图海淹没）。
  return [...new Set(out)].slice(0, 8)
}

export function ImageGenToolCard({
  info,
  running
}: {
  info: ImageGenInfo
  running: boolean
}): React.JSX.Element {
  const lang = useI18n((s) => s.lang)
  const zh = lang === 'zh'
  // 挂载瞬间是否在 running（useRef 捕获首渲染值，同 ToolCallCard 的
  // enteredLive）。一个判定管两件事：实时落进流的卡播 tc-row-in 上浮入场；
  // running→settled 的实时转换播成图淡入。挂载即 settled（历史恢复/切会话）
  // 两个动画都不播——2026-07-04 零动画方针。工具 status 单向（running →
  // settled，不回头），所以「挂载时在跑」⇔「这次 settle 是亲眼看着发生的」。
  const enteredLive = useRef(running).current
  const animateIn = enteredLive && !running

  if (running) {
    const title =
      info.mode === 'edit'
        ? zh
          ? '正在修改图片'
          : 'Editing image…'
        : zh
          ? '正在创建图片'
          : 'Creating image…'
    return (
      <div className={(enteredLive ? 'tc-row-in ' : '') + 'w-full min-w-0'}>
        <div
          role="status"
          aria-live="polite"
          aria-label={title}
          title={info.prompt ?? undefined}
          className="relative w-full max-w-[440px] overflow-hidden rounded-2xl bg-muted/50"
          style={{ aspectRatio: info.ratio }}
        >
          <div aria-hidden className="ig-dots absolute inset-0" />
          <span className="shimmer-text absolute left-5 top-4 text-[13px] font-medium">
            {title}
          </span>
        </div>
      </div>
    )
  }

  const multi = info.paths.length > 1
  return (
    <div className="w-full min-w-0">
      <div
        className={
          multi ? 'grid max-w-[440px] grid-cols-2 gap-2' : 'max-w-[440px]'
        }
      >
        {info.paths.map((p) => (
          <GeneratedImage
            key={p}
            path={p}
            ratio={info.ratio}
            alt={info.prompt}
            animateIn={animateIn}
            zh={zh}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * 一张成图：readImageFile（原始字节 dataUrl，与 ImageLightbox 同一 IPC）
 * 加载后自然宽高渲染。点击进标记改图面板；分栏被 slides/proposal 工作区
 * 占用时降级系统应用打开（与 DeliverableCard 的图片分支同一决策）。
 */
function GeneratedImage({
  path,
  ratio,
  alt,
  animateIn,
  zh
}: {
  path: string
  ratio: number
  alt: string | null
  animateIn: boolean
  zh: boolean
}): React.JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const splitBusy = useSplitWorkspaceBusy()

  useEffect(() => {
    let cancelled = false
    void window.chatApi
      .readImageFile({ absPath: path })
      .then((r) => {
        if (cancelled) return
        if (r.ok && r.dataUrl) setDataUrl(r.dataUrl)
        else setMissing(true)
      })
      .catch(() => {
        if (!cancelled) setMissing(true)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  // 历史消息里的成图可能已被用户删掉/移走——退成一行中性说明,别让
  // 旧会话滚出一片空白大卡。
  if (missing) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
        <span className="truncate font-mono">{path.split('/').pop()}</span>
        <span className="shrink-0">
          {zh ? '图片已不在原位置' : 'Image no longer on disk'}
        </span>
      </div>
    )
  }

  const open = (): void => {
    if (!splitBusy) {
      useImageEditStore.getState().openEditor(path)
      return
    }
    void window.chatApi.openPath({ absPath: path })
  }

  return (
    <button
      type="button"
      onClick={open}
      title={path}
      className="block w-full overflow-hidden rounded-2xl bg-muted/50 text-left transition-opacity duration-200 hover:opacity-90"
    >
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={alt ?? ''}
          className={'block h-auto w-full ' + (animateIn ? 'ig-img-in' : '')}
        />
      ) : (
        // dataUrl 回来前按请求比例撑住高度，成图挂载不跳版
        <div aria-hidden className="w-full" style={{ aspectRatio: ratio }} />
      )}
    </button>
  )
}
