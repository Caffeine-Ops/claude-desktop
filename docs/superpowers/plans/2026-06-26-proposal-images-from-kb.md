# 方案写作·嵌入知识库图片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「写方案」在写正文时，从本节已引用的知识库文件里挑相关图嵌入——导出 Word 真嵌图、app 预览能显示、图与文同源可校验。

**Architecture:** AI 在 markdown 里写 `![图说](绝对路径)`（图只许取自本段 `（据《X》）` 引用过文件的 `assets[]`）。一份 markdown 两端消费：docx 导出器（main，有 fs）直读绝对路径经 ImageRun 嵌图；渲染预览的 `<img>` override 把绝对路径映射成新注册的 `kbasset://` 协议 URL 加载。图接地校验并入现有 `SectionVerification` 三态。

**Tech Stack:** TypeScript（composite：tsconfig.node 管 main/preload/shared、tsconfig.web 管 renderer/shared）、bun、docx（ImageRun）、新增 image-size、react-markdown、Electron 自定义协议（protocol.handle）。

## Global Constraints

- 包管理器与测试用 **bun**，不是 npm。测试在 `apps/desktop/` 下跑（`"test": "bun test src/"`）。
- 唯一自动化门 `bun run typecheck`（仓库根，= tsc node + web）；无 ESLint。每个 Task 提交前必须过。
- `src/shared/` 是 main 与 renderer 共享的**纯函数**，不得引 fs/electron。`proposalVerify.ts`（含 fs/索引）属 main；其纯判定在 `proposalVerify.core.ts`，可在 bun test 直接单测。
- 注释沿用仓库风格：解释「为什么这样而不是那样」。
- 全程中文文案。
- 已拍板决策（不得偏离）：图接地=只用本节所引文件的 assets；AI 自动插图、不确定走 AskUserQuestion；渲染通道用 `kbasset://` 协议（非 IPC data-uri）；尺寸用 image-size；**v1 不嵌 SVG**（降级文字）；接地失败**标红但保留**（不删）。
- 封面/目录节不嵌图，仅 content 节。
- A 的成果（`proposalDocx.ts` 的 `case 'table'`、表格相关测试）不得破坏。

---

### Task 1: 图接地纯核（解析 + 类型）

**Files:**
- Modify: `apps/desktop/src/shared/proposal.ts`（加 `parseImages`、`ImageVerdict`、扩 `SectionVerification`）
- Test: `apps/desktop/src/shared/proposal.test.ts`（已存在，追加 describe）

**Interfaces:**
- Produces:
  - `export interface ImageVerdict { path: string; status: 'grounded' | 'ungrounded' }`
  - `SectionVerification` 增可选字段 `imageVerdicts?: ImageVerdict[]`（向后兼容，无图时省略）
  - `export function parseImages(markdown: string): { alt: string; path: string }[]`

- [ ] **Step 1: Write the failing test**

在 `apps/desktop/src/shared/proposal.test.ts` 末尾追加（文件顶部已 `import { ... } from './proposal'`，把 `parseImages` 加进该 import）：

```typescript
describe('parseImages', () => {
  it('抽取多张图的 alt 与 path', () => {
    const md = '正文一。\n\n![架构图](/kb/assets/a/img-1.png)\n\n更多。\n\n![流程](/kb/assets/a/img-2.jpg)'
    expect(parseImages(md)).toEqual([
      { alt: '架构图', path: '/kb/assets/a/img-1.png' },
      { alt: '流程', path: '/kb/assets/a/img-2.jpg' }
    ])
  })

  it('与引用标注（据《X》）共存、互不干扰；普通链接不算图', () => {
    const md = '某段（据《白皮书》）\n\n![图](/kb/assets/a/img-1.png)\n\n[纯链接](/not-an-image)'
    expect(parseImages(md)).toEqual([{ alt: '图', path: '/kb/assets/a/img-1.png' }])
  })

  it('无图 → 空数组', () => {
    expect(parseImages('纯文字，无图。')).toEqual([])
    expect(parseImages('')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run（在 `apps/desktop/`）: `bun test src/shared/proposal.test.ts`
Expected: FAIL — `parseImages` 未定义 / 未导出。

- [ ] **Step 3: Implement**

在 `apps/desktop/src/shared/proposal.ts` 的 `SectionVerification` 接口里加一行可选字段：

```typescript
export interface SectionVerification {
  verdicts: CitationVerdict[]
  /** 段内去重后引用的文件数（覆盖度）；content 段为 0 = 未引用任何来源。 */
  citedFileCount: number
  degraded?: boolean
  /** 本节图片接地核对结论（无图时省略）。grounded=图属本节所引文件的 assets；ungrounded=不属。 */
  imageVerdicts?: ImageVerdict[]
}
```

在 `CitationVerdict` 接口之后新增 `ImageVerdict`：

```typescript
/**
 * 一张图的接地核对结论。`path` 是 markdown `![alt](path)` 里的图路径。
 * - `grounded`：该图属于本节已 `（据《X》）` 引用过文件的 assets（图与文同源）。
 * - `ungrounded`：不属任何本节所引文件的 assets（疑似挪用/编造，UI 标红但保留）。
 */
export interface ImageVerdict {
  path: string
  status: 'grounded' | 'ungrounded'
}
```

在文件「引用落地校验」段（`CITATION_FILE_RE` 附近）加图片解析。markdown 图语法 `![alt](path)`，用正则；`!`/`[`/`]`/`(`/`)` 非冲突，path 取到首个 `)` 前（KB 图路径不含 `)`）：

```typescript
// markdown 图片：`![alt](path)`。path 取到首个 `)` 前——KB 图为 img-N.png 类路径、不含 `)`。
// 要求前置 `!`，故普通链接 `[text](url)` 不会被误抽（无 `!`）。alt 可空。
const IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g

/**
 * 抽取正文里的所有图片：返回 {alt, path} 数组（保序）。无图 → []。
 * 与 parseCitations 解析的 `（据…）` 引用组互不干扰（语法不同）。main 与 renderer 共享纯函数。
 */
export function parseImages(markdown: string): { alt: string; path: string }[] {
  if (!markdown) return []
  const out: { alt: string; path: string }[] = []
  IMAGE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMAGE_RE.exec(markdown)) !== null) {
    out.push({ alt: m[1].trim(), path: m[2].trim() })
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/shared/proposal.test.ts`
Expected: PASS（新增 3 用例 + 原有用例全过）。

- [ ] **Step 5: Typecheck + Commit**

Run（仓库根）: `bun run typecheck` → PASS

```bash
git add apps/desktop/src/shared/proposal.ts apps/desktop/src/shared/proposal.test.ts
git commit -m "feat(proposal): 图片接地纯核——parseImages + ImageVerdict 类型"
```

---

### Task 2: 图接地核对（core + IO 扩展）

**Files:**
- Modify: `apps/desktop/src/main/core/proposalVerify.core.ts`（`verifyCitationsCore` 增第三参 `resolveAssets`，产出 imageVerdicts）
- Modify: `apps/desktop/src/main/core/proposalVerify.ts`（IO 层建 `title→assets`，传入 resolveAssets）
- Test: `apps/desktop/src/main/core/proposalVerify.core.test.ts`（已存在，追加用例）

**Interfaces:**
- Consumes: Task 1 的 `parseImages`、`ImageVerdict`、`SectionVerification.imageVerdicts`；现有 `verifyCitationsCore(markdown, resolveContent)`、`verifyCitations(markdown)`。
- Produces: `verifyCitationsCore(markdown, resolveContent, resolveAssets?)` —— 第三参 `resolveAssets: (file: string) => string[]` 可选（返回某 title 文件的 assets 路径数组；缺省视作全空 → 有图即 ungrounded）。返回的 `SectionVerification` 在有图时带 `imageVerdicts`。

- [ ] **Step 1: Write the failing test**

在 `proposalVerify.core.test.ts` 末尾追加（顶部已 import `verifyCitationsCore`）：

```typescript
describe('verifyCitationsCore 图片接地', () => {
  it('图属本节所引文件的 assets → grounded', () => {
    const md = '本系统架构如下。（据《白皮书》）\n\n![架构图](/kb/a/img-1.png)'
    const r = verifyCitationsCore(
      md,
      (f) => (f === '白皮书' ? '架构如下，包含分诊与预问诊。' : null),
      (f) => (f === '白皮书' ? ['/kb/a/img-1.png', '/kb/a/img-2.png'] : [])
    )
    expect(r.imageVerdicts).toEqual([{ path: '/kb/a/img-1.png', status: 'grounded' }])
  })

  it('图不属任何本节所引文件的 assets → ungrounded', () => {
    const md = '本系统架构如下。（据《白皮书》）\n\n![盗图](/kb/other/img-9.png)'
    const r = verifyCitationsCore(
      md,
      (f) => (f === '白皮书' ? '架构如下。' : null),
      (f) => (f === '白皮书' ? ['/kb/a/img-1.png'] : [])
    )
    expect(r.imageVerdicts).toEqual([{ path: '/kb/other/img-9.png', status: 'ungrounded' }])
  })

  it('无图 → 不带 imageVerdicts（向后兼容）', () => {
    const r = verifyCitationsCore('纯文字。（据《白皮书》）', () => '纯文字。', () => ['/x.png'])
    expect(r.imageVerdicts).toBeUndefined()
  })

  it('不传 resolveAssets 时仍可用（旧签名，有图则全 ungrounded）', () => {
    const r = verifyCitationsCore('文。（据《白皮书》）\n\n![图](/kb/a/img-1.png)', () => '文。')
    expect(r.imageVerdicts).toEqual([{ path: '/kb/a/img-1.png', status: 'ungrounded' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/main/core/proposalVerify.core.test.ts`
Expected: FAIL — `imageVerdicts` 为 undefined（核心尚未产出）。

- [ ] **Step 3: Implement core**

在 `proposalVerify.core.ts`：把 `parseImages` 加进顶部 `from '../../shared/proposal'` 的 import；`verifyCitationsCore` 改为：

```typescript
export function verifyCitationsCore(
  markdown: string,
  resolveContent: (file: string) => string | null,
  resolveAssets?: (file: string) => string[]
): SectionVerification {
  const safe = typeof markdown === 'string' ? markdown : ''
  const paras = parseCitations(safe)
  const verdicts: CitationVerdict[] = []
  const citedFiles = new Set<string>()
  for (const { paragraph, files } of paras) {
    for (const file of files) {
      citedFiles.add(file)
      const content = resolveContent(file)
      if (content === null) {
        verdicts.push({ file, status: 'file-not-found' })
        continue
      }
      const overlap = trigramOverlap(paragraph, content)
      verdicts.push({
        file,
        status: overlap >= TRIGRAM_THRESHOLD ? 'supported' : 'unsupported',
        overlap
      })
    }
  }

  // 图片接地：图必属本节所引文件（citedFiles）的 assets 并集。无图 → 不带 imageVerdicts
  // （向后兼容，UI 据「有无该字段」决定要不要画图相关红绿）。resolveAssets 缺省 → 并集为空
  // → 有图即 ungrounded（安全默认：宁可标红也不放过来路不明的图）。
  const images = parseImages(safe)
  let imageVerdicts: ImageVerdict[] | undefined
  if (images.length > 0) {
    const allowed = new Set<string>()
    for (const f of citedFiles) for (const a of resolveAssets?.(f) ?? []) allowed.add(a)
    imageVerdicts = images.map((img) => ({
      path: img.path,
      status: allowed.has(img.path) ? ('grounded' as const) : ('ungrounded' as const)
    }))
  }

  const base: SectionVerification = { verdicts, citedFileCount: citedFiles.size }
  return imageVerdicts ? { ...base, imageVerdicts } : base
}
```

并把顶部 import 改为：

```typescript
import {
  parseCitations,
  parseImages,
  trigramOverlap,
  type CitationVerdict,
  type ImageVerdict,
  type SectionVerification
} from '../../shared/proposal'
```

> 说明：原实现对 `paras.length===0` 提前 return；新实现去掉该早退（即便无引用也可能有图要核对），逻辑等价——无引用且无图时 verdicts=[]、citedFileCount=0、不带 imageVerdicts，与原返回一致。

- [ ] **Step 4: Wire IO layer**

在 `proposalVerify.ts`：在建好 `titleToPath` 之后、`return verifyCitationsCore(...)` 之前，再建 `title→assets`，并把 resolveAssets 传进去。把第 32-53 行那段替换为：

```typescript
    // title → mirrorPath，仅纳入转换成功（ok）的文件；同名取首个。
    const titleToPath = new Map<string, string>()
    // title → assets（图片绝对路径数组），同样仅 ok 文件、同名取首个——供图片接地核对。
    const titleToAssets = new Map<string, string[]>()
    for (const f of index.files) {
      if (f.ok && !titleToPath.has(f.title)) {
        titleToPath.set(f.title, f.mirrorPath)
        titleToAssets.set(f.title, f.assets ?? [])
      }
    }
    // 镜像内容读取缓存：一节里多段可能引同一文件，避免重复读盘。null = 不存在/读失败。
    const contentCache = new Map<string, string | null>()
    const resolveContent = (file: string): string | null => {
      const path = titleToPath.get(file)
      if (!path) return null
      const cached = contentCache.get(path)
      if (cached !== undefined) return cached
      let text: string | null
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        text = null
      }
      contentCache.set(path, text)
      return text
    }
    const resolveAssets = (file: string): string[] => titleToAssets.get(file) ?? []
    return verifyCitationsCore(
      typeof markdown === 'string' ? markdown : '',
      resolveContent,
      resolveAssets
    )
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test src/main/core/proposalVerify.core.test.ts`
Expected: PASS（新 4 用例 + 原有 supported/unsupported/表格等用例全过）。

- [ ] **Step 6: Typecheck + Commit**

Run（仓库根）: `bun run typecheck` → PASS

```bash
git add apps/desktop/src/main/core/proposalVerify.core.ts apps/desktop/src/main/core/proposalVerify.ts apps/desktop/src/main/core/proposalVerify.core.test.ts
git commit -m "feat(proposal): 图片接地核对——图必属本节所引文件 assets，并入 SectionVerification"
```

---

### Task 3: 暴露图给 AI（scope + prompt）

**Files:**
- Modify: `apps/desktop/src/main/core/proposalPrompt.ts`（`ProposalProductScope.files` 扩 assets、`renderProductBlock` 列图、新增正文嵌图规则）
- Modify: `apps/desktop/src/main/core/engine.ts:537`（map 带上 assets）
- Test: `apps/desktop/src/main/core/proposalPrompt.test.ts`（已存在，追加用例）

**Interfaces:**
- Consumes: 现有 `ProposalProductScope`、`buildProposalAppend(mirrorDir, products)`、`renderProductBlock`。
- Produces: `ProposalProductScope.files` 每项类型变为 `{ title: string; mirrorPath: string; assets: string[] }`。

- [ ] **Step 1: Write the failing test**

在 `proposalPrompt.test.ts` 追加（顶部已 import `buildProposalAppend`）：

```typescript
describe('buildProposalAppend 图片暴露与规则', () => {
  const scope = {
    dir: '/kb/线/品',
    productLine: '线',
    product: '品',
    files: [{ title: '白皮书', mirrorPath: '/kb/线/品/wp.txt', assets: ['/kb/线/品/assets/img-1.png'] }]
  }

  it('文件清单下列出其可用图路径', () => {
    const out = buildProposalAppend('/kb', [scope])
    expect(out).toContain('/kb/线/品/assets/img-1.png')
  })

  it('含「只用本段所引文件的图」嵌图规则', () => {
    const out = buildProposalAppend('/kb', [scope])
    expect(out).toContain('![图说]')
    expect(out).toContain('绝不挪用别处的图')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/main/core/proposalPrompt.test.ts`
Expected: FAIL — 图路径与嵌图规则尚未出现在输出。

- [ ] **Step 3: Implement**

在 `proposalPrompt.ts`：

(a) 扩 `ProposalProductScope.files` 类型：

```typescript
export interface ProposalProductScope {
  dir: string
  productLine: string
  product: string
  files: { title: string; mirrorPath: string; assets: string[] }[]
}
```

(b) 在 `MAX_FILES_PER_PRODUCT` 常量旁加图片列举上限：

```typescript
/** 每个文件最多在提示词里列多少张图，防御异常多图把提示词撑爆；超出标注让 AI 知道还有更多。 */
const MAX_IMAGES_PER_FILE = 12
```

(c) `renderProductBlock` 里，文件行生成处把每个文件的图也列出来。将其中 `const lines = shown.map((f) => ...)` 那行替换为：

```typescript
  const lines = shown.map((f) => {
    const head = `     - 《${f.title}》 → ${f.mirrorPath}`
    if (!f.assets || f.assets.length === 0) return head
    const imgs = f.assets.slice(0, MAX_IMAGES_PER_FILE).map((a) => `         · 图：${a}`)
    if (f.assets.length > MAX_IMAGES_PER_FILE) {
      imgs.push(`         · …（共 ${f.assets.length} 张图，上面只列前 ${MAX_IMAGES_PER_FILE} 张）`)
    }
    // 文件行 + 其名下可用图，缩进区分层级，让 AI 一眼看到「这个文件配了哪些图」。
    return `${head}\n${imgs.join('\n')}`
  })
```

(d) 新增正文嵌图规则。在 A 已加的「【正文·结构化数据用表格】…」那条数组元素**之后**，插入新元素：

```typescript
    // 嵌图：图与文同源。只许用本段已 （据《X》） 引用过文件的 assets（上面文件清单里列在该
    // 文件名下的「图：」路径），防止往客户方案塞 logo/截图/无关装饰图。封面/目录不插图。
    '【正文·按需嵌入知识库配图】当某段引用了某文件、且该文件名下列有配图、且某张图能直观佐证本段内容时，从【该文件的图清单】里挑相关图，按 `![图说](图的绝对路径)` 单独成行嵌入，图说一句话说明图意。硬性约束：只能用你在本段已 （据《…》） 引用过文件名下列出的图，绝不挪用别处的图、绝不编造图路径；图是否要插由你按相关性判断，拿不准就用 AskUserQuestion 问用户。封面、目录一律不插图。',
```

(e) `engine.ts` 第 537 行，map 带上 assets：

```typescript
          .map((f) => ({ title: f.title, mirrorPath: f.mirrorPath, assets: f.assets })) ?? []
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/main/core/proposalPrompt.test.ts`
Expected: PASS（新 2 用例 + A 的表格纪律用例全过）。

- [ ] **Step 5: Typecheck + Commit**

Run（仓库根）: `bun run typecheck` → PASS（`ProposalProductScope.files` 类型变更会让 engine.ts 的 map 必须带 assets，已在 Step 3e 处理）。

```bash
git add apps/desktop/src/main/core/proposalPrompt.ts apps/desktop/src/main/core/engine.ts apps/desktop/src/main/core/proposalPrompt.test.ts
git commit -m "feat(proposal): 向 AI 暴露文件配图 + 嵌图规则（只用本段所引文件的图）"
```

---

### Task 4: kbasset:// 协议

**Files:**
- Create: `apps/desktop/src/main/services/kbAssetProtocol.ts`
- Modify: `apps/desktop/src/main/index.ts`（registerSchemesAsPrivileged 加 kbasset；whenReady 里调 registerKbAssetProtocol）
- Test: `apps/desktop/src/main/services/kbAssetProtocol.test.ts`（新建——测纯路径守卫）

**Interfaces:**
- Consumes: `kbOutDir()`（`./../core/kbIndexStore` 已导出）。
- Produces:
  - `export const KB_ASSET_SCHEME = 'kbasset'`
  - `export function isPathInsideKbRoot(absPath: string, kbRoot: string): boolean`（纯函数，无 fs）
  - `export function registerKbAssetProtocol(): void`

- [ ] **Step 1: Write the failing test**

新建 `apps/desktop/src/main/services/kbAssetProtocol.test.ts`：

```typescript
import { describe, it, expect } from 'bun:test'

import { isPathInsideKbRoot } from './kbAssetProtocol'

describe('isPathInsideKbRoot', () => {
  const root = '/Users/x/Library/Application Support/app/kb-index'

  it('root 内的文件路径 → true', () => {
    expect(isPathInsideKbRoot(`${root}/assets/线/品/img-1.png`, root)).toBe(true)
  })

  it('root 外的路径 → false', () => {
    expect(isPathInsideKbRoot('/etc/passwd', root)).toBe(false)
  })

  it('用 ../ 逃逸出 root → false', () => {
    expect(isPathInsideKbRoot(`${root}/assets/../../../etc/passwd`, root)).toBe(false)
  })

  it('前缀相近的兄弟目录（kb-index-evil）不算 root 内 → false', () => {
    expect(isPathInsideKbRoot(`${root}-evil/x.png`, root)).toBe(false)
  })

  it('空路径 → false', () => {
    expect(isPathInsideKbRoot('', root)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/main/services/kbAssetProtocol.test.ts`
Expected: FAIL — 模块/函数不存在。

- [ ] **Step 3: Implement**

新建 `apps/desktop/src/main/services/kbAssetProtocol.ts`：

```typescript
/**
 * `kbasset://` 自定义协议 —— 让桌面渲染进程能显示知识库镜像里的本地图片（方案预览嵌图）。
 *
 * 为什么不用 file:// 直读：渲染进程 file:// 图常被 webSecurity 拦；且需要严格的路径逃逸
 * 防护，不能让 `kbasset://kb/<../../etc/passwd>` 读到 kb-index 目录外的任意文件。照
 * `appProtocol.ts`（app://）的范式：注册为 standard+secure scheme（见 index.ts 的
 * registerSchemesAsPrivileged），handler 解码绝对路径、校验仍在 kbOutDir 内、再流式读盘。
 *
 * URL 形：`kbasset://kb/<encodeURIComponent(图的绝对路径)>`。整条绝对路径编码成单个 path
 * 段（encodeURIComponent 把 `/` 编成 %2F），handler 解码还原。渲染侧由 toKbAssetUrl 构造。
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'

import { kbOutDir } from '../core/kbIndexStore'

/** 协议名。必须与 index.ts registerSchemesAsPrivileged 里登记的一致。 */
export const KB_ASSET_SCHEME = 'kbasset'

/**
 * 纯路径守卫（无 fs）：规整后的 absPath 必须落在 kbRoot 之内。
 * kbRoot 末尾补 sep 再比前缀，避免 /kb-index 命中 /kb-index-evil 这种兄弟目录误判。
 * 空串、规整后逃逸到 kbRoot 外 → false。
 */
export function isPathInsideKbRoot(absPath: string, kbRoot: string): boolean {
  if (!absPath || !kbRoot) return false
  const abs = normalize(absPath)
  const root = normalize(kbRoot)
  return abs === root || abs.startsWith(root + sep)
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

function mimeFor(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return MIME[ext] ?? 'application/octet-stream'
}

/**
 * 注册 kbasset:// handler。app.whenReady() 之后调用一次；registerSchemesAsPrivileged 必须
 * 已在 ready 前跑过（见 index.ts）。命中 → 流式读盘；越界/不存在 → 404，绝不抛。
 */
export function registerKbAssetProtocol(): void {
  protocol.handle(KB_ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      // pathname 形如 /<encodeURIComponent(绝对路径)>；去前导 / 再解码还原绝对路径。
      const absPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const root = kbOutDir()
      if (!isPathInsideKbRoot(absPath, root)) return new Response('Forbidden', { status: 403 })
      const abs = normalize(absPath)
      if (!existsSync(abs) || !statSync(abs).isFile()) return new Response('Not Found', { status: 404 })
      const body = Readable.toWeb(createReadStream(abs)) as ReadableStream
      return new Response(body, { headers: { 'content-type': mimeFor(abs) } })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}
```

在 `index.ts`：

(a) 顶部 import 旁加：

```typescript
import { KB_ASSET_SCHEME, registerKbAssetProtocol } from './services/kbAssetProtocol'
```

(b) `registerSchemesAsPrivileged([...])` 数组里，APP_SCHEME 那项之后再加一项：

```typescript
  {
    scheme: KB_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
```

(c) whenReady 回调里 `registerAppProtocol()` 那行（约第 201 行）之后加：

```typescript
    registerKbAssetProtocol()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/main/services/kbAssetProtocol.test.ts`
Expected: PASS（5 用例全过）。

- [ ] **Step 5: Typecheck + Commit**

Run（仓库根）: `bun run typecheck` → PASS

```bash
git add apps/desktop/src/main/services/kbAssetProtocol.ts apps/desktop/src/main/services/kbAssetProtocol.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(proposal): kbasset:// 协议——渲染进程安全加载 KB 本地图（含路径逃逸守卫）"
```

---

### Task 5: 渲染预览嵌图

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/kbAssetUrl.ts`
- Modify: `apps/desktop/src/renderer/src/components/chat/AssistantMarkdown.tsx`（components 加 `img` override）
- Test: `apps/desktop/src/renderer/src/lib/kbAssetUrl.test.ts`（新建）

**Interfaces:**
- Consumes: Task 4 的 `kbasset://` 协议（运行时）。
- Produces: `export function toKbAssetUrl(src: string): string`。

- [ ] **Step 1: Write the failing test**

新建 `apps/desktop/src/renderer/src/lib/kbAssetUrl.test.ts`：

```typescript
import { describe, it, expect } from 'bun:test'

import { toKbAssetUrl } from './kbAssetUrl'

describe('toKbAssetUrl', () => {
  it('KB assets 绝对路径 → kbasset:// 编码 URL', () => {
    const p = '/Users/x/Library/Application Support/app/kb-index/assets/线/品/img-1.png'
    expect(toKbAssetUrl(p)).toBe(`kbasset://kb/${encodeURIComponent(p)}`)
  })

  it('普通 http(s) 图原样返回', () => {
    expect(toKbAssetUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
  })

  it('非 KB 的本地路径原样返回（不含 /kb-index/assets/ 特征）', () => {
    expect(toKbAssetUrl('/Users/x/Desktop/random.png')).toBe('/Users/x/Desktop/random.png')
  })

  it('空串原样返回', () => {
    expect(toKbAssetUrl('')).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/renderer/src/lib/kbAssetUrl.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: Implement**

新建 `apps/desktop/src/renderer/src/lib/kbAssetUrl.ts`：

```typescript
/**
 * 把方案 markdown 里的「KB 图绝对路径」转成 `kbasset://` URL，供渲染进程 <img> 加载
 * （见 main 的 kbAssetProtocol.ts）。只转换命中 KB assets 特征的路径，普通 http(s) 图与
 * 非 KB 本地路径原样返回——避免误伤外链图。
 *
 * 为什么只在渲染时转、不改存储 markdown：导出 Word（main，proposalDocx）要直读绝对路径过
 * ImageRun 嵌图；存储层保持绝对路径这一份真相，预览端按需适配。
 */

// KB 镜像图都落在 <userData>/kb-index/assets/ 下，故以这个路径片段作判定特征。
const KB_ASSET_MARKER = '/kb-index/assets/'

export function toKbAssetUrl(src: string): string {
  if (!src) return src
  if (src.includes(KB_ASSET_MARKER)) return `kbasset://kb/${encodeURIComponent(src)}`
  return src
}
```

在 `AssistantMarkdown.tsx`：顶部 import 加 `import { toKbAssetUrl } from '../../lib/kbAssetUrl'`；在 `const components: Components = { ... }` 里加 `img` override（放在 `p` 附近即可）：

```typescript
  // KB 本地图经 kbasset:// 协议加载（绝对路径直接当 <img src> 会被当相对 URL、加载失败）。
  img: ({ src, alt }) => (
    <img
      src={typeof src === 'string' ? toKbAssetUrl(src) : (src as string | undefined)}
      alt={alt ?? ''}
      className="my-2 max-w-full rounded"
    />
  ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/renderer/src/lib/kbAssetUrl.test.ts`
Expected: PASS（4 用例全过）。

- [ ] **Step 5: Typecheck + Commit**

Run（仓库根）: `bun run typecheck` → PASS（含 tsc web，覆盖 renderer img override 的 JSX 类型）。

```bash
git add apps/desktop/src/renderer/src/lib/kbAssetUrl.ts apps/desktop/src/renderer/src/lib/kbAssetUrl.test.ts apps/desktop/src/renderer/src/components/chat/AssistantMarkdown.tsx
git commit -m "feat(proposal): 预览嵌图——img override 经 kbasset:// 加载 KB 本地图"
```

---

### Task 6: docx 嵌图

**Files:**
- Modify: `apps/desktop/package.json`（加 image-size 依赖）
- Modify: `apps/desktop/src/main/core/proposalDocx.ts`（image 节点 → ImageRun + 图说，SVG/坏图降级）
- Test: `apps/desktop/src/main/core/proposalDocx.test.ts`（已存在，追加用例）

**Interfaces:**
- Consumes: docx 的 `ImageRun`；新增 `image-size`。
- Produces: 含独占行图的正文 markdown → docx 含真嵌图；不可嵌（svg/坏图）→ 文字降级。

- [ ] **Step 1: 装依赖**

Run（在 `apps/desktop/`）: `bun add image-size`
Expected: package.json dependencies 出现 `image-size`，typecheck 仍可解析。

- [ ] **Step 2: Write the failing test**

在 `proposalDocx.test.ts` 追加（顶部已 import `markdownToDocxBuffer`，再加 `import { writeFileSync } from 'node:fs'`、`import { join } from 'node:path'`、`import { tmpdir } from 'node:os'`）：

```typescript
// 1x1 透明 PNG（base64），写到临时文件供 ImageRun 真读盘嵌入。
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('markdownToDocxBuffer 嵌图', () => {
  it('含真实位图的正文不抛错、产出非空 docx', async () => {
    const png = join(tmpdir(), 'proposal-test-img-1.png')
    writeFileSync(png, Buffer.from(PNG_1x1, 'base64'))
    const md = `<!--proposal-section:content-->\n\n## 架构\n\n![架构图](${png})\n\n（据《白皮书》）`
    const buf = await markdownToDocxBuffer(md)
    expect(buf.length).toBeGreaterThan(1000)
  })

  it('SVG / 读不到的图降级为文字、不抛错', async () => {
    const md =
      '<!--proposal-section:content-->\n\n![矢量图](/nope/x.svg)\n\n![缺图](/nope/missing.png)'
    const buf = await markdownToDocxBuffer(md)
    expect(buf.length).toBeGreaterThan(500)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/main/core/proposalDocx.test.ts`
Expected: 第一个用例可能已不抛错（图被当 alt 文本丢弃），但**没有真嵌图**；第二个用例应已通过（降级走现有 default）。关键是先确认现状：图被丢弃。实现后第一个用例 docx 含真 ImageRun。

> 注：本任务的「红」不在抛错，而在「图没被嵌入」。冒烟断言只保证不崩；真嵌图的验证靠实现后 docx 体积变化 + 后续手动 GUI 核对。先按 TDD 写实现，确保两用例都 PASS 且第一个用例体积明显大于纯文字。

- [ ] **Step 4: Implement**

在 `proposalDocx.ts`：

(a) 顶部 docx import 里加 `ImageRun`；再加：

```typescript
import { readFileSync } from 'node:fs'
import imageSize from 'image-size'
```

(b) 加常量与扩展名→docx 图类型映射（放在 `UL_GLYPH` 等常量附近）：

```typescript
// A4 页宽（twips，210mm）。嵌图最大宽 = 版心宽（页宽 − 左右页边距），换算成 px（96dpi）。
const A4_PAGE_WIDTH_TWIPS = 11906
// 扩展名 → docx ImageRun 的 type。SVG 不在内（v1 不嵌 SVG，降级文字）。
const IMG_TYPE: Record<string, 'png' | 'jpg' | 'gif'> = {
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.gif': 'gif'
}
```

(c) 加图片段构造函数（放在 `blockToDocx` 之前）：

```typescript
// 一个 image mdast 节点 → docx 段落数组：成功则 [居中 ImageRun 段, 居中图说段]；
// 不可嵌（svg/未知扩展/读盘失败/尺寸读不出）则降级为 [「[图：alt]」文字段]，绝不抛错。
// maxWidthPx 为版心宽（px），图按原始像素等比缩放到不超过它。
function imageParagraphs(alt: string, path: string, maxWidthPx: number): Paragraph[] {
  const caption = (alt || path.slice(path.lastIndexOf('/') + 1)).trim()
  const degrade = (): Paragraph[] => [
    new Paragraph({ children: [new TextRun({ text: `[图：${caption}]`, color: '9a9a9e' })] })
  ]
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  const type = IMG_TYPE[ext]
  if (!type) return degrade() // svg / 未知扩展 → 降级
  let data: Buffer
  try {
    data = readFileSync(path)
  } catch {
    return degrade() // 读不到 → 降级
  }
  let w: number, h: number
  try {
    const dim = imageSize(data)
    if (!dim.width || !dim.height) return degrade()
    w = dim.width
    h = dim.height
  } catch {
    return degrade() // 尺寸读不出 → 降级
  }
  // 等比缩放：宽超版心则按比例缩小，否则原尺寸。
  const scale = w > maxWidthPx ? maxWidthPx / w : 1
  const width = Math.round(w * scale)
  const height = Math.round(h * scale)
  const out: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new ImageRun({ type, data, transformation: { width, height } })]
    })
  ]
  if (caption) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: caption, size: 18, color: '9a9a9e' })]
      })
    )
  }
  return out
}
```

(d) 在 `blockToDocx` 的 `case 'paragraph'` 分支**最前面**，加「独占图段落」识别。把现有 `case 'paragraph':` 那段改为：

```typescript
    case 'paragraph': {
      // 独占一行的图（children 仅 image，忽略纯空白 text）→ 居中嵌图 + 图说。
      // 混排（图夹在文字中）不在 v1 范围，退回下面的普通段落渲染（image 经 inlineRuns 取 alt）。
      const imgs = node.children.filter((c) => c.type === 'image')
      const nonEmpty = node.children.filter(
        (c) => !(c.type === 'text' && c.value.trim() === '')
      )
      if (imgs.length > 0 && nonEmpty.every((c) => c.type === 'image')) {
        // env.imgMarginTwips 已是 twips 值（= MARGIN_TWIPS[style.margin]），直接用、勿再 index。
        const maxWidthPx = Math.round(
          ((A4_PAGE_WIDTH_TWIPS - 2 * env.imgMarginTwips) / 1440) * 96
        )
        const out: Paragraph[] = []
        for (const img of imgs) {
          if (img.type === 'image') out.push(...imageParagraphs(img.alt ?? '', img.url, maxWidthPx))
        }
        return out
      }
      return [
        new Paragraph({
          children: inlineRuns(node.children, ctx?.baseStyle),
          indent:
            ctx?.indent ??
            (ctx?.forceAlign
              ? undefined
              : env.bodyFirstLine
                ? { firstLine: env.bodyFirstLine }
                : undefined),
          ...(ctx?.forceAlign ? { alignment: ctx.forceAlign } : {})
        })
      ]
    }
```

(e) `WalkEnv` 接口加 `imgMarginTwips: number`（版心宽算 maxWidth 用），并在 `buildSectionChildren` 构造 env 时传入。把 `WalkEnv` 定义改为：

```typescript
interface WalkEnv {
  walk: { titleConsumed: boolean }
  bodyFirstLine: number
  // 当前模板的页边距（twips），嵌图算版心宽用。
  imgMarginTwips: number
}
```

在 `buildSectionChildren` 里 `const env: WalkEnv = { walk: ..., bodyFirstLine }` 改为：

```typescript
  const env: WalkEnv = {
    walk: { titleConsumed: group.kind !== 'cover' },
    bodyFirstLine,
    imgMarginTwips: MARGIN_TWIPS[style.margin]
  }
```

> 说明：(d) 的 `maxWidthPx` 读 `env.imgMarginTwips`，由本步 (e) 在 `buildSectionChildren` 里赋值为 `MARGIN_TWIPS[style.margin]`。`MARGIN_TWIPS` 已在文件顶部从 proposalStyle import，无需新增。

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test src/main/core/proposalDocx.test.ts`
Expected: PASS（嵌图 + 降级两用例，加 A 的表格冒烟用例全过）；嵌图用例 buffer 明显大于纯文字。

- [ ] **Step 6: Typecheck + Commit**

Run（仓库根）: `bun run typecheck` → PASS

```bash
git add apps/desktop/package.json apps/desktop/src/main/core/proposalDocx.ts apps/desktop/src/main/core/proposalDocx.test.ts
git commit -m "feat(proposal): docx 嵌入 KB 位图（ImageRun + 等比缩放 + 图说），SVG/坏图降级文字"
```

> 若 Step 1 后 bun.lock 等锁文件有改动，一并 `git add`。

---

### Task 7: 预览三态加图接地

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx`（`renderVerification` 加 ungrounded 图标红）

**Interfaces:**
- Consumes: Task 1/2 的 `SectionVerification.imageVerdicts`。
- Produces: 无新导出；UI 在有 ungrounded 图时多一条红条。

> 本任务为渲染态 UI，无现成 RTL 单测基建；以 typecheck 锁定类型、收尾交用户 GUI 核对（与既有 renderVerification 一致，仓库该组件本就靠手动走查）。

- [ ] **Step 1: Implement**

在 `ProposalPaper.tsx` 的 `renderVerification` 里，计算 `notFound`/`unsupported` 之后、最终 return 的红条块里，加图接地红条。把「全绿」判断与红条块改为也考虑 imageVerdicts：

(a) 在 `const unsupported = [...]` 之后加：

```typescript
  const ungroundedImgs = [...new Set((v.imageVerdicts ?? []).filter((d) => d.status === 'ungrounded').map((d) => d.path))]
```

(b) 把「全绿」早返回的条件从

```typescript
  if (notFound.length === 0 && unsupported.length === 0) {
```

改为

```typescript
  if (notFound.length === 0 && unsupported.length === 0 && ungroundedImgs.length === 0) {
```

(c) 在最终 return 的 `<div className="mb-1 space-y-0.5">` 里，`notFound.length > 0 && (...)` 块**之后**加：

```typescript
      {ungroundedImgs.length > 0 && (
        <div className="rounded bg-rose-500/10 px-1.5 py-0.5 text-[11px] text-rose-600">
          ⚠ 有 {ungroundedImgs.length} 张配图不属本段所引文件，疑似挪用/无关图，请核对
        </div>
      )}
```

- [ ] **Step 2: Typecheck**

Run（仓库根）: `bun run typecheck` → PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx
git commit -m "feat(proposal): 预览三态加图接地——未接地配图标红保留"
```

---

### 收尾：全量测试 + typecheck

- [ ] **Step 1: 全量 bun test**

Run（在 `apps/desktop/`）: `bun test src/`
Expected: 全绿，无回归（A 的表格 + B 的图片测试都在内）。

- [ ] **Step 2: 全量 typecheck**

Run（仓库根）: `bun run typecheck` → PASS

- [ ] **Step 3: 手动 GUI 核对（交用户，非 subagent）**

启动 app 写一节含图正文，确认：① 纸面预览能显示 KB 本地图（经 kbasset://）；② 导出 .docx 在 Word 里是真嵌图 + 图说；③ 故意让 AI 引一张不属本节文件的图 → 预览红条提示但图仍在；④ SVG 图降级为文字、导出不崩。

---

## Self-Review

**1. Spec coverage：**
- 组件 1（暴露图给 AI）→ Task 3。✓
- 组件 2（kbasset:// 协议）→ Task 4。✓
- 组件 3（渲染预览嵌图）→ Task 5。✓
- 组件 4（docx 嵌图 + image-size + SVG 降级）→ Task 6。✓
- 组件 5（图接地校验：纯核 parseImages/verifyImagesCore 等价物 + 扩展 verifyCitations + 并入三态）→ Task 1（parseImages/类型）+ Task 2（core+IO）+ Task 7（UI 三态）。✓
- 组件 6（测试）→ 分散在各 Task 的 TDD + 收尾全量。✓
- 决策落实：接地=只用本段所引文件 assets（Task 2 allowed 集合 = citedFiles 的 assets 并集）✓；kbasset:// 非 data-uri（Task 4/5）✓；image-size（Task 6）✓；v1 不嵌 SVG（Task 6 IMG_TYPE 不含 svg → 降级）✓；接地失败标红保留（Task 7 红条，不删图）✓；仅 content 节嵌图（提示词 Task 3 明令封面/目录不插图；校验 verifyCitations 本就只对 content 段有意义）✓。

**2. Placeholder scan：** 无 TBD/TODO；每个代码步给完整可粘贴代码与精确锚点。Task 6 (d) 里 `env.imgMarginTwips` 在 (e) 定义并接好，非占位。

**3. Type consistency：**
- `ImageVerdict { path; status: 'grounded'|'ungrounded' }`、`SectionVerification.imageVerdicts?`、`parseImages(): {alt,path}[]`（Task 1）→ Task 2 core 消费、Task 7 UI 消费，名字/形状一致。✓
- `verifyCitationsCore(markdown, resolveContent, resolveAssets?)` 第三参可选 → 兼容 A 留下的 2 参调用与测试。✓
- `ProposalProductScope.files` 加 `assets: string[]`（Task 3）→ engine.ts map 同步带 assets（Task 3e），`KbIndexFile.assets` 本就存在。✓
- `isPathInsideKbRoot`、`KB_ASSET_SCHEME`、`registerKbAssetProtocol`（Task 4）→ index.ts 消费，名字一致。✓
- `toKbAssetUrl`（Task 5）→ AssistantMarkdown 消费。✓

**已知降级（非缺口）：** docx 嵌图同 A 用「不抛错 + 体积」冒烟，不做 `<w:drawing>` XML 断言（无 zip 库）；Task 7 UI 无单测靠 typecheck + 手动 GUI 核对（与既有 renderVerification 同）。两者均在 spec「未来/不在本 spec」与本计划收尾 Step 3 明示。
