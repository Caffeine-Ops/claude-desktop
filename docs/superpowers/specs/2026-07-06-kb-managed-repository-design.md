# 知识库托管仓库与管理页设计（KB Managed Repository & Admin Page）

日期：2026-07-06
状态：已评审（与用户逐项确认过关键决策）
关联：
- `docs/superpowers/specs/2026-06-23-kb-driven-proposal-writer-design.md`（写方案总设计）
- `docs/superpowers/specs/2026-07-03-kb-remote-sync-design.md`（远程同步，已落地）
- `docs/superpowers/plans/2026-06-30-kb-semantic-search-p1.md`（语义检索 P1，Task 6–10 未接线）
- `docs/kb-server-deploy.md`（服务器部署手册，本设计落地后需更新）

---

## 1. 背景与问题

写方案功能的知识库底座已经成型：kbRoot 文件夹 → 命令行脚本构建（markitdown 转镜像 md + BM25/向量产物）→ kbSync 多机只读同步。但**维护知识库完全没有 UI**：

- 增删改文档要在 Finder / SMB 共享盘里手动操作，然后命令行跑 `bun scripts/build-kb-index.ts`；
- 应用内没有任何地方能看到「库里到底有哪些文档」；
- 发布给其他机器靠服务器 cron，主编无法主动控制发布时机。

目标：**知识库对用户呈现为「应用里的一个数据库」**——一个专门的管理页面完成文档的增删改查、索引重建、一键发布；用户不再需要理解目录结构、命令行和服务器。

## 2. 已确认的关键决策（与用户逐项对齐）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 使用场景 | **主编机维护 + 其他机只读**。只有一台「主编机」可写；其他机器走远程同步，管理页对它们是只读浏览。 |
| 2 | 存储归属 | **应用托管仓库**。用户不再维护 kbRoot 文件夹；原件由应用收进自己的数据目录，页面是唯一维护入口。 |
| 3 | 分类体系 | **保持产品线/产品两级**。与现有检索范围、镜像布局零成本对接。 |
| 4 | 发布方式 | **管理页一键发布**。改动先本地生效，攒批后手动发布；页面显示「N 项未发布改动」。 |
| 5 | 转换依赖 | **检测 + 引导安装**。markitdown 缺失时导入按钮置灰并显示安装引导；只有主编机需要装。 |
| 6 | 发布通道 | **服务器加上传 API**。极简 token 鉴权上传服务；启用后服务器 cron 构建停用、SMB source 退役。 |

总体思路取「**文件仓库 + JSON 元数据**」（评审时对比过 SQLite 化与服务器中心化两案）：托管仓库就是一棵目录树，元数据继续用 `index.json`（升 version 3）。理由：现有构建管线、kbSync、AI 对镜像 md 的 Grep/Read 三者全部吃文件形态；文档量千级，JSON 足够；不引 better-sqlite3 原生依赖。「数据库」是产品心智，由管理页 UI 提供，不必真上数据库。

## 3. 数据模型

### 3.1 托管仓库 `userData/kb-store/`

```
kb-store/
  <产品线>/
    <产品>/            # 可选层级——文档也可直接挂在产品线下
      <原始文件名.docx|pptx|pdf|xlsx|xls|docm|txt>
```

- **目录即分类**：与现有 `scan.ts` 的 relPath 推导（第一段=产品线，第二段=产品）完全兼容，构建管线零改动即可扫托管仓库。
- **原件永久留底**：支持「打开原件」「用改进后的转换管线重转」「导出」。
- 事实源唯一：kb-store 只被应用写；不承诺容忍外部改动（用户不该去动它，但即便动了，下次构建的 mtime/sha1 增量机制也能自愈——这是兜底而非契约）。

### 3.2 构建产物 `userData/kb-index/`（现状延续）

镜像 md（`<relPath>.md`）、`assets/`、`index.json`、`vectors.bin` + `vectors-meta.json`。布局不变，kbSync 与 AI 检索不受影响。

### 3.3 `index.json` 升 version 3

`KbIndexFile` 追加管理页所需字段（均为构建时可得，不需要单独的元数据存储）：

- `importedAtMs`（首次入库时间；重转不变，覆盖更新时刷新）
- `sizeBytes`（原件大小）
- 现有 `ok` / `error` 直接承担「转换状态」语义（成功 / 失败可重试）。

`version: 2 → 3` 的读取端（`readKbIndex`、kbSync、检索）按现有防御式解析原则做向后兼容：v2 索引照读，新字段缺失时管理页显示「—」。

### 3.4 kbConfig 模式变更

`kbConfig` 的来源模式从「本地文件夹 / 远程」改为：

- `managed`（主编模式）：可写，管理页全功能；构建/发布在本机。
- `remote`（远程只读）：现状不变，管理页只读浏览。

旧 `kbRoot`（本地文件夹模式）配置**保留读取但废弃**：检测到旧配置时，管理页引导做一次性「从文件夹批量导入」迁移（拷贝进 kb-store，原文件夹不动），迁移完成后旧配置失效。解析仍遵循 `kbConfig.ts` 的「残缺退安全默认、绝不抛」原则。

### 3.5 文档操作语义

| 操作 | 实现 | 是否重转 |
|------|------|----------|
| 导入 | 拷贝原件进 kb-store 对应目录 → 触发增量构建 | 是（仅新文件） |
| 覆盖更新 | 同路径替换原件（sha1 变化） | 是（仅该文件） |
| 重命名 / 移动分类 | mv 原件 + mv 镜像与 assets + 改索引条目 | **否**（sha1 未变，只改路径键） |
| 删除 | 删原件 + 删镜像与 assets + 删索引条目 | 否 |
| 重命名产品线/产品 | 目录级 mv，等价于批量「移动」 | 否 |

「是否重转」只指 markitdown 转换这一步。**任何写操作后都触发一轮增量构建**：转换按 mtime/sha1 全跳过（除新增/覆盖件），但 index.json 重写、向量表按最新分块表重算——保证删除/移动后 vectors.bin 不残留幽灵行（fingerprint 绑 builtAtMs 的对齐不变量不破）。

同名冲突：导入时检测目标路径已存在 → 弹确认，用户选「覆盖（更新版本）」或「改名保留两份」。

## 4. 构建管线搬家（关键重构）

**问题**：`scripts/kb-index/{scan,convert,assets,embed}.ts` 只活在仓库脚本里，打包后的应用没有这些代码，应用内导入无从谈起。

**方案**：把这四个模块提升为 desktop main 可 import 的共享实现（落位 `apps/desktop/src/main/core/kbBuild/`，保持 electron-free、依赖注入、bun 可测的现有风格），`scripts/build-kb-index.ts` 与 `scripts/publish-kb-manifest.ts` 改成薄包装 import 同一实现。**一套管线，桌面端与服务器脚本共用**——服务器侧部署方式不变（过渡期仍可用）。

执行位置与并发：

- 转换（execFile markitdown / soffice）与向量化跑在 **`kbBuildWorker`（utilityProcess）**，复用 embedWorker 的思路（载模型吃内存、转换是长任务，都不该在 main）。绝不允许 `execFileSync` 落在 main——会冻整个应用。
- 导入/删除/移动后**自动触发增量构建**：现有 mtime/sha1 跳过机制天然增量，单文件导入只转一个文件。
- 单飞行锁 + 尾随再跑：构建期间的新改动排队，构建结束后若有排队则再跑一轮；构建与发布互斥（同一把锁）。
- 进度经 IPC 推给管理页（转换中 x/y、向量化中、完成/失败）。

**向量化降级**：embed 依赖 bge 模型（P1 Task 9 的模型打包未落地）。模型不可用时**跳过向量化只建镜像与索引**，不阻塞导入——当前检索热路径本来只用 BM25，向量产物缺失无感；模型就绪后下次构建自动补齐（fingerprint 绑 builtAtMs 的机制不变）。

**markitdown 检测**：管理页加载时 `execFile('markitdown', ['--version'])` 探测；缺失则导入按钮置灰 + 显示一条 `pipx install markitdown`（含 `pipx inject markitdown xlrd`）安装引导。只读机器不检测（用不到）。

## 5. 管理页（专门页面）

### 5.1 入口与形态

- 设置页知识库分区加「打开知识库管理」按钮；管理页是与 `SettingsView` 同级的全屏视图（renderer 内视图切换，不新开窗口）。
- 图标沿用内联 SVG 约定（proposalIcons 风格，不引图标库）；字号遵循既有排版约定（不直接套 text-apple-* 预设）。

### 5.2 布局与能力

```
┌─────────────┬──────────────────────────────────────┐
│ 产品线/产品树 │ 工具栏：导入 ▏搜索 ▏发布（N 项未发布） │
│  (可增删改名) ├──────────────────────────────────────┤
│              │ 文档列表：标题 ▏格式 ▏大小 ▏导入时间   │
│              │          ▏状态徽标(已索引/失败/未发布) │
└─────────────┴──────────────────────────────────────┘
```

- **查**：树 + 列表 + 文件名搜索（前端过滤 index 即可，不新增检索通道）；行内「预览」看镜像 md 文本，「打开原件」走 `shell.openPath`。
- **增**：导入按钮（系统文件选择器，多选）+ 拖拽文件进窗口；批量导入逐个入队，失败不阻塞后续。
- **改**：重命名、移动分类（树上拖拽或右键菜单）、覆盖更新（导入同名时选覆盖）、转换失败可重试。
- **删**：单个/多选删除，确认后原件+镜像+索引一起清；删除属于「未发布改动」，发布后才从其他机器消失。
- **只读模式**（remote 配置的机器）：同一页面渲染为只读浏览——列表来自同步下来的 index.json，隐藏全部写操作，顶部显示「本库由主编机管理」。顺带解决只读用户「看不见库里有什么」的问题。

### 5.3 状态管理

新增 `stores/kb.ts`（zustand）：文档树、构建进度、发布状态、工具检测结果。数据流向遵循现有模式：main 推事件（`onKbBuildStatus` 等）→ store → 组件；不在 renderer 里做任何文件系统假设。

## 6. 一键发布与服务器上传 API

### 6.1 应用侧 `kbPublish`

1. 构建完成后，本地产物（`kb-index/` 全量文件清单 + sha1，复用 `buildKbManifestFiles`）与**服务器现有 manifest** diff → 得出「需上传 / 需删除」两个集合；「N 项未发布改动」徽标即该 diff 的大小（按文档聚合展示，而非按产物文件数）。
2. 发布 = 逐文件上传变更（失败可断点续传，粒度同 kbSync 的逐文件）→ 服务器删除已移除文件 → **最后上传 manifest.json**。保持 kbSync 已依赖的「manifest 垫后」原子性约定：客户端任何时刻拉到的 manifest 引用的文件必然已就位。
3. 发布与构建互斥；发布进行中管理页显示进度，可取消（已传文件留在服务器无害——manifest 未更新前对客户端不可见）。

### 6.2 服务器侧极简上传服务

nginx 旁新增一个百行级 bun 脚本（systemd 常驻），只做四件事：

- `PUT /kb-upload/<kbId>/<path>`：Bearer token 鉴权 → tmp + rename 原子落盘到 `/srv/kb/publish/<kbId>/<path>`；
- `DELETE /kb-upload/<kbId>/<path>`：同鉴权，删文件；
- `GET /kb/<kbId>/manifest.json` 照旧走 nginx 静态（下载面完全不变，只读客户端零改动）；
- 路径穿越防御：解码后必须仍落在发布目录内，否则 400。

token 配置：应用设置页填「服务器地址 + 发布 token」；内网明文 HTTP 起步，TLS/鉴权升级口子与 kbSync 一致（都收口在各自唯一的 fetch 封装点）。

### 6.3 运维切换（必须写进部署手册）

启用主编机发布后：**服务器 cron 构建必须停用**（否则每小时用 SMB 源重建、覆盖主编发布的 manifest），SMB source 目录退役，团队新增资料一律交给主编从管理页导入。`docs/kb-server-deploy.md` 需增补「主编机发布模式」章节与迁移步骤。

## 7. IPC 面（遵循「加一条通道改四处」约定）

新增通道（`ipc-channels.ts` → `preload/index.ts` → `index.d.ts` → main handler）：

| 通道 | 方向 | 用途 |
|------|------|------|
| `kb:docs-list` | invoke | 读文档树/列表（index v3 + 未发布 diff 摘要） |
| `kb:import` | invoke | 弹文件选择器或接收拖拽路径，入队导入 |
| `kb:doc-delete` / `kb:doc-move` / `kb:doc-retry` | invoke | 删除 / 重命名与移动 / 失败重试 |
| `kb:category-create` / `kb:category-rename` / `kb:category-delete` | invoke | 产品线/产品目录管理（删除需目录为空或二次确认级联删） |
| `kb:build-status` | main→renderer | 构建进度推送 |
| `kb:publish` / `kb:publish-status` | invoke / 推送 | 一键发布与进度 |
| `kb:tooling-check` | invoke | markitdown 可用性探测 |
| `kb:doc-open-source` / `kb:doc-preview` | invoke | 打开原件 / 读镜像 md 文本 |

现有 `KB_PATH_*` 通道随「本地文件夹模式」废弃逐步退役（保留到迁移引导下线为止）。

## 8. 错误处理与一致性

- **转换失败**：文档标记 `ok:false` + error 入列表，状态徽标可见、可重试；批量导入中单个失败不中断队列。降级链（markitdown 两档 + soffice 兜底）沿用 `convert.ts` 现状，降级必须出声的三条纪律不变。
- **写序不变量**：`index.json` 在镜像落盘后写；manifest 在产物上传完成后传——任何时刻崩溃/断电不留「目录文件指向不存在内容」的半截状态。
- **并发**：导入队列串行消费；构建单飞行 + 尾随；构建/发布互斥。
- **配置写入**：沿用 `kbIndexStore` 的「读-合并-写」防互相抹除。

## 9. 测试策略

沿用 kbSync 的基建风格：**纯核 electron-free + 依赖注入 + bun test**。

- 纯函数层：导入路径规划（含冲突检测）、重命名/移动的路径改写、发布 diff 计算（上传/删除集合）、index v2→v3 兼容解析、状态徽标推导。
- 上传服务：协议处理（鉴权、路径穿越防御、tmp+rename）纯函数化后单测。
- utilityProcess 通信与 UI 走 typecheck + 手动 GUI 走查（项目无 e2e 基建，不为本期新建）。

## 10. 明确不做（YAGNI）

- 应用内编辑文档**内容**——用 Word/PPT 改完覆盖导入；
- 多知识库切换（kbId 恒 `default`，URL/manifest 协议口子已留）；
- 双向同步 / 多主编冲突解决（单主编是本期前提）；
- 镜像 md 手工修订及其保护机制；
- 上传通道的 TLS/细粒度权限（内网信任边界，升级口子已留）；
- 语义检索接线（P1 Task 6–10 独立推进，本设计仅保证向量产物构建不回退）。

## 11. 交付物清单（供 plan 拆解）

1. 管线搬家：`kbBuild/` 共享模块 + 脚本薄包装化 + `kbBuildWorker`（utilityProcess）；
2. 托管仓库：`kbStore` CRUD 模块 + index v3 + kbConfig 模式迁移；
3. IPC 面：上表全部通道四处同改；
4. 管理页：树/列表/导入/发布 UI + `stores/kb.ts` + 只读模式；
5. 发布：`kbPublish` diff/上传 + 服务器上传服务脚本 + 部署手册增补;
6. 迁移引导：旧 kbRoot 批量导入 + 旧通道退役。
