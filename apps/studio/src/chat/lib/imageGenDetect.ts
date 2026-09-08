import { extractText, getStringArg } from '../components/chat/toolHelpers'

/**
 * 图片生成命令识别（纯函数，无 React/zustand/window 依赖）。
 *
 * 2026-09-07 从 ThreadView/ImageGenCard.tsx 原样搬出：会话图库
 * （lib/sessionImages.ts）与成果面板都要用同一套识别逻辑，而 lib/ 下的
 * 纯函数不能反向 import 组件文件（组件链上挂着 i18n / filePreview store，
 * bun test 环境里没有 window）。ImageGenCard 保留同名 re-export，
 * 既有调用方 import 路径不变。
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
