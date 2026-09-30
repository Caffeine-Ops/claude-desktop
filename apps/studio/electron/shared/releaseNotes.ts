/**
 * 更新说明的归一化（2026-09-30）——把 electron-updater 给的那一团东西收成
 * 「一段能直接显示给用户看的纯文本」。
 *
 * 为什么需要这一层
 * ----------------
 * `UpdateInfo.releaseNotes` 的类型是 `string | ReleaseNoteInfo[] | null`，
 * 而且**同一个字段在不同来源下格式完全不同**：
 *
 *  - **GitHub provider**（electron-updater 内置）：它读的是 GitHub 的
 *    `releases.atom`，取 `<content>` 元素——而 GitHub 在 atom 里放的是
 *    **已经渲染好的 HTML**，不是你写 release 时的 Markdown 原文。所以这里
 *    拿到的是 `<ul><li>…</li></ul>` 这种东西，直接显示就是一堆尖括号。
 *  - **GitHub Releases API 回落**（自建 generic 源拿不到说明时走这条）：
 *    API 的 `body` 字段是 **Markdown 原文**。
 *  - **fullChangelog 开启时**：变成 `ReleaseNoteInfo[]`（多个版本各一段）。
 *
 * 所以这个函数要同时吃下：HTML、Markdown、数组、null、以及各种畸形值。
 *
 * 为什么剥成纯文本而不渲染
 * ------------------------
 * release 正文是**远端内容**。纯文本展示天然没有注入风险，渲染 HTML 就得
 * 先消毒；而 canvas 侧设置页也没有现成的 Markdown 渲染器，为这一处引一套
 * 不划算。代价是 Markdown 形态下 `##`、`**` 会原样显示成符号——可接受，
 * release 正文绝大多数是列表，剥完读起来没问题。
 */

/** 数组形态的一项。结构照 builder-util-runtime 的 ReleaseNoteInfo。 */
type ReleaseNoteItem = {
  readonly version?: unknown
  readonly note?: unknown
}

/**
 * 正文显示上限。超了截断——设置页那张卡是要能一眼扫完的，而 release 正文
 * 偶尔会很长（自动生成的 changelog 能有几百行）。
 */
const MAX_LENGTH = 4000

/** GitHub 对「这个 release 没写正文」的占位，等同于没有说明。 */
const EMPTY_PLACEHOLDER = 'No content.'

/**
 * 命名实体表。只收最常出现的几个——release 正文里 `&`、`<`、引号、不断行
 * 空格基本就是全部了，数字实体另有通用分支兜底。
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      // 非法码点原样留着——总比抛错或吐出 U+FFFD 强。
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** 看起来像 HTML 吗——有成对尖括号包着标签名就算。 */
function looksLikeHtml(text: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(text)
}

/**
 * HTML → 纯文本。**不是通用转换器**，只覆盖 GitHub release 正文会用到的
 * 那几种块级标签；目标是「读起来像原来那段话」，不是还原排版。
 */
function htmlToText(html: string): string {
  return (
    html
      // 脚本/样式整块丢掉（GitHub 不会给，但远端内容该防）
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      // 列表项 → 「- 」开头
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/li>/gi, '')
      // 块级元素 → 空行分隔
      .replace(/<\/(p|h[1-6]|div|ul|ol|blockquote|pre|tr)>/gi, '\n\n')
      .replace(/<(p|h[1-6]|div|ul|ol|blockquote|pre|tr)\b[^>]*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      // 剩下的行内标签（a/code/strong/em…）只去壳留字
      .replace(/<[^>]+>/g, '')
  )
}

/**
 * 收拾空白。三条规则，缺一段落就会糊成一坨或散成一片：
 *
 *  1. 每行首尾去空白——HTML 源码里全是缩进。
 *  2. 连续空行折叠成一个，首尾空行去掉。
 *  3. **相邻两个列表项之间不留空行**。GitHub 的 HTML 里 `</li>` 和下一个
 *     `<li>` 之间常有换行和缩进，经块级替换后会变成空行，列表就散成一条条
 *     独立段落了。列表本该是紧凑的；段落与列表之间的空行仍然保留。
 */
function tidy(text: string): string {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') {
      // 开头的空行直接丢；连续空行只留一个。
      if (out.length === 0 || out[out.length - 1] === '') continue
      out.push('')
      continue
    }
    // 本行是列表项，且上一条有效行也是列表项 → 撤掉中间那个空行。
    if (
      line.startsWith('- ') &&
      out.length >= 2 &&
      out[out.length - 1] === '' &&
      out[out.length - 2]!.startsWith('- ')
    ) {
      out.pop()
    }
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

/**
 * GitHub「自动生成」的那行链接。
 *
 * 2026-09-30 实测：本项目历史上**每一个** release 的正文都只有这一行——
 * 发版时没人写过更新说明，GitHub 自动补了个 `**Full Changelog**: <compare 链接>`。
 * 照单全收的话，用户在「本次更新」里看到的就是一条光秃秃的开发者链接，
 * 比不显示更糟（是噪音）。
 *
 * 所以这行一律摘掉：摘完还有内容就显示内容，什么都不剩就当没有说明。
 * 匹配刻意要求**整行**是「Full Changelog + 链接」，正文里提到 changelog
 * 字样的普通句子不会被误删。
 */
const AUTO_CHANGELOG_LINE = /^\**\s*full changelog\s*\**\s*[:：]\s*\S*https?:\/\/\S+\s*$/i

/** 单段（字符串形态）归一化：HTML 剥标签、解实体、收空白、摘掉自动生成行。 */
function normalizeOne(raw: string): string | null {
  const decoded = looksLikeHtml(raw) ? decodeEntities(htmlToText(raw)) : decodeEntities(raw)
  const withoutAuto = tidy(decoded)
    .split('\n')
    .filter((line) => !AUTO_CHANGELOG_LINE.test(line))
    .join('\n')
  const text = tidy(withoutAuto)
  if (!text || text === EMPTY_PLACEHOLDER) return null
  return text
}

/**
 * 把 `UpdateInfo.releaseNotes`（以及 GitHub API 的 body）归一成一段可直接
 * 显示的纯文本；没有可显示内容时返回 `null`（调用方据此整块不渲染）。
 *
 * 入参刻意是 `unknown`：这是跨进程、跨来源的远端数据，类型声明只是声明，
 * 运行时什么都可能来。**任何输入都不抛错**——更新说明拿不到是小事，为它
 * 崩掉整条更新流程是大事。
 */
export function normalizeReleaseNotes(raw: unknown): string | null {
  let merged: string | null = null

  if (typeof raw === 'string') {
    merged = normalizeOne(raw)
  } else if (Array.isArray(raw)) {
    const parts: string[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const { version, note } = item as ReleaseNoteItem
      if (typeof note !== 'string') continue
      const body = normalizeOne(note)
      // note 为空的版本整条跳过——只剩一个光秃秃的版本号没有意义。
      if (!body) continue
      parts.push(typeof version === 'string' && version ? `${version}\n\n${body}` : body)
    }
    merged = parts.length > 0 ? parts.join('\n\n') : null
  }

  if (!merged) return null
  return merged.length > MAX_LENGTH ? `${merged.slice(0, MAX_LENGTH)}…` : merged
}
