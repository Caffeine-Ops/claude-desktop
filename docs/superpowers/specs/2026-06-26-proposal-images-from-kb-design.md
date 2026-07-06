# 方案写作·嵌入知识库图片（子项目 B）

日期：2026-06-26
状态：设计已认可，待用户复核 → writing-plans
前序：子项目 A·表格已交付（spec `2026-06-26-proposal-tables-from-kb-design.md`）。

## 背景与目标

「写方案」当前只产文字（A 已让它能产表格）。知识库索引时其实已把每个源文件里的图抽好落盘（`KbIndexFile.assets`，img-N.png），但这些图从没暴露给 AI、也无法进成品。目标：让 AI 在写正文时，从**本节已引用的知识库文件**里挑相关图嵌入，导出 Word 里是真嵌图、app 预览里能显示，且图与文同源可溯源。

这是「图片 + 表格」整体增强的**第二个子项目**，链路最长（跨 main/preload/renderer 三进程）。

## 已拍板的设计决策

1. **图接地（核心纪律）**：一张图能进某节 ⟺ 它属于「本节已 `（据《文件名》）` 引用过的文件」的 `assets[]`。图与文同源，复用引用纪律，绝不挪用别处或编造图。
2. **插入时机**：AI 自动按相关性插图；不确定时走 AskUserQuestion（与 A、与现有提问纪律一致）。
3. **渲染进程图片通道**：新注册 `kbasset://` 自定义协议（照 `appProtocol.ts` 范式），不走 IPC data-uri。
4. **尺寸读取**：新增 `image-size` 依赖（零依赖小库），供 docx 等比缩放用。
5. **SVG**：v1 不嵌 SVG，降级为文字图说；只嵌位图（png/jpg/gif）。
6. **接地失败行为**：标红但**保留**图（并入 `SectionVerification` 三态，与引用校验一致），不静默删。

边界（YAGNI）：
- 不做图片裁剪/压缩/水印/重排版；原图等比缩放嵌入即可。
- 不做用户手动图库挑选面板（已在 brainstorming 否决）。
- 埋点暂不加「配图数/接地率」字段（图说算正常字数，不破坏现有可交付率代理）。
- 封面/目录节不嵌图，仅正文（content）节。

## 现状（已查证）

- **图已抽好**：`scripts/kb-index/assets.ts` + `convert.ts` 把源文档内嵌图抽成 img-N.png，路径进 `KbIndexFile.assets`（绝对路径，位于 `userData/kb-index/assets/<相对源路径>/`）。
- **图没暴露给 AI**：`engine.ts:520 proposalProductScopes()` 构造 `ProposalProductScope.files` 时只摘 `{title, mirrorPath}`（第 537 行），丢了 assets；`proposalPrompt.ts` 的 `renderProductBlock` 因此也列不出图。
- **docx 丢图**：`proposalDocx.ts` 的 `inlineRuns` 无 `image` 分支，markdown 图节点落到 default → 取 children 文本（多半空），图被丢弃。
- **预览无法直接显示本地图**：app 纸面预览 `ProposalPaper` 用 `AssistantMarkdown`（`react-markdown` + remarkGfm + rehypeHighlight）。渲染进程直接 `<img src="/绝对路径">` 会被当相对 URL、加载失败；`file://` 通常被 webSecurity 挡。
- **已有协议范式可照搬**：`apps/desktop/src/main/services/appProtocol.ts` 已注册 `app://`（standard+secure，`protocol.handle` 读盘 + `fileResponse` 的 normalize 路径逃逸防护 + `mimeFor` MIME 表），`index.ts:54 registerSchemesAsPrivileged` 在 ready 前登记 scheme。`kbasset://` 照此新增。
- **校验有现成写法**：`proposalVerify.ts:19 verifyCitations` 已从 `readKbIndex()` 建 `title→mirrorPath`（仅 ok 文件、同名取首个）、按需读镜像。图接地校验照此加 `title→assets`。
- **无 image-size/sharp**：需新增 `image-size`。
- **markdown 图不被 stripDraftHtml 误删**：`![](path)` 非 HTML 标签，`proposal.ts` 的 `stripDraftHtml` 保留它。

## 设计

### 组件 1：暴露图给 AI

文件：`apps/desktop/src/main/core/proposalPrompt.ts`、`apps/desktop/src/main/core/engine.ts`。

- `ProposalProductScope.files` 每项类型从 `{ title: string; mirrorPath: string }` 扩为 `{ title: string; mirrorPath: string; assets: string[] }`。
- `engine.ts` 第 537 行映射改为带上 `assets: f.assets`（`f` 即 `KbIndexFile`，已有 `assets`）。
- `renderProductBlock`：每个文件行下，若 `assets.length>0`，再列其可用图（绝对路径，逐行）。文件多/图多时沿用现有 `MAX_FILES_PER_PRODUCT` 思路截断（图列另设一个小上限，如每文件最多列 12 张，超出标注）。
- `buildProposalAppend` 新增正文规则（阶段三）：「当某段引用了某文件且该文件有配图、且图能直观佐证本段内容时，从**该文件的图清单**里挑相关图，按 `![图说](绝对路径)` 单独成行嵌入，图说简述图意。只能用你在本段已 `（据《…》）` 引用的文件的图，绝不挪用别处的图或编造图路径。图是否要插由你按相关性判断，拿不准走 AskUserQuestion。封面、目录不插图。」

### 组件 2：kbasset:// 协议

文件：`apps/desktop/src/main/index.ts`（registerSchemesAsPrivileged 增一项）、新建 `apps/desktop/src/main/services/kbAssetProtocol.ts`。

- `index.ts`：在 `registerSchemesAsPrivileged([...])` 数组里加 `{ scheme: 'kbasset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }`（与 app scheme 同款权限）。
- 新 handler `registerKbAssetProtocol()`：`app.whenReady()` 后调用一次（在 main 启动序列里、registerAppProtocol 旁边挂上）。
  - URL 形如 `kbasset://kb/<encodeURIComponent(绝对路径)>`。handler 取 `url.pathname` 去前导 `/` 后 `decodeURIComponent` 得绝对路径。
  - **路径逃逸防护**：`normalize` 后必须仍在 `kbOutDir()`（`kbIndexStore.ts` 已导出）之下（末尾补 `sep` 比前缀，照 `fileResponse` 写法）；否则 404。必须是存在的文件。
  - 命中 → `createReadStream` → `Response`，content-type 取自扩展名（复用一份 MIME 表，png/jpg/jpeg/gif/webp/svg）。
- 纯函数析出：把「绝对路径 + kbRootDir → 是否放行 + 规整路径」抽成可单测的纯函数 `resolveKbAssetPath(absPath, kbRoot): string | null`，handler 只做流式包装。

### 组件 3：渲染预览嵌图

文件：`apps/desktop/src/renderer/src/components/chat/AssistantMarkdown.tsx`（`components.img` override）、新建一个小纯函数 `apps/desktop/src/renderer/src/lib/kbAssetUrl.ts`。

- 纯函数 `toKbAssetUrl(src: string): string`：src 命中「KB assets 路径特征」（含路径片段 `/kb-index/assets/`）→ 返回 `kbasset://kb/${encodeURIComponent(src)}`；否则原样返回 src。该特征匹配避免误伤普通 http 图。
- `AssistantMarkdown` 的 `components.img`：用 `toKbAssetUrl(props.src)` 算最终 src 渲染 `<img>`，加 `max-width:100%` 等基本样式；alt 落到 img alt。**不改存储 markdown**——只在渲染时转换，导出仍拿绝对路径。

### 组件 4：docx 嵌图

文件：`apps/desktop/src/main/core/proposalDocx.ts`、`apps/desktop/package.json`（加 `image-size`）。

- markdown 里图多为「独占一行」→ 解析成一个只含 image 节点的 paragraph。在 `blockToDocx` 的 `paragraph` 分支前（或内）识别：若该 paragraph 的 children 仅为 image 节点，逐图产出：
  - 读盘 → `image-size` 取像素宽高 → 等比缩放使宽 ≤ 版心宽（页宽 − 左右页边距，twips 换算）→ 居中 `Paragraph({ children:[ new ImageRun({ data, transformation:{width,height} }) ], alignment: CENTER })`。
  - 紧跟一行居中图说（image 的 alt，小字灰色），无 alt 则省。
  - **降级**：扩展名是 .svg、读盘失败、image-size 抛错、或非位图 → 产出 `[图：<alt 或 路径basename>]` 文字段，绝不抛错中断导出（与本文件「未知节点降级、绝不抛错」契约一致）。
- 内联在文字中的图（少见）：v1 退化为其 alt 文本（现状行为），不强求内联嵌图。
- `case 'table'`（A 的成果）与其它路径不动。

### 组件 5：图接地校验

文件：`apps/desktop/src/shared/proposal.ts`（纯核）、`apps/desktop/src/main/core/proposalVerify.ts`（IO）。

- 纯核 `parseImages(markdown): {alt:string; path:string}[]`：抽所有 `![alt](path)`（正则，注意与已有 `（据…）` 解析共存、不互扰）。
- 纯核 `verifyImagesCore(markdown, citedTitles, titleToAssets)`：对每张图 path，检查它是否属于「本节所引文件 title 的 assets 并集」。返回 `ImageVerdict[]`（`{ path, status: 'grounded' | 'ungrounded' }`）。`citedTitles` 复用 `parseCitations` 得到的本节引用文件集合。
- `SectionVerification` 扩展：加 `imageVerdicts?: ImageVerdict[]`（可选，向后兼容；无图时空/省略）。UI（`ProposalPaper` 的 `renderVerification`）复用三态——有 ungrounded 标红、全 grounded 标绿、降级灰。
- IO 层**扩展现有 `verifyCitations`**（不另起入口，保持单一校验入口）：在已建的 `title→mirrorPath` 之外，从同一份 `readKbIndex()` 再建 `title→assets`，调 `verifyImagesCore`，把 imageVerdicts 并进返回的 `SectionVerification`。降级（索引缺失/异常）时 imageVerdicts 不可信 → 走 degraded，绝不把「没校验」当「无问题」。

### 组件 6：测试（bun test）

1. **协议守卫**：`resolveKbAssetPath` —— kbRoot 内文件放行、`../` 逃逸/kbRoot 外路径返回 null、不存在文件返回 null。
2. **图接地纯核**：图属本节所引文件 assets → grounded；图不在任何所引文件 assets（或本节没引含该图的文件）→ ungrounded；本节无图 → 空。
3. **parseImages**：抽多张图、与 `（据…）` 引用共存不互扰、无图 → []。
4. **docx 嵌图**：① 含一张真实位图（测试 fixture 小 png）的正文 markdown → `markdownToDocxBuffer` 不抛错、非空；② svg 路径 / 不存在路径 → 降级为文字、不抛错。（沿用 A 的冒烟口径：无 zip 库不做 XML 断言。）
5. **toKbAssetUrl**：KB assets 绝对路径 → kbasset:// 编码 URL；普通 http(s) URL / 非 KB 路径 → 原样。
6. **提示词**：`buildProposalAppend` 列出某文件的 assets、含「只用本段所引文件的图」规则。
7. **回归**：无图方案的导出/校验/预览不变；A 的表格测试仍绿。

## 数据流

```
AI 写某章 → 引用《X》→ 若 X 有配图且相关 → 输出 ![图说](X的某assets绝对路径)（哨兵包裹）
  → renderer 累积进 content 节（markdown 含绝对路径，stripDraftHtml 不动它）
  → 预览(AssistantMarkdown.img)：toKbAssetUrl 把绝对路径→kbasset://，<img> 经协议 handler 读盘显示
  → 接地校验：parseImages + verifyImagesCore（图∈本节所引文件assets?）→ grounded/ungrounded 并入三态UI
  → 导出 Word：proposalDocx 识别独占行图 → image-size 量尺寸 → 居中 ImageRun + 图说；svg/坏图→文字降级
  → 导出预览(docx-preview)：随真 docx 出嵌图
```

## 验收标准

- AI 写正文时，能从本节所引知识库文件里挑相关图，以 `![图说](绝对路径)` 嵌入，不挪用别处图。
- app 纸面预览能显示这些本地图（经 kbasset:// 协议）；接地失败的图标红但仍显示。
- 导出 .docx 在 Word/LibreOffice 打开是真嵌图（位图）+ 图说；SVG/坏图降级为文字、导出不崩。
- 图路径逃逸（kbOutDir 外）被协议守卫拦下。
- 无图方案零回归；A 的表格能力与测试不受影响。
- `bun run typecheck` 通过，新增 bun test 全绿。

## 未来（不在本 spec）

- 内联嵌图、图片压缩/裁剪、SVG 嵌入（需位图 fallback）。
- docx 嵌图的完整 `<w:drawing>` XML 断言（待引入 zip 解包能力，与 A 同理）。
- 埋点加「配图数/接地通过率」字段。
