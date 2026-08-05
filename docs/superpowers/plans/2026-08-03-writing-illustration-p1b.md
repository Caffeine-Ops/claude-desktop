# 写作插图能力 P1b（app 联动）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让写作工作区真的把图产出来——写手留下的 ```` ```genimage ```` 指令块自动出图、弹审阅卡、用户点「应用」后原地落成 `![图说](../images/x.png)`，右栏看得见，三条导出链带得走。

**Architecture:** 复用提案（proposal）功能已跑通的整条出图链路，只替换掉三处与提案绑死的部分：图的落点（`<项目>/images/` 而非 `<userData>/proposal-drafts/`）、显示协议（新增 `writingasset://`）、触发时机（写作正文在磁盘、靠轮询，没有内存里的落节事件）。落位复用写作既有的 `WRITING_WRITE_SECTION` 乐观锁通道，不新开写盘入口。

**Tech Stack:** Electron（main / preload / renderer 三进程）、React 19、zustand、TypeScript、bun test。

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-08-03-writing-illustration-design.md` 的 P1b 段（已按 P1a 落地后的实际代码校准）。有冲突以 spec 为准。
- **前置**：P1a 已合入本分支（`skills/writing/` 侧）。本计划一行都不改 `skills/writing/`。
- **加一条 IPC 要同时改四处**：`electron/shared/ipc-channels.ts`（通道常量 + 类型）→ `electron/preload/index.ts`（暴露方法）→ `electron/preload/index.d.ts`（类型）→ main 侧 handler（`electron/main/ipc/register.ts`）。漏一处 typecheck 当场报错。
- **验证命令**：`bun run typecheck`（全 workspace，本仓库无 ESLint，类型检查是唯一全局防线）；`cd apps/studio && bun test`。**`bun test` 有 6 个既存失败，验收标准是「不新增失败」，不是「全绿」。**
- **测试只覆盖三个目录**：`electron/`、`src/chat/lib`、`src/chat/composer`。新写的纯逻辑放进这三处才测得到；React 组件文件测不到，只能人工走查。
- 注释写「为什么这样而不是那样」。中文正文用全角标点，代码 / 路径 / 命令内用半角。
- **插图只在项目模式可用**（`WritingDocSource` 的 `kind: 'project'`）。单文件模式没有 `images/`，不发起出图、不渲染指令卡，并在界面上说明原因——静默不工作比不支持更糟。
- 正文里的图恒为相对路径 `../images/<文件名>`（`drafts/` 与 `images/` 是兄弟目录）。
- 出图凭据取 `getAppSettings().imageApi`，未配置时抛「未配置出图 API，请到设置里填写 key 与地址」——与提案侧同一句文案，卡片据「未配置」字样决定是否显示「去设置」按钮。

---

### Task 1: `writingasset://` 协议与渲染链

**Files:**
- Create: `apps/studio/electron/main/services/writingAssetProtocol.ts`
- Create: `apps/studio/electron/main/services/writingAssetProtocol.test.ts`
- Modify: `apps/studio/electron/main/index.ts:74-95`（`registerSchemesAsPrivileged` 数组）与 `:334-336` 附近（ready 后的注册调用）
- Create: `apps/studio/src/chat/lib/writingAssetUrl.ts`
- Create: `apps/studio/src/chat/lib/writingAssetUrl.test.ts`
- Modify: `apps/studio/src/chat/components/chat/AssistantMarkdown.tsx:205-262`（`img` 覆写的解析链）

**Interfaces:**
- Consumes: 无
- Produces:
  - `WRITING_ASSET_SCHEME = 'writingasset'`
  - `isWritingAssetPath(absPath: string): boolean`
  - `registerWritingAssetProtocol(): Promise<void>`
  - `toWritingAssetUrl(src: string): string` —— 渲染侧构造 URL，非写作资产路径原样返回

- [ ] **Step 1: 写失败的测试（协议守卫）**

创建 `apps/studio/electron/main/services/writingAssetProtocol.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import { isWritingAssetPath } from './writingAssetProtocol'

describe('isWritingAssetPath', () => {
  it('放行写作项目 images/ 下的图片', () => {
    expect(isWritingAssetPath('/Users/k/projects/稿子_20260803/images/gen-1.png')).toBe(true)
  })

  it('拦掉非图片扩展名——协议只该服务图片，别变成任意读盘通道', () => {
    expect(isWritingAssetPath('/Users/k/projects/稿子_20260803/images/secrets.env')).toBe(false)
  })

  it('拦掉不在 images/ 下的路径', () => {
    expect(isWritingAssetPath('/Users/k/projects/稿子_20260803/drafts/01.png')).toBe(false)
  })

  it('空串不放行', () => {
    expect(isWritingAssetPath('')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/main/services/writingAssetProtocol.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现协议**

创建 `apps/studio/electron/main/services/writingAssetProtocol.ts`：

```ts
/**
 * `writingasset://` 自定义协议 —— 让渲染进程显示写作项目里的配图
 * （`<项目>/images/` 下的 AI 生图与用户放进去的图）。
 *
 * 与 kbasset:// / proposalasset:// 的区别、以及为什么另起一个 scheme 而不是
 * 复用 pptasset://（它现有的白名单其实已经能命中写作项目的 images/）：命名语义
 * 与爆炸半径。让写作的图走一个叫 pptasset 的协议，下一个读代码的人会误判归属；
 * 且日后收紧任一侧白名单不会误伤另一侧。
 *
 * 守卫模式与 pptasset:// 同源：写作项目建在用户自己选的目录下，main 进程没有
 * 「枚举所有项目根」的办法，所以不传 resolveRoot 单根守卫，改传 validate
 * 白名单谓词（扩展名 + 路径必须含 /images/）。真正防目录穿越的仍是
 * localAssetProtocol 里对解码后路径的 normalize；白名单只收窄「服务哪些文件」。
 *
 * URL 形：`writingasset://w/<encodeURIComponent(图的绝对路径)>`，
 * 渲染侧由 toWritingAssetUrl 构造（见 src/chat/lib/writingAssetUrl.ts）。
 */

/** 协议名。必须与 index.ts registerSchemesAsPrivileged 里登记的一致。 */
export const WRITING_ASSET_SCHEME = 'writingasset'

import { sep } from 'node:path'
import { registerLocalAssetProtocol } from './localAssetProtocol'

// 只服务位图与 svg。刻意不含视频/音频（pptasset 才需要）——写作正文里放不了它们，
// 白名单越窄，协议被当成通用读盘口子的余地越小。
const ALLOWED_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

// 写作项目的配图只会出现在项目内的 images/ 下（project_manager.py 的 SUBDIRS 建的
// 就是它，正文里的相对路径恒为 ../images/）。
const IMAGES_SEGMENT = `${sep}images${sep}`

/** writingasset:// 的授权判定：扩展名 + 目录片段双重白名单。见文件头注释的取舍说明。 */
export function isWritingAssetPath(absPath: string): boolean {
  if (!absPath || !ALLOWED_EXT_RE.test(absPath)) return false
  // Windows 反斜杠归一化：正文里写的是 posix 分隔符，落盘路径可能是反斜杠，
  // 不归一化会让 win32 上的合法图被判越界（同 shared/proposalAsset 的处理）。
  return absPath.replace(/\//g, sep).includes(IMAGES_SEGMENT)
}

/**
 * 注册 writingasset:// handler。app.whenReady() 之后调用一次；
 * registerSchemesAsPrivileged 必须已在 ready 前跑过（见 index.ts）。
 * `resolveRoot` 传空串占位——validate 存在时 localAssetProtocol 完全不看它。
 */
export async function registerWritingAssetProtocol(): Promise<void> {
  await registerLocalAssetProtocol(WRITING_ASSET_SCHEME, () => '', isWritingAssetPath)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && bun test electron/main/services/writingAssetProtocol.test.ts`
Expected: 4 passed。

- [ ] **Step 5: 登记 scheme 并在 ready 后注册**

在 `apps/studio/electron/main/index.ts`：

1. 顶部 import 区加：
```ts
import { WRITING_ASSET_SCHEME, registerWritingAssetProtocol } from './services/writingAssetProtocol'
```
2. `protocol.registerSchemesAsPrivileged([...])`（第 74 行起）的数组里，照 `PPT_ASSET_SCHEME` 那一项的写法追加一项 `WRITING_ASSET_SCHEME`（privileges 与它保持一致）。同时把第 85-88 行的注释补上 `writingasset:// = 写作项目配图`。
3. ready 回调里 `await registerPptAssetProtocol()`（第 336 行）之后追加：
```ts
  await registerWritingAssetProtocol()
```

> ⚠️ `registerSchemesAsPrivileged` **只能在 app ready 之前调用一次**。漏登记的自定义协议在 `<img src>` 里会被当不安全内容直接拦掉，且不报错——图空白、控制台无线索。

- [ ] **Step 6: 写渲染侧 URL 构造 + 测试**

创建 `apps/studio/src/chat/lib/writingAssetUrl.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import { toWritingAssetUrl } from './writingAssetUrl'

describe('toWritingAssetUrl', () => {
  it('写作项目配图转成 writingasset:// URL', () => {
    const p = '/Users/k/projects/稿子_20260803/images/gen-1.png'
    expect(toWritingAssetUrl(p)).toBe(`writingasset://w/${encodeURIComponent(p)}`)
  })

  it('非写作资产路径原样返回——链式判定靠这个不误伤外链与 KB 图', () => {
    expect(toWritingAssetUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(toWritingAssetUrl('/Users/k/kb-index/assets/x.png')).toBe('/Users/k/kb-index/assets/x.png')
  })

  it('空串原样返回', () => {
    expect(toWritingAssetUrl('')).toBe('')
  })
})
```

创建 `apps/studio/src/chat/lib/writingAssetUrl.ts`：

```ts
/**
 * 把「写作项目配图的绝对路径」转成 `writingasset://` URL 供 <img> 加载。
 * 与 toKbAssetUrl / toProposalAssetUrl 并列：三者的路径特征互斥
 * （KB 图含 /kb-index/assets/、提案产出图含 /proposal-drafts/ + /assets/、
 * 写作配图含 /images/ 且不在前两者之下），所以调用方可以无脑链式尝试，
 * 不需要按场景传参决定用哪个。
 *
 * 判定谓词与 main 侧的 isWritingAssetPath 是同一套规则的两份实现——本文件
 * 不能 import main 侧模块（渲染进程拿不到 node:path）。两处规则若漂移，
 * 症状是「渲染侧转了 URL、main 侧判越界回 403」，图空白但控制台有 403，
 * 可查。改任一侧务必同步另一侧。
 */
const ALLOWED_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

export function isWritingAssetSrc(src: string): boolean {
  if (!src || !ALLOWED_EXT_RE.test(src)) return false
  if (!src.startsWith('/')) return false // 外链 http(s) 与相对路径都不是本地资产
  if (src.includes('/kb-index/assets/')) return false
  if (src.includes('/proposal-drafts/')) return false
  return src.includes('/images/')
}

export function toWritingAssetUrl(src: string): string {
  if (!src) return src
  if (isWritingAssetSrc(src)) return `writingasset://w/${encodeURIComponent(src)}`
  return src
}
```

Run: `cd apps/studio && bun test src/chat/lib/writingAssetUrl.test.ts`
Expected: 3 passed。

- [ ] **Step 7: 接进 AssistantMarkdown 的 img 解析链**

`apps/studio/src/chat/components/chat/AssistantMarkdown.tsx`：顶部 import 区加 `import { toWritingAssetUrl } from '../../lib/writingAssetUrl'`，并把第 213-214 行那两行链式判定改成三段：

```tsx
      const kbUrl = toKbAssetUrl(path)
      // 三种本地资产的路径特征互斥（见 writingAssetUrl.ts 头注释），链式尝试零歧义：
      // KB 图 → 提案产出图 → 写作项目配图。任一命中即停。
      const resolved =
        kbUrl !== path
          ? kbUrl
          : (() => {
              const proposalUrl = toProposalAssetUrl(path)
              return proposalUrl !== path ? proposalUrl : toWritingAssetUrl(path)
            })()
```

> 下方 `resolved !== path` 的分支（可嵌格式降级、`data-raw-src` 挂载）无需改动——它判的是「URL 是否被改写」，对第三种资产自然成立。

- [ ] **Step 8: 全量验证并提交**

Run: `bun run typecheck && cd apps/studio && bun test 2>&1 | tail -5`
Expected: typecheck 通过；`bun test` 失败数不多于基线 6 个。

```bash
git add apps/studio/electron/main/services/writingAssetProtocol.ts apps/studio/electron/main/services/writingAssetProtocol.test.ts apps/studio/electron/main/index.ts apps/studio/src/chat/lib/writingAssetUrl.ts apps/studio/src/chat/lib/writingAssetUrl.test.ts apps/studio/src/chat/components/chat/AssistantMarkdown.tsx
git commit -m "feat(writing): 新增 writingasset:// 协议，项目配图能在预览里显示"
```

---

### Task 2: 写作出图 IPC 与落盘

**Files:**
- Modify: `apps/studio/electron/shared/ipc-channels.ts`（通道常量 + payload/result 类型 + `ChatApi` 方法签名）
- Modify: `apps/studio/electron/preload/index.ts`、`apps/studio/electron/preload/index.d.ts`
- Modify: `apps/studio/electron/main/ipc/register.ts`（handler + `removeHandler`）
- Create: `apps/studio/electron/main/core/writingImageWriter.ts`
- Create: `apps/studio/electron/main/core/writingImageWriter.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isWritingAssetPath` 约定（图必须落在 `<项目>/images/` 才显示得出来）
- Produces:
  - IPC 通道 `WRITING_IMAGE_GENERATE: 'writing:image-generate'`
  - `WritingImageGeneratePayload { projectDir: string; prompt: string }`
  - `WritingImageResult { path: string; relPath: string }` —— `path` 绝对路径（渲染显示用），`relPath` 形如 `../images/gen-<ts>.png`（写进正文用）
  - `window.chatApi.writingImageGenerate(payload): Promise<WritingImageResult>`
  - `writingImagePathFor(projectDir: string, ext: string, ts: number): string` —— 纯拼路径，可测

- [ ] **Step 1: 写失败的测试**

创建 `apps/studio/electron/main/core/writingImageWriter.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { writingImagePathFor, writingImageRelPath } from './writingImageWriter'

describe('writingImagePathFor', () => {
  it('落在项目的 images/ 下，文件名带时间戳', () => {
    const p = writingImagePathFor('/Users/k/projects/稿子_20260803', 'png', 1754200000000)
    expect(p).toBe(join('/Users/k/projects/稿子_20260803', 'images', 'gen-1754200000000.png'))
  })

  it('扩展名跟着实际字节走，不写死 png', () => {
    const p = writingImagePathFor('/p', 'webp', 1)
    expect(p.endsWith('.webp')).toBe(true)
  })
})

describe('writingImageRelPath', () => {
  it('回 ../images/<文件名>——正文在 drafts/，与 images/ 是兄弟目录', () => {
    expect(writingImageRelPath('gen-1.png')).toBe('../images/gen-1.png')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/main/core/writingImageWriter.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 writer**

创建 `apps/studio/electron/main/core/writingImageWriter.ts`：

```ts
/**
 * 写作配图落盘 helper：把 imageGenService 产出的 Buffer 存进**写作项目自己的**
 * `images/` 目录，返回绝对路径与正文用的相对路径。
 *
 * 与 proposalImageWriter 的关键区别：提案的图落 `<userData>/proposal-drafts/`
 * （app 内部数据区），写作的图落用户磁盘上的项目目录。理由是写作项目本来就建在
 * 用户看得见的地方，图跟着项目走、整个文件夹搬到别处图也不丢，且纯命令行跑
 * 写作技能时落点一致。
 *
 * 两个纯函数刻意不碰 fs、不 import electron：保持本模块对 `bun test` 可加载
 * （顶层 import electron 会在 bun 环境炸掉，同 proposalImageWriter 的约定）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 纯拼路径（可测）。文件名前缀 `gen-` 与提案侧同义，标明来源是 AI 生成。 */
export function writingImagePathFor(projectDir: string, ext: string, ts: number): string {
  return join(projectDir, 'images', `gen-${ts}.${ext}`)
}

/**
 * 正文里引用配图用的相对路径。恒为 `../images/<文件名>`——正文分节文件在
 * `<项目>/drafts/`，与 `images/` 是兄弟目录。写相对而非绝对，是为了整个项目
 * 文件夹搬走后正文里的引用仍然有效。
 */
export function writingImageRelPath(fileName: string): string {
  return `../images/${fileName}`
}

/** 落盘：mkdir -p `<项目>/images/` 后写文件，返回绝对路径与相对路径。 */
export async function writeWritingImage(
  projectDir: string,
  bytes: Buffer,
  ext = 'png',
  ts = Date.now()
): Promise<{ path: string; relPath: string }> {
  const abs = writingImagePathFor(projectDir, ext, ts)
  await mkdir(join(projectDir, 'images'), { recursive: true })
  await writeFile(abs, bytes)
  return { path: abs, relPath: writingImageRelPath(`gen-${ts}.${ext}`) }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && bun test electron/main/core/writingImageWriter.test.ts`
Expected: 3 passed。

- [ ] **Step 5: 加 IPC —— 四处同改**

**5a. `apps/studio/electron/shared/ipc-channels.ts`**：在 `WRITING_EXPORT_PDF` 常量之后加通道常量，并在类型区（`WritingExportResult` 附近）加两个类型：

```ts
  /**
   * 写作工作区出图：按提示词生成一张配图，落进 `<项目>/images/`。
   * 与 PROPOSAL_IMAGE_GENERATE 分成两条通道而不是加参数，是因为**落点根本不同**
   * （项目目录 vs userData 草稿区），合并会让 handler 里长出一个 kind 分支，
   * 两种落盘语义混在一处，日后改任一侧都要重读另一侧。
   */
  WRITING_IMAGE_GENERATE: 'writing:image-generate',
```

```ts
/** Payload for WRITING_IMAGE_GENERATE. `projectDir` 是写作项目根（含 drafts/ images/ 的那层）。 */
export interface WritingImageGeneratePayload {
  projectDir: string
  prompt: string
}
/**
 * Result of WRITING_IMAGE_GENERATE。
 * `path` = 绝对路径，渲染侧转 writingasset:// 显示用；
 * `relPath` = `../images/<文件名>`，落位时写进正文用。两个都回，是为了让渲染侧
 * 不必自己做路径运算（它拿不到 node:path，手拼容易在 Windows 上出错）。
 */
export interface WritingImageResult {
  path: string
  relPath: string
}
```

在 `ChatApi` 接口里（`writingExportPdf` 附近）加：
```ts
  /** 写作工作区出图：生成一张配图并落进项目的 images/。未配置出图 API 时抛错。 */
  writingImageGenerate(payload: WritingImageGeneratePayload): Promise<WritingImageResult>
```

**5b. `apps/studio/electron/preload/index.ts`**：照邻近的 `writingExportPdf` 写法加一行 `invoke` 转发。

**5c. `apps/studio/electron/preload/index.d.ts`**：同步方法签名。

**5d. `apps/studio/electron/main/ipc/register.ts`**：
- 在 `removeHandler` 区（约第 502 行，`WRITING_WECHAT_HTML` 附近）加
  `ipcMain.removeHandler(IPC_CHANNELS.WRITING_IMAGE_GENERATE)`
- 在 handler 区（`PROPOSAL_IMAGE_GENERATE` 附近，约第 3237 行）加：

```ts
  ipcMain.handle(
    IPC_CHANNELS.WRITING_IMAGE_GENERATE,
    async (_event, args: WritingImageGeneratePayload): Promise<WritingImageResult> => {
      const projectDir = typeof args?.projectDir === 'string' ? args.projectDir : ''
      const prompt = typeof args?.prompt === 'string' ? args.prompt : ''
      if (!projectDir || !prompt) throw new Error('缺少项目路径或提示词')
      const cfg = getAppSettings().imageApi
      // 文案与提案侧逐字一致：卡片按「未配置」字样决定要不要显示「去设置」按钮，
      // 换个说法会让那个按钮静默消失。
      if (!cfg?.apiKey) throw new Error('未配置出图 API，请到设置里填写 key 与地址')
      const bytes = await generateImage(cfg, { prompt })
      return writeWritingImage(projectDir, bytes, embeddableExtFor(bytes))
    }
  )
```

（`generateImage` / `embeddableExtFor` / `getAppSettings` 在该文件里已有 import，`writeWritingImage` 需新增 import。）

- [ ] **Step 6: 验证并提交**

Run: `bun run typecheck && cd apps/studio && bun test 2>&1 | tail -5`
Expected: typecheck 通过（漏改四处任一处都会在这里报错）；测试失败数不多于基线。

```bash
git add apps/studio/electron/shared/ipc-channels.ts apps/studio/electron/preload/ apps/studio/electron/main/ipc/register.ts apps/studio/electron/main/core/writingImageWriter.ts apps/studio/electron/main/core/writingImageWriter.test.ts
git commit -m "feat(writing): 加出图 IPC，图落进项目自己的 images/"
```

---

### Task 3: 卡片组件抽共用（纯重构，不改任何行为）

> ⚠️ **这一步是纯重构，必须单独提交、单独验收。** 判据：提案功能的行为必须逐字不变。不许顺手改文案、不许顺手改样式、不许「优化」结构。理由（用户既有偏好）：重构与改行为混在一次提交里，出问题时无法二分定位是哪一半引入的。

**Files:**
- Create: `apps/studio/src/chat/lib/imageReviewTypes.ts`
- Modify: `apps/studio/src/chat/stores/proposal.ts:66-98`（两个 interface 改为从新模块 re-export）
- Modify: `apps/studio/src/chat/components/workspace/ProposalImageReview.tsx:1-20`（import 来源 + `resolveImageSrc` 链）
- Modify: `apps/studio/src/chat/components/workspace/GenImageDirectiveCard.tsx:1-47`（import 来源 + 标签参数化）

**Interfaces:**
- Consumes: Task 1 的 `toWritingAssetUrl`
- Produces:
  - `imageReviewTypes.ts` 导出 `GenImageJob`、`ImageReview`（定义原样搬家，字段一个不改）
  - `GenImageDirectiveCardProps` 新增可选 `label?: string`，默认 `'方案配图'`

- [ ] **Step 1: 搬类型**

创建 `apps/studio/src/chat/lib/imageReviewTypes.ts`，把 `stores/proposal.ts` 第 66-98 行的 `ImageReview` 与 `GenImageJob` **连同全部注释原样搬过去**，文件头加：

```ts
/**
 * 出图 / 改图的审阅卡与任务态类型。原本住在 stores/proposal.ts，2026-08-03 搬到
 * 这里——写作工作区要复用同一套卡片组件，让它 import 提案的 store 模块只为拿两个
 * 类型，会把两个 feature 的依赖方向拧成环（写作 store → 提案 store）。
 *
 * 只有类型，没有运行时代码：两边各自的 store 持有各自的实例，互不共享状态。
 */
```

`stores/proposal.ts` 原位置改为 re-export，保持所有既有 import 路径不变：

```ts
// 类型已搬到 lib/imageReviewTypes.ts（写作工作区共用）。此处 re-export 保持既有
// import 路径可用——一次性改掉全部调用点属于与本次重构无关的扩散改动。
export type { ImageReview, GenImageJob } from '../lib/imageReviewTypes'
```

- [ ] **Step 2: 扩展 resolveImageSrc 的解析链**

`ProposalImageReview.tsx` 第 16-20 行改为：

```tsx
// src 解析链与 AssistantMarkdown 一致：kbasset://（知识库镜像图）→
// proposalasset://（提案草稿产出图）→ writingasset://（写作项目配图）。
// 三者的路径特征互斥，链式尝试不会误判，所以本组件可以两个 feature 共用、
// 不需要按场景传参决定用哪个协议。
function resolveImageSrc(src: string): string {
  const kbUrl = toKbAssetUrl(src)
  if (kbUrl !== src) return kbUrl
  const proposalUrl = toProposalAssetUrl(src)
  if (proposalUrl !== src) return proposalUrl
  return toWritingAssetUrl(src)
}
```

同时把第 2 行的 `import type { ImageReview } from '../../stores/proposal'` 改为从 `'../../lib/imageReviewTypes'` 取，并加 `import { toWritingAssetUrl } from '../../lib/writingAssetUrl'`。

- [ ] **Step 3: 卡片标签参数化**

`GenImageDirectiveCard.tsx`：
- 第 1 行 import 改为 `import type { GenImageJob } from '../../lib/imageReviewTypes'`
- `GenImageDirectiveCardProps` 加：
```tsx
  /**
   * 卡片标题前缀。默认「方案配图」保持提案侧行为逐字不变；写作侧传「文章配图」。
   * 参数化而不是各写一个组件：四态渲染逻辑（pending / failed / done+审阅卡 /
   * done+搁浅 / 手动）是两边共同的复杂度，复制一份必然只修其中一份。
   */
  label?: string
```
- 解构处加 `label = '方案配图'`，第 47 行渲染改为 `{label}：{caption}`

- [ ] **Step 4: 验证行为不变**

Run: `bun run typecheck && cd apps/studio && bun test 2>&1 | tail -5`
Expected: typecheck 通过，测试失败数不多于基线。

**人工走查（必做，这是纯重构的唯一行为验证）**：`bun run dev` 起 app → 打开一个提案草稿 → 确认改图/生图审阅卡照常渲染、图能显示、「应用 / 放弃 / 重改」三个按钮照常工作、genimage 指令卡文案仍是「方案配图：…」。**任何一处与重构前不同，都算本任务失败。**

- [ ] **Step 5: 提交**

```bash
git add apps/studio/src/chat/lib/imageReviewTypes.ts apps/studio/src/chat/stores/proposal.ts apps/studio/src/chat/components/workspace/ProposalImageReview.tsx apps/studio/src/chat/components/workspace/GenImageDirectiveCard.tsx
git commit -m "refactor(proposal,writing): 出图审阅卡抽成两边共用，行为不变"
```

---

### Task 4: 写作侧出图触发器

**Files:**
- Modify: `apps/studio/src/chat/stores/writing.ts`（新增 genImageJobs / imageReviews 切片与 setter）
- Create: `apps/studio/src/chat/lib/writingGenImageFire.ts`
- Create: `apps/studio/src/chat/lib/writingGenImageFire.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `window.chatApi.writingImageGenerate`；`@desktop-shared/proposalGenImage` 的 `parseGenImageDirectives` / `genImageDirectiveKey` / `GenImageDirective`（shared 层，直接 import，**不复制一份解析器**）；Task 3 的 `GenImageJob` / `ImageReview` 类型
- Produces:
  - writing store 新增：`genImageJobs: Record<string, GenImageJob>`、`imageReviews: ImageReview[]`、`setGenImageJob(key, job)`、`addImageReview(r)`、`removeImageReview(id)`、`seedManualGenImageJobs(sections)`
  - `buildWritingGenImagePrompt(d: { caption: string; prompt: string }, imageStyle: string): string`
  - `fireWritingGenImage(projectDir: string, sectionName: string, d: GenImageDirective): Promise<void>`
  - `autoFireWritingGenImages(): void`
  - `MAX_AUTO_FIRE_PER_WRITING_PROJECT = 5`

- [ ] **Step 1: 写失败的测试**

创建 `apps/studio/src/chat/lib/writingGenImageFire.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import { buildWritingGenImagePrompt } from './writingGenImageFire'

describe('buildWritingGenImagePrompt', () => {
  it('把契约锁定的画风拼进提示词——风格来自 spec_lock 的 image_style，不是硬编码', () => {
    const p = buildWritingGenImagePrompt(
      { caption: '深夜的便利店', prompt: '暖黄灯光，窗外下雨，人物背影' },
      '极简线条插画，低饱和暖色'
    )
    expect(p).toContain('深夜的便利店')
    expect(p).toContain('暖黄灯光，窗外下雨，人物背影')
    expect(p).toContain('极简线条插画，低饱和暖色')
  })

  it('画风为空时不拼出空的风格句', () => {
    const p = buildWritingGenImagePrompt({ caption: 'a', prompt: 'b' }, '')
    expect(p).not.toContain('风格要求：\n')
    expect(p.trim().endsWith('：')).toBe(false)
  })

  it('恒定要求「不要在图里写字」——生图模型的中文标注必糊，这是写作配图的硬伤', () => {
    const p = buildWritingGenImagePrompt({ caption: 'a', prompt: 'b' }, 'x')
    expect(p).toContain('不要在画面中出现任何文字')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test src/chat/lib/writingGenImageFire.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 扩 writing store**

`apps/studio/src/chat/stores/writing.ts`：`WritingState` 接口加四个字段与四个方法（照该文件既有 setter 的写法实现），并在 `setSource` 切换项目时清空两者：

```ts
  /**
   * genimage 指令块的生图任务态。键 = genImageDirectiveKey(节名, 指令块原文, 出现序)。
   * 三重职责与提案侧同源：① 幂等 seen 集合——键存在（无论何态）即不再自动发起，
   * 这是防重复烧钱的核心，写作靠轮询触发、每几秒跑一次，没有它就是每轮重复出图；
   * ② 驱动指令块卡片的多态渲染；③ manual 态是重开会话时预登记的哨兵。
   * 用【节名】而不是节 id 当键的一部分：写作的节就是磁盘文件，文件名即身份。
   */
  genImageJobs: Record<string, GenImageJob>
  /** 待用户裁决的出图审阅卡。切换项目时清空——未决提议不跨项目留存。 */
  imageReviews: ImageReview[]
```

- [ ] **Step 4: 实现触发器**

创建 `apps/studio/src/chat/lib/writingGenImageFire.ts`。核心要点（逐条都要在注释里写明理由）：

```ts
/**
 * 写作工作区的 genimage 指令块生图发起器。
 *
 * 与提案侧 proposalGenImageFire 的**根本差异**：提案的正文活在内存 store 里，
 * 有明确的「落节」事件可挂；写作的正文是磁盘上的 drafts/*.md，右栏靠
 * useWritingPoll 每几秒重扫（比对 name:mtimeNs:size 签名）。没有事件，只有轮询。
 * 这带来两个必须显式解决的问题：
 *
 * ① **幂等**——轮询每几秒跑一次，没有 job key 记账就是每一轮重复出图、重复烧钱。
 * ② **稳定判据**——AI 还在写这一节时文件仍在变，此刻的指令块可能是半截的
 *    （围栏未闭合、构图描述只写了一半）。所以只在该节签名**连续两轮不变**时才发起。
 *    提案侧靠「落节」天然规避了这个问题，写作必须显式做。
 */
export const MAX_AUTO_FIRE_PER_WRITING_PROJECT = 5

/** 提示词 = 图说 + 构图描述 + 契约锁定的画风 + 三条恒定约束。 */
export function buildWritingGenImagePrompt(
  d: { caption: string; prompt: string },
  imageStyle: string
): string {
  const style = imageStyle.trim()
  return (
    `为一篇文章绘制配图「${d.caption}」：${d.prompt}\n` +
    (style ? `风格要求：${style}。\n` : '') +
    '恒定要求：不要在画面中出现任何文字（生图模型的中文标注必糊必错，' +
    '需要文字的信息图一律由 mermaid 承担）；不要水印；不要与内容无关的装饰元素。'
  )
}
```

`fireWritingGenImage(projectDir, sectionName, d)` 的流程与提案侧同构：登记 pending → `window.chatApi.writingImageGenerate({ projectDir, prompt })` → 成功则 `addImageReview({ sectionId: sectionName, blockIndex: d.blockIndex, resultPath: path, mode: 'directive', directiveRaw: d.raw, directiveOccurrence: d.occurrence, caption: d.caption })` 并把 job 置 done → 失败置 failed 并存 `friendlyImageError(err, 'generate')`。**成功与失败两条路径都要先确认该节仍存在**（网络往返期间用户可能切了项目），否则不写表——理由与提案侧 `fireGenImageDirective` 第 43-45 / 58-62 行的注释相同。

`autoFireWritingGenImages()` 的守卫，缺一不可：
1. `source?.kind !== 'project'` → 直接 return（单文件模式没有 `images/`，见 Global Constraints）
2. 每节维护「上一轮签名」，签名与上轮不同 → 本轮不发起，只记签名（稳定判据）
3. `genImageJobs[key]` 已存在 → 跳过（幂等）
4. 已发起数（不含 `manual` 态）达 `MAX_AUTO_FIRE_PER_WRITING_PROJECT` → `console.warn` 并 return，其余留手动卡
5. 画风取自契约：从 writing store 已有的字段取 `image_style`；取不到传空串（`buildWritingGenImagePrompt` 已处理空值）

- [ ] **Step 5: 让 WRITING_SCAN 顺带回契约锁定的画风**

写作 store 目前不解析 `spec_lock.md`，但提示词需要契约里的 `image_style`。**做法：扩 `WRITING_SCAN` 的返回值，不新开通道**——`genre` 与 `outlineTotal` 已经是 main 侧读项目文件算出来后随 scan 回来的，加第三个字段不引入新往返，也不用在 renderer 里解析 Markdown。

改动点（scan 是既有通道，**不需要动 preload**，但返回类型变了，四处里的三处要动）：
1. `electron/shared/ipc-channels.ts` —— `WritingScanResultIpc` 的 `ok: true` 分支加 `imageStyle: string | null`
2. main 侧 `WRITING_SCAN` handler —— 照它已有的 `genre` 解析写法，读 `<项目>/spec_lock.md` 的 `## 配图` 段取 `image_style`；文件不存在、段不存在、字段不存在都回 `null`（这三种都是正常态：职场快道刻意不建 spec_lock，`image_plan: none` 时本字段留空）
3. `src/chat/stores/writing.ts` 的 `applyScan` —— 多存一个 `imageStyle` 字段

`buildWritingGenImagePrompt` 的第二参传 `imageStyle ?? ''`，空值已由它内部处理。

- [ ] **Step 6: 跑测试确认通过 + 提交**

Run: `cd apps/studio && bun test src/chat/lib/writingGenImageFire.test.ts && cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck`
Expected: 3 passed；typecheck 通过。

```bash
git add apps/studio/src/chat/stores/writing.ts apps/studio/src/chat/lib/writingGenImageFire.ts apps/studio/src/chat/lib/writingGenImageFire.test.ts apps/studio/electron/shared/ipc-channels.ts apps/studio/electron/main/ipc/register.ts
git commit -m "feat(writing): 出图触发器，轮询发现新指令块后按稳定判据发起"
```

---

### Task 5: 指令卡与审阅卡接进纸面

**Files:**
- Modify: `apps/studio/src/chat/components/workspace/WritingPaper.tsx`（块渲染分支 + 审阅卡挂载 + 应用/丢弃处理）
- Modify: `apps/studio/src/chat/runtime/FusionRuntimeProvider.tsx`（轮末调用 `autoFireWritingGenImages`，挂在既有的 `handleWritingTurnEnd` 附近）
- Create: `apps/studio/src/chat/lib/writingGenImageApply.ts`
- Create: `apps/studio/src/chat/lib/writingGenImageApply.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `relPath`、Task 3 的卡片组件、Task 4 的 store 切片与触发器
- Produces:
  - `applyGenImageToSection(markdown: string, directiveRaw: string, occurrence: number, caption: string, relPath: string): string | null` —— 把指令块原地换成 `![图说](相对路径)`，定位不到回 null
  - `discardGenImageFromSection(markdown: string, directiveRaw: string, occurrence: number): string | null` —— 删掉指令块

> **组件文件不在 `bun test` 覆盖目录内**，所以手术逻辑必须抽成 `src/chat/lib` 下的纯函数才测得到。`WritingPaper.tsx` 里只留「调用 + 写盘 + 错误提示」。

- [ ] **Step 1: 写失败的测试**

创建 `apps/studio/src/chat/lib/writingGenImageApply.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import { applyGenImageToSection, discardGenImageFromSection } from './writingGenImageApply'

const RAW = '```genimage\n图说: 深夜的便利店\n暖黄灯光\n```'
const MD = `第一段。\n\n${RAW}\n\n第二段。`

describe('applyGenImageToSection', () => {
  it('指令块原地换成图片引用，前后正文不动', () => {
    const out = applyGenImageToSection(MD, RAW, 0, '深夜的便利店', '../images/gen-1.png')
    expect(out).toBe('第一段。\n\n![深夜的便利店](../images/gen-1.png)\n\n第二段。')
  })

  it('同内容多个指令块按 occurrence 精确定位第二个', () => {
    const two = `${RAW}\n\n中间。\n\n${RAW}`
    const out = applyGenImageToSection(two, RAW, 1, '图', '../images/a.png')
    expect(out).toBe(`${RAW}\n\n中间。\n\n![图](../images/a.png)`)
  })

  it('定位不到回 null——审阅悬而未决期间该节可能被改写，绝不能瞎猜位置乱替换', () => {
    expect(applyGenImageToSection('别的内容', RAW, 0, '图', '../images/a.png')).toBeNull()
  })
})

describe('discardGenImageFromSection', () => {
  it('删掉指令块且不留下连续空行', () => {
    const out = discardGenImageFromSection(MD, RAW, 0)
    expect(out).toBe('第一段。\n\n第二段。')
  })

  it('定位不到回 null', () => {
    expect(discardGenImageFromSection('别的内容', RAW, 0)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test src/chat/lib/writingGenImageApply.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现手术函数**

创建 `apps/studio/src/chat/lib/writingGenImageApply.ts`。要点：

- **按【指令块原文 + 出现序】定位，不按块下标**。理由与 `shared/proposalGenImage.ts` 顶注同源：审阅悬而未决期间该节可能被 AI 或用户并发编辑，块序会漂，内容键比下标键稳。
- 复用 `@desktop-shared/proposalBlocks` 的 `splitBlocks` 切块，逐块 `trim()` 与 `directiveRaw` 比对，数到第 `occurrence` 个命中才动手。
- 定位不到一律回 `null`，由调用方提示用户「原文已变化，请重新生成」——**绝不允许猜位置**。
- `discard` 删块后要合并相邻空行，避免正文里留下一个突兀的空段。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && bun test src/chat/lib/writingGenImageApply.test.ts`
Expected: 6 passed。

- [ ] **Step 5: 接进 WritingPaper**

`WritingPaper.tsx` 的块渲染循环（约第 660-750 行，现在对每块渲染 `<AssistantMarkdown text={block} />`）里加一个分支：块是 genimage 指令块（用 `isGenImageDirectiveBlock`）时，渲染 `<GenImageDirectiveCard label="文章配图" … />` 而不是把围栏源码丢给 markdown 渲染器。紧随其后渲染该块对应的 `<ProposalImageReview …/>`（按 `sectionId + directiveRaw + directiveOccurrence` 匹配）。

「应用」的落地路径**必须**是：`applyGenImageToSection` 算出新 markdown → 调既有的 `commitSection`（它内部走 `WRITING_WRITE_SECTION` 的 `expectedMtimeMs` 乐观锁）→ 成功后 `removeImageReview`。

> ⛔ **不许新开写盘入口。** `commitSection` 是手动编辑与 AI 选区改写共用的那一条，带乐观锁与 20 步撤销栈。绕过它直接调 IPC 写盘，会同时丢掉并发保护和撤销能力——已知残留「一次写盘在飞的窗口内连点两块会乱序覆盖」正是在这条路径上，多开一个入口只会把它放大。

单文件模式（`source.kind === 'single'`）下不渲染任何指令卡，改渲染一行说明：「配图需要项目模式（图要落在项目的 images/ 里），当前是单文件模式」。

- [ ] **Step 6: 接轮末触发**

`FusionRuntimeProvider.tsx`：在既有 `handleWritingTurnEnd(sid, messageId)` 调用处（约第 1762 行）之后追加 `autoFireWritingGenImages()`。**不要**挂进 `useWritingPoll` 的每一轮 tick——轮末触发一次 + 稳定判据，比每轮都扫更省。

- [ ] **Step 7: 验证并提交**

Run: `bun run typecheck && cd apps/studio && bun test 2>&1 | tail -5`

**人工走查（组件层测不到，必做）**：起 app → 写作项目里让 AI 产出一个 genimage 指令块 → 确认渲染成卡片而不是代码块 → 出图后弹审阅卡 → 点「应用」→ 正文里变成图且显示得出来 → 点「丢弃」→ 指令块消失。

```bash
git add apps/studio/src/chat/lib/writingGenImageApply.ts apps/studio/src/chat/lib/writingGenImageApply.test.ts apps/studio/src/chat/components/workspace/WritingPaper.tsx apps/studio/src/chat/runtime/FusionRuntimeProvider.tsx
git commit -m "feat(writing): 指令卡与审阅卡接进纸面，应用经乐观锁落盘"
```

---

### Task 6: 公众号 HTML 补齐（TS 侧照抄 Python）

**Files:**
- Modify: `apps/studio/electron/main/core/writingWechat.ts`
- Modify: `apps/studio/electron/main/core/writingWechat.test.ts`

**Interfaces:**
- Consumes: 无（与 renderer 无关，是 main 侧纯转换）
- Produces: `md_to_wechat_html` 的 TS 对应物新增三项行为，与 `skills/writing/scripts/export.py` 对齐

**背景（实施者必须先读）**：`writingWechat.ts` 是 `skills/writing/scripts/export.py` 里 `md_to_wechat_html` 的 TS 移植，两份实现同一套正则与取舍，`writingWechat.test.ts` 已在断言两者对齐。P1a 给 Python 那份加了三样东西，TS 这份还没有。**先逐行读 `skills/writing/scripts/export.py` 的 `md_to_wechat_html`、`fence_placeholder_html`、`_IMAGE` 相关代码**，照它的取舍移植，不要另起一套。

- [ ] **Step 1: 写失败的测试**

在 `writingWechat.test.ts` 里追加三组用例，断言：
1. 独占一行的 `![图说](路径)` 渲成 `<img>` + `<figcaption>`，不被包进 `<p>`；图说为空时不产出 figcaption；图说要 HTML 转义。
2. ```` ```genimage ```` 块渲成占位框，**HTML 里不出现围栏源码**（断言不含 `图说:` 原文行与三反引号），且占位框里带图说。
3. ```` ```mermaid ```` 块渲成占位框，HTML 里不出现 `graph TD` 之类的源码。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/main/core/writingWechat.test.ts`
Expected: 新增用例 FAIL（当前实现把围栏源码逐行渲成 `<p>`）。

- [ ] **Step 3: 移植实现**

照 `export.py` 的对应函数移植三项：图片行渲染、围栏占位框、`<img src>` 指向复制后的文件（TS 侧当前没有复制步骤，故 `src` 保持正文里的相对路径；**在代码注释里写明这一点与 Python 侧的差异及原因**——TS 路径是「复制到剪贴板」，没有输出目录可落图）。

> ⚠️ 移植时在两侧注释里互相指认（`export.py` 的模块 docstring 已经指了过来），并在 TS 侧注明：新增块级语法必须两边同步，现有测试只能盯住已知语法。

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `bun run typecheck && cd apps/studio && bun test electron/main/core/writingWechat.test.ts`

```bash
git add apps/studio/electron/main/core/writingWechat.ts apps/studio/electron/main/core/writingWechat.test.ts
git commit -m "feat(writing): app 侧公众号导出补齐图片与占位框，与 export.py 对齐"
```

---

### Task 7: docx 嵌图与 PDF 的 mermaid 预渲染

**Files:**
- Modify: `apps/studio/electron/main/core/writingExport.ts` 或 `writingExportPure.ts`（docx 侧嵌图；先读清两者职责再定改哪个）
- Modify: `apps/studio/src/chat/components/workspace/WritingDocPanel.tsx:570-590`（PDF 侧预渲染 mermaid）
- Modify: 对应的 `*.test.ts`

**Interfaces:**
- Consumes: Task 1 的显示协议（PDF 预渲染走 renderer，图片路径要能加载）
- Produces: 无（终点任务）

- [ ] **Step 1: 补 PDF 的 mermaid 预渲染**

`WritingDocPanel.tsx:578-579` 现在写着「写作体裁不支持 mermaid 代码块，必须显式传 undefined」，给 `renderProposalPdfHtml` 的第三个参数传了 `undefined`。改为照提案侧的做法先用 `renderMermaid`（`src/chat/lib/mermaidRender.ts`）把正文里的 mermaid 块预渲染成 SVG，再传进去。**顺手把那两行过时注释改掉**——留着它会让下一个人以为这是设计决定而不是待办。

- [ ] **Step 2: 补 docx 嵌图**

复用 `proposalDocx.ts` 的 `imageParagraphs`。注意它已有「非可嵌格式降级为文字占位」的逻辑，与预览侧共用同一个谓词——不要另写一套降级判断。图片相对路径要按节文件所在目录解析成绝对路径才嵌得进去。

- [ ] **Step 3: 验证并提交**

Run: `bun run typecheck && cd apps/studio && bun test 2>&1 | tail -5`

**人工走查**：一篇带 1 张图 + 1 个 mermaid 块的稿子 → 导出 PDF（图与流程图都在）→ 导出 Word（图嵌进去了）→ 复制公众号 HTML（图与占位框都对）。

```bash
git commit -m "feat(writing): PDF 补 mermaid 预渲染，docx 嵌图"
```

---

## 完成后的验收

- [ ] `bun run typecheck` 通过
- [ ] `cd apps/studio && bun test` **不新增失败**（基线 6 个既存失败）
- [ ] 提案功能行为无变化（Task 3 的纯重构走查）
- [ ] 端到端：写作项目里让 AI 留一个 genimage 指令块 → 自动出图 → 审阅卡 → 应用 → 右栏看得见图 → 三种导出都带图
- [ ] 单文件模式下不发起出图，界面有说明而非静默无反应
- [ ] 重开会话不重复出图（指令块渲染成「点此生成」手动卡）

## 已知残留（本计划不修，记录在案）

- `beginEdit` 在一次写盘在飞的窗口内连点两块会乱序覆盖（P0 期遗留）。配图落位走同一条 `commitSection` 路径，因此不放大问题，但也不修它。
- `references/structures/` 下 17 个骨架示例表仍是 4 列（P1a 终审记录，属技能侧文档，与本计划无关）。
- `image_count` 上限目前只靠写手自觉与手册约定，无自动校验。
