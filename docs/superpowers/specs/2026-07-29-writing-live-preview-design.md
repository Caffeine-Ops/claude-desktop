# 写作实时预览工作区 设计方案

> 给 `skills/writing` 配一个 proposal 同级的右栏工作区：AI 逐节写、右栏逐节亮，
> 选中段落交给 AI 改写，成稿一键导出 Word / PDF / 公众号 HTML。2026-07-29 定稿。

## 目标

用户跑写作技能时，右栏出现一个「文稿工作区」，解决三件事：

1. **看得见** —— AI 写完一节，右栏自动多出一节，不用在聊天流里翻长文。
2. **改得动** —— 在排好版的纸面上选中一段，输入指令交给 AI 改；改动落回磁盘原文件。
3. **发得出** —— 成稿导出 Word / PDF；微信文案额外支持复制公众号内联 HTML。

**覆盖范围**（用户确认）：

| 类别 | 工作流 | 产物形态 |
|---|---|---|
| 主管线三体裁 | 微信文案 / 短篇小说 / 文章 | `<项目>/drafts/*.md` 一节一文件 |
| 优化 / 改写类 | `optimize-existing` → `rewrite` / `polish-only` | `<项目>/drafts/`（2026-07-31 修，见后续设计） |
| 轻量快道 | `workplace-writing`、`de-ai` | **本设计新增**：落单文件 `<cwd>/写作/<标题>.md` |

**明确不做**（第一版）：

- **纸面手动编辑**。纸面只读，一切修改经 AI 改写通道。用户明确选择了这一档：
  少一整套块级 contentEditable + 失焦写盘 + 与 AI 写入抢文件的时序，代价是改错别字
  也要跑一轮 AI。
- **字级流式**（打字机效果）。见「关键取舍 ①」。
- **导出样式弹窗**。四种体裁各一套固定预设；proposal 那个调字体字号的
  `ProposalStyleModal` 不复制过来——现在做等于凭空猜用户想调什么。
- **把 proposal 工作区泛化成通用文档框架**。见「关键取舍 ②」。

## 现状：两套完全不同的正文通路

| | 写方案（proposal） | 写作（writing） |
|---|---|---|
| 正文从哪来 | AI 在聊天消息里输出，用 `===方案正文开始===` 哨兵包住，渲染层抽取累积 | AI 用 Write 工具**直接落磁盘**，一节一个 md，正文不经过聊天消息 |
| 真相源 | 渲染层 zustand store（`stores/proposal.ts` 的 `sections`） | 磁盘文件 |
| 前端界面 | `ProposalDocPanel` 右栏（编辑纸 + PDF 预览 + 导出） | **零**。只有 `/writing` 技能 chip 和场景推荐卡 |
| 导出 | main `markdownToDocxBuffer` 出 docx；PDF = docx-preview 渲 HTML → 主进程 printToPDF | `scripts/export.py`（python-docx / 内联 HTML / 纯文本） |

差异的根子在写作技能的执行纪律：全局纪律 6~8 要求写手**逐节顺序写、每节前重读契约、
禁止脚本批量生成**，且质检脚本（`ai_slop_checker.py` 等）、续写工作流
（`resume-writing.md`）全都以磁盘文件为输入。**磁盘是这个技能事实上的真相源**，
本设计顺着它走，不去改它。

## 架构

### 三条已验证的现成能力，直接复用

1. **目录轮询模式** —— `LivePreviewEditor`（PPT 实时预览）轮询 `svg_output/*.svg`，
   AI 写一张就多一张。写作只是把 `*.svg` 换成 `drafts/*.md`，结构同构。
   仓库明确偏好轮询而非 `fs.watch`（`electron/main/ipc/register.ts` 两处注释：
   「没有跨会话/多窗口的 watcher 生命周期要管」）。
2. **块切分** —— `electron/shared/proposalBlocks.ts` 的 `splitBlocks`/`joinBlocks`
   是纯 markdown 函数（只是名字带 proposal），直接 import，不改一行。
3. **导出引擎** —— `markdownToDocxBuffer`（main）与 docx→HTML→printToPDF 那条链，
   入口是 markdown、出口是字节，与 proposal 的业务无耦合。

### 新增文件

| 文件 | 职责 | 进程 |
|---|---|---|
| `electron/shared/writing.ts` | 类型、改写哨兵常量、`spec_lock.md` 的 genre 解析、`design_spec.md` 的大纲节数解析、节文件排序 + 拼接。**纯函数，零 IO** | 共享 |
| `electron/main/core/writingProject.ts` | 扫描项目 / 读节 / 带乐观锁写回 / 读微信样式 JSON | main |
| `electron/main/ipc/register.ts`（追加） | 6 条新 IPC handler（扫描/读节/写节/微信 HTML/导出 docx/保存 PDF）| main |
| `src/chat/stores/writing.ts` | 当前文档源、各节内容、轮询、改写队列、待审阅改写 | renderer |
| `src/chat/components/workspace/WritingDocPanel.tsx` | 右栏容器：文稿 / 打印预览两 tab + 导出按钮组 | renderer |
| `src/chat/components/workspace/WritingPaper.tsx` | 文稿态：逐块只读渲染 + 体裁皮肤 + 末尾进度骨架 | renderer |
| `src/chat/components/workspace/WritingPreview.tsx` | 打印预览态：A4 走真 PDF，微信走手机宽内联 HTML | renderer |
| `src/chat/components/workspace/WritingSelectionBubble.tsx` | 选区气泡：扩块 → 收指令 → 派发/入队 | renderer |
| `src/chat/lib/sendWritingMessage.ts` | 程序化发一条写作轮消息（会话一致性校验 + dispatchChatTurn）| renderer |
| `src/chat/lib/writingRevision.ts` | 改写的定位、消息组装、落地（源码级精确匹配）| renderer |
| `src/chat/lib/writingSelection.ts` | 选区几何：DOM 选区两端 → 某一节的块区间 | renderer |
| `src/chat/lib/writingGenreStyle.ts` | 体裁 → 导出样式预设与纸面皮肤类串 | renderer |

`WritingDocPanel` 预计超 1500 行时按仓库约定拆同名目录 + index 重导出。

### 数据流

```
① 接管（两条来源，任一命中即接管，project 优先）
   a. 项目模式：AI 跑 project_manager.py init
      → 脚本 stdout 末行打印  WRITING_PROJECT=<绝对路径>
      → 渲染层从该 Bash 工具结果里抓
   b. 单文件模式：AI 写 <cwd>/写作/<标题>.md
      → 渲染层从工具调用参数的 file_path / filePath / path 兜底链判定
        （路径在「写作」目录下且为 .md）。注意判定不限于 Write——任何带这些参数的
        工具都算，所以 AI 只是「读」一下该目录下的 md 也会接管。低危，记为已知问题。

② 轮询（2s）：WRITING_SCAN → 只回文件名 + mtime + size（很轻）
   发现新增 / mtime 变化 → WRITING_READ_SECTIONS 拉全文

③ 渲染：按文件名排序拼成「一节一块」→ WritingPaper 逐块渲染
   末尾挂进度骨架「正在写第 3 节 · 共 6 节」

④ 改写：选中 → 扩块 → 组装消息发给 AI
   AI 忙 → 入队（显示「已排队」），空闲时自动排空
   AI 用 ===改写结果开始/结束=== 哨兵回改后文本
   → 右栏面板底部出「原文 vs 改后」对照卡 [应用][放弃]
   → 点应用 → spliceBlocks 换块 → joinBlocks 重拼整节
   → WRITING_WRITE_SECTION（带 expectedMtimeMs 乐观锁）→ 写回磁盘

⑤ 导出：各节拼成完整 markdown → docx / PDF / 公众号 HTML
```

### IPC 契约

按仓库铁律每条都要齐改。实际是**三处**，不是四处——`ChatApi` 接口就定义在 `ipc-channels.ts` 里，
`preload/index.d.ts` 只是 `chatApi: ChatApi` 的类型转发，不需要改（实施期核实）：
`ipc-channels.ts`（通道常量 + payload/result 类型 + `ChatApi` 签名）→ `preload/index.ts` 暴露 →
main handler（并按仓库约定补 `removeHandler`）。

```ts
// 文档源：项目模式与单文件模式统一成一个判别联合，下游只认这一个类型
export type WritingDocSource =
  | { kind: 'project'; projectDir: string }   // 绝对路径
  | { kind: 'single'; filePath: string }      // 绝对路径，单个 .md

export type WritingGenre = 'wechat' | 'short-story' | 'article' | 'workplace'

// WRITING_SCAN — 'writing:scan'
// 轮询入口。只回元信息，不回正文（正文单独拉，避免每 2s 搬万字）
payload: { source: WritingDocSource }
result:
  | { ok: true
      genre: WritingGenre        // 解析 spec_lock 的 genre；文件缺失或解析不到 → 'workplace' 默认档
      outlineTotal: number | null // design_spec.md 的大纲节数；解析不到为 null
      // 字段名刻意与 READ_SECTIONS 的 `sections` 区分：这里只有元信息、没有正文，
      // 两者同名会让调用方误以为拿到了内容
      files: { name: string; mtimeMs: number; size: number }[] }
  | { ok: false; dirMissing?: true; error: string }

// WRITING_READ_SECTIONS — 'writing:read-sections'
// 批量拉正文。names 为空数组视为「拉全部」
payload: { source: WritingDocSource; names: string[] }
result:
  | { ok: true; sections: { name: string; markdown: string; mtimeMs: number }[] }
  | { ok: false; error: string }

// WRITING_WRITE_SECTION — 'writing:write-section'
// 带乐观锁写回。expectedMtimeMs 与盘上不符即拒写并回传最新内容
payload: { source: WritingDocSource; name: string; markdown: string; expectedMtimeMs: number }
result:
  | { ok: true; mtimeMs: number }
  // current 可为 null：文件被删/改名时 statSync 就失败，读不回内容。UI 要为这条分出
  // 单独文案——说「已刷新到最新内容」是假话，会把用户引进死循环。
  | { ok: false; conflict: true; current: { markdown: string; mtimeMs: number } | null }
  | { ok: false; conflict?: false; error: string }

// WRITING_WECHAT_HTML — 'writing:wechat-html'
// markdown → 公众号内联样式 HTML。样式 JSON 在 skill 目录里，只有 main 能用现成的
// skillsDir() 定位（dev 与打包路径都覆盖）；且【预览与「复制」共用这同一份 HTML 字符串】，
// 两者天然一致，不会出现「预览好看、粘出去变样」。HTML 从 markdown 行结构自己生成、
// 只输出白名单标签且正文转义，不透传原始 HTML。
// styleFallback=true 表示样式 JSON 没读到、用了内置兜底，UI 据此角标提示——降级要看得见。
payload: { markdown: string; styleName: 'wechat-default' | 'wechat-serif' }
result: { ok: true; html: string; styleFallback: boolean } | { ok: false; error: string }

// WRITING_EXPORT_DOCX / WRITING_EXPORT_PDF — 'writing:export-docx' / 'writing:export-pdf'
// 拆两条而非合一：docx 由 main 从 markdown 生成，PDF 的字节由渲染层经 printToPDF 出、
// main 只管保存框与写盘。生成方不同，塞进一条通道会让 payload 出现互斥字段。
payload(docx): { markdown: string; style: ProposalStyleConfig; defaultBaseName: string }
payload(pdf):  { bytes: Uint8Array; defaultBaseName: string }
result（两者共用）: { path: string | null }   // null = 用户取消保存框，不是错误
```

> **为什么不直接复用 `PROPOSAL_EXPORT`**：通道名带业务语义，写作复用它会让日志与
> 权限提示显示「方案导出」，误导排查。新增薄壳通道、内部共用同一个 core 函数，
> 名实一致且零重复实现。

## 界面形态

### 两个 tab

- **「文稿」（默认）** —— 排好版的只读纸面，逐块渲染（块 = 一个标题 / 段落 /
  列表 / 表格 / 围栏代码）。选区改写在这里发生。
- **「打印预览」** —— 最终发布形态。A4 类走真 PDF（与导出物逐字节同源）；
  微信走手机宽内联 HTML。

**为什么编辑放在「文稿」而不是「打印预览」**：预览是渲染成 PDF 塞进 `<iframe>` 的，
那是只读的 Chromium PDF 阅读器，既选不中也改不了；且内容一变就要重生成 PDF，
iframe 滚动位置跳回第一页——AI 每写完一节跳一次，长篇不可用。文稿态是普通 DOM，
追加内容时滚动位置天然保持。

### 按体裁切排版

| genre | 判定 | 皮肤 |
|---|---|---|
| `wechat` | `spec_lock.md` 的 `- genre: wechat` | 375px 手机宽；样式**运行时读 `templates/export_styles/*.json`** |
| `short-story` | `- genre: short-story` | A4；正文首行缩进 2 字符，段间距紧 |
| `article` | `- genre: article` | A4；小标题分明，段间距松 |
| `workplace` | **默认档**：无 `spec_lock.md` 或解析不到 genre | A4；标题黑体、无首行缩进、行距 1.5 |

> 默认档不只覆盖单文件模式：职场快道的**长稿**会 `project_manager.py init` 建项目，
> 但快道刻意不建 `spec_lock.md`（不走八项确认）。这类项目也落进默认档。

微信样式**不在前端复刻**，而是由 main 读 skill 里那两个 JSON、直接生成内联 HTML 回给
渲染层——单一真相源，且预览与「复制公众号 HTML」拿到的是同一份字符串。仓库有过
「两处各写一份 token、静默失效零报错」的事故（2026-07-03 `--accent` 三元组被覆盖），
同类错误不再犯。

### 进度骨架

节级实时的代价是「写一节的几十秒里页面不动」。纸面末尾挂一条骨架：
**「正在写第 3 节 · 共 6 节」**（总数取自 `design_spec.md` 大纲；解析不到就只显示
「正在写下一节…」，不猜数字）。同款模式已有先例：PPT 预览的「N/M 张已就绪」胶囊。

### 与其他右栏的互斥

`ThreadView` 现有 `isSplitMode = isProposalMode || isSlidesMode`。写作加入为第三个：
`isSplitMode = isProposalMode || isSlidesMode || isWritingMode`，优先级
**proposal > slides > writing**（proposal 由 slash 显式激活，意图最强）。
workflow 脚本面板与表格预览在分栏时同样让位，沿用现有规则。

## 选区改写

### 流程

```
选中文字（纸面 DOM）
  → 两端向上找最近 [data-block-index]，取块区间（选半句 → 扩到那整段）
  → 尾部浮出气泡，收指令
  → 组装消息：本节全文 + 选中块原文 + 用户指令 + 哨兵格式要求
  → AI 忙？入队 : 直接派发
  → AI 回 ===改写结果开始=== … ===改写结果结束===
  → 抽取干净正文 → 挂到该轮助手消息下渲染「原文 vs 改后」对照卡
  → [应用] spliceBlocks 换块 → joinBlocks → 乐观锁写回磁盘
    [放弃] 丢弃，不碰文件
    （第一版不做「继续改」：放弃后重新选中再改一次即可，省掉一条要维护的多轮状态）
```

### 为什么按块替换而不是精确字符区间

屏幕上选的是**渲染后的纯文本**，文件里是 **markdown 源码**（含 `**加粗**`、`- `
列表符号、行尾硬换行）。两者字符位置不对应，硬映射极易错位。proposal 踩过这个坑，
最终定的就是按块替换（`proposalBlocks.ts` 头注释：「按块替换鲁棒得多」）。
用户选半句、实际改一整段，是刻意的。

### 排队是必需的，不是优化

proposal 的改写有条硬闸：**streaming 时拒绝新改写**（防两轮产出串台，
`sendProposalSectionRevision.ts` 的并发守卫）。但写作是长流水线，AI 绝大部分时间
都在写下一节——照搬这条闸，气泡永远点了没反应。

所以写作**必须带队列**：AI 忙时改写入队（气泡显示「已排队，AI 写完这节就改」），
空闲时按序排空。软上限 10 条，与 proposal 的 `MAX_REVISION_QUEUE` 对齐。

**队列项不存块序号，只存选中原文 + 入队时的块区间当提示**：排队期间前面的改写可能
已落地、块序号会漂；真正执行时用原文在最新内容里重新定位，多处命中才用提示区间
选最近的一处。这套逻辑 proposal 已有（`QueuedRevision` + `resolveRevisionTarget`），
照抄结构。

### 乐观锁

写作有一个 proposal 没有的风险：**磁盘文件同时被两边写**。用户改第 5 节的同时，
AI 可能在润色阶段回头重写第 5 节。

解法是乐观锁：读节时记 `mtimeMs`，写回前 main 侧比对，不符即拒写、回传盘上最新内容，
UI 提示「这一节刚被 AI 改过，你的改动未生效」并刷新到最新版。

**宁可让用户重做一次，也不静默覆盖内容。**

## 导出

导出源 = `drafts/` 各节按文件名排序拼成的完整 markdown。**不需要额外的定稿文件**——
纸面看到的与导出的是同一份，天然一致。

| 格式 | 链路 | 落点 |
|---|---|---|
| Word (.docx) | main `markdownToDocxBuffer` 直出字节 | 原生保存对话框，默认 `<项目>/output/` |
| PDF | 渲染层把同一份 docx 渲成自包含 HTML → main 隐藏窗口 printToPDF | 同上 |
| 公众号 HTML（仅 `wechat`） | 读 `export_styles/*.json`，样式全内联 → **写剪贴板** | 剪贴板 |

微信做成「复制」而非「存文件」：公众号的工作流就是粘贴，存成 .html 还得再打开复制。
样式必须全内联，因为公众号编辑器会剥掉 `<style>` 与 class——这条 `export.py` 已注明。

**分页按体裁分叉**：`short-story` 每节起新页（节 = 章节）；`article` / `workplace`
连续排版不分页（节只是小标题段落）；`wechat` 不涉及分页。实现沿用
`buildProposalMarkdown` 在节边界插分页标记的做法。

## skill 侧改动

三处，都小且向后兼容：

1. **`scripts/project_manager.py`** —— `init` 末行追加打印 `WRITING_PROJECT=<绝对路径>`。
   人看只是多一行，前端据此接管。同款手法已有先例：`bin/ensure-python.cmd` 用
   `WRITING_PY=<path>` 把路径传出来。
2. **`workflows/workplace-writing.md` 与 `workflows/de-ai.md`** —— 从「默认不落盘」
   改为「成稿写入 `<当前目录>/写作/<标题>.md`」。**不需要新协议**：前端本来就能看到
   Write 工具的 `file_path`，路径落在「写作」目录下且为 `.md` 即接管。零 Python 依赖，
   快道的轻量优势保住（不建五个子目录、不跑 venv 自举）。
3. **`SKILL.md` 角色协议区** —— 新增「选区改写响应协议」一节：收到带
   `===改写结果开始===` 格式要求的改写请求时，把结果包在哨兵之间，**且不要自己去改
   文件**（落地由前端在用户点「应用」后执行）。

## 错误处理

| 情况 | 处理 |
|---|---|
| 项目目录被删 / 改名 | `WRITING_SCAN` 回 `dirMissing`，右栏退回空态并提示；不崩、不刷屏报错 |
| 读到 AI 正写一半的文件 | 照常渲染（可能少半段），下轮轮询 mtime 变化自动补齐。轮询模式的固有代价，PPT 预览同样如此，可接受 |
| 写回时文件已被 AI 改动 | 乐观锁拦下 + 提示 + 刷新到最新，见上文 |
| AI 回复没带哨兵 | 对照卡不出现，AI 回复在聊天里正常显示，气泡状态复位。不假装成功、不写脏数据 |
| 微信样式 JSON 读不到 | 降级为内置默认样式并在预览角标提示「样式未加载」，预览仍可用 |
| 导出时用户取消保存对话框 | 静默返回（`path: null`），不报错——沿用 `PROPOSAL_EXPORT` 语义 |

## 测试与验证

仓库有 `bun test`（覆盖 `electron/`、`src/chat/lib`、`src/chat/composer`）。
纯逻辑必须带测试，放进这三个目录之一。

**单元测试**（`electron/shared/writing.test.ts`、`src/chat/lib/writingRevision.test.ts`）：

- 节文件排序与拼接：`01-x.md` / `02-x.md` / `10-x.md` 的自然序；非数字前缀退回字典序
- `spec_lock.md` 的 genre 解析：正常值、缺字段、文件不存在（→ `workplace` 默认档）
- `design_spec.md` 大纲节数解析：解析不到回 `null`（不猜数字）
- 选区扩块定位：跨块选区、块内半句选区、选区在最后一块末尾
- 队列重定位：原文单处命中 / 多处命中（用提示区间选最近）/ 零命中（丢弃并提示）
- 乐观锁比对：mtime 一致放行、不一致回 conflict
- 导出 markdown 的分页标记按体裁分叉

**类型检查**：`bun run typecheck`。加 IPC 漏改四处之一会当场报错。

**手动验收**（`bun run dev`）：

1. 让 AI 写一篇短文章 → 右栏自动接管 → 逐节冒出 → 进度骨架显示正确节数
2. 选中一段改写 → 对照卡 → 应用 → **确认磁盘 md 文件真的变了**
3. AI 写作途中发起改写 → 显示「已排队」→ AI 写完自动执行
4. 导出 Word 打开检查；小说体裁确认章节分页
5. 微信文案：确认手机宽预览 + 复制 HTML 粘进公众号编辑器样式不丢
6. 写个周报（职场快道）→ 确认单文件模式也接管
7. 删掉项目目录 → 确认右栏优雅退回空态

## 关键取舍

### ① 节级实时，而非字级流式

字级流式（打字机效果）要求 AI 把正文**先在聊天里吐一遍（带哨兵）、再写进文件**——
同一段内容生成两遍，token 大致翻倍，且两份可能不一致。

选节级：盯磁盘文件，一节写完就冲进预览。不改写作技能任何执行纪律、不多烧 token，
质检脚本 / 续写 / 导出 / 预览看到的永远是同一份文件。代价是写一节的几十秒页面不动，
用进度骨架补偿。

### ② 独立工作区，不泛化 proposal

把 proposal 抽象成通用「文档工作区」听着优雅，但那 5000 行里塞满了竞态修复与踩坑
注释：预览 PDF 的 objectURL 原子替换、改写排队时块序号漂移的重定位、哨兵自描述 kind
（修复重复目录的根因）……去抽象它等于把写作的开发风险与一个已稳定的功能绑在一起，
一旦回归就是两个功能一起坏。

真正值钱的**纯逻辑**（块切分、导出引擎、PDF 打印链）本来就已在 shared 层，是纯函数，
直接 import 即可。等写作这套跑稳、真看清共性了再谈合并，比现在猜着抽象强。

### ③ 磁盘是唯一真相源，前端不留副本

用户应用的改写立刻写回 md 文件。这样质检脚本打分、换窗口续写、导出，看到的永远与
纸面一致——不会出现「预览里改了但 AI 续写时还按旧的接」。代价是每次应用改写都要过
一次 IPC 写盘，可忽略。

### ④ 项目路径靠脚本报数，不靠前端猜

目录名是 `<slug>_<日期>`，slug 规则在 Python 里（中文保留、其余压下划线）。前端要猜
就得把这套规则再实现一遍，两边一旦漂了就找不到目录。改成脚本打印一行绝对路径，
可靠且零歧义。

## 参考

- `docs/superpowers/specs/2026-07-24-writing-skill-design.md` — 写作技能本体设计
- `docs/superpowers/specs/2026-07-10-proposal-selection-scoped-revision-design.md` — 选区改写的先例
- `src/chat/components/chat/LivePreviewEditor.tsx` — 目录轮询式实时预览的先例
- `electron/shared/proposalBlocks.ts` — 块切分纯函数（直接复用）

## 已知问题（2026-07-30 全分支终审记录，未在本轮修复）

### H-2：优化 / 改写类工作流的产物落在 output/，右栏恒空 —— ✅ 已解决（2026-07-31）

> **已由 [`2026-07-31-writing-workspace-coverage-and-editing-design.md`](2026-07-31-writing-workspace-coverage-and-editing-design.md)
> 解决**：采用下面三个方向里的第 2 个（让工作流改落 `drafts/`），另加「轻量快道走单文件」
> 的分界。**一稿多平台（`serialize.md`）仍不覆盖** —— 它产出的是多个平行的平台版本，
> 不是一篇文章的多个小节，需要的是平台切换器而非拼接纸面。下面的三方向记录保留作决策留痕。

设计时把这一类的产物形态写成「同 drafts/」，实际不是：

- `rewrite.md`：「改完落 `<项目>/output/`」
- `optimize-existing.md`：「改动落 `output/`」
- `polish-only.md`：全文没有 `project_manager.py init`，直接触发它根本不建项目、也不落
  `写作/` 单文件，**完全不接管**

而 `writingProject.ts` 只扫 `<projectDir>/drafts`。`init` 会把五个子目录都建好，所以
`drafts/` 存在但恒为空 → 纸面永远停在「还没有正文」，稿子其实写在隔壁 `output/` 里。
`isWritingInProgress` 也因为要求 `${dir}/drafts/` 前缀而恒假，连进度骨架都不出。

**三种可选方向**（需要拍板，各有代价）：

1. **让 scan 同时看 `output/`** —— 前端改动最小。代价：`output/` 里还有各平台导出物
   （.html/.docx/.txt），要按扩展名过滤；且「原稿」与「改后稿」可能同时存在，纸面显示哪份？
2. **让这三条工作流改落 `drafts/`** —— 概念上更统一（drafts = 正在打磨的正文）。
   代价：改 skill 文档，且与「output/ = 定稿与导出」的既有语义冲突。
3. **第一版就不覆盖这一类** —— 把覆盖范围表改对，等有人真的需要再说。

### 其余带着上线的已知问题

完整清单与裁决理由见 `.superpowers/sdd/2026-07-29-writing-live-preview/progress.md`
的 deferred 记录。较值得关注的三条：

- **对照卡的「原文」与纸面正文可能不一致**：对照卡生成于 M0，轮询会把纸面刷成 M1，
  两者不一致时没有任何解释。数据是安全的（点应用会正确冲突并刷新），但用户点之前会懵。
  已定方案：比对 `baseMtimeMs` 与现读 `sec.mtimeMs`，不等就在卡上加横幅。
- **`ambiguous` 警示条给不出可操作的线索**：多处命中意味着那几处逐字节完全相同，
  卡上「原文」栏与用户所选一模一样，他无从判断机器挑的是第几处。低成本改进：
  `relocateTarget` 已有 `hits` 数组，回传 `hitCount` 与选中序号，文案写成
  「本节有 3 处相同内容，已选第 2 处」。
- **改写轮与 messageId 无关联**：该会话任何一轮结束都会消费 `pendingRevision`。
  可达性被起飞判定的身份闸压得很低，真修要改数据结构，收益不抵风险。
