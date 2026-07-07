# 知识库托管仓库(P2 管理页)移植到 studio 新线 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前分支 `feat/kb-managed-repo-p2`(app 在 `apps/desktop/`)上的"知识库托管仓库/管理页(P2)"功能,完整移植到团队最新的 `origin/main`(app 已重构为 `apps/studio/`)之上,让这套功能长在最新代码上、可合并回主线。

**Architecture:** 这不是 merge——两条历史线只有古老共同祖先(`fb4238f4`),`origin/main` 被 force-push 重写并把 `apps/desktop` 整体重构为 `apps/studio`(目录结构也从 `src/main`+`src/renderer/src`+`src/shared` 变为 `electron/main`+`src/chat`+`electron/shared`)。团队新线已经吸收了 KB 的 P1 部分(语义检索 kbSemanticSearch、远程同步 kbSync*、资产协议 kbAssetProtocol、设置页 KnowledgeBaseSection 的 local/remote 版本),但**完全没有** P2 的托管仓库/管理页(kbAdminService/kbStore/kbTooling/kbBuildRunner/kbBuild、~17 条 admin IPC、KbManagerView 及其子组件、stores/kb.ts)。因此做法是**以 origin/main 为基新建分支,把 P2 独有的这一层按目录映射表搬进去、对齐已变化的接口、升级设置页组件**,全程以 `bun run typecheck` + 相关 `bun test` 兜底。

**Tech Stack:** Electron(main/preload/renderer 三进程)、React 19 + Vite + Tailwind + zustand、TypeScript composite(tsconfig.node + tsconfig.web)、包管理器 **bun**。

## Global Constraints

- 包管理器是 **bun**,不是 npm。所有命令用 `bun run ...` / `bun test ...`。
- **唯一自动化质量门是 `bun run typecheck`**(= `tsc -p tsconfig.node.json` + `tsc -p tsconfig.web.json`)。凡 P2 带来的 `.test.ts` 文件一并移植,并用 `bun test <file>` 跑绿作为额外验证。
- **目录映射表(旧 → 新),所有搬运一律照此换路径**:
  | 旧(apps/desktop) | 新(apps/studio) |
  |---|---|
  | `src/main/core/` | `electron/main/core/` |
  | `src/main/services/` | `electron/main/services/` |
  | `src/main/workers/` | `electron/main/workers/` |
  | `src/shared/` | `electron/shared/` |
  | `src/renderer/src/components/` | `src/chat/components/` |
  | `src/renderer/src/stores/` | `src/chat/stores/` |
  | `src/renderer/src/lib/` | `src/chat/lib/` |
- **渲染层 import 别名**:studio 渲染层引 shared 用 `@desktop-shared/*` 别名(指向 `apps/studio/electron/shared`)。移植渲染层文件时,把 HEAD 里的相对路径 `../../../shared/xxx` 改成 `@desktop-shared/xxx`。main 进程内部仍用相对路径(如 `../../shared/xxx`、`../core/xxx`)。
- **加一条 IPC 在 studio 要改三处**(比旧仓库少一处——studio 的 `preload/index.d.ts` 不含逐方法类型):① `electron/shared/ipc-channels.ts`(通道常量 **+** `ChatApi` interface 方法声明 **+** Payload/Result 类型,三者都在这一个文件)→ ② `electron/preload/index.ts`(实现)→ ③ `electron/main/ipc/register.ts`(`removeHandler` 清理 + `ipcMain.handle`)。**不要**动 `preload/index.d.ts`。
- **KB handler 全是 engine-free / 全局**(只碰 app 级 userData,不解析 per-tab ChatEngine)。移植的 handler 直接调 core 模块导出函数,**不要**经 `resolveEngine`。
- **P2 硬不变量(必须随代码带过去,别在移植中改掉)**:① 任何写操作(导入/删除/移动/分类变更)完成后必须 bump `builtAtMs`,否则语义检索会读到已删文档的"幽灵向量行";② 分类 prefix 操作必须过 `isSafeRelPath` 路径穿越守卫。
- **privileged scheme 声明位置**:`kbasset://` 的 `registerSchemesAsPrivileged` 声明在 `electron/main/index.ts` 模块顶层(`app.whenReady()` 之前),origin/main 已有,无需重复添加。

---

### Task 0: 建工作分支 + 落地计划文件

**Files:**
- Create(工作分支): `feat/kb-port-to-studio`(基于 `origin/main`)
- Move: 本计划文件随工作区带入新分支

**Interfaces:**
- Produces: 一个基于 `origin/main`、工作区为 `apps/studio` 结构的干净分支,后续所有 Task 在其上进行。

- [ ] **Step 1: 确认工作树干净、计划文件未提交**

Run: `git status`
Expected: 工作树 clean(本计划文件为 untracked,会随 checkout 保留)。

- [ ] **Step 2: 基于 origin/main 建工作分支**

```bash
git checkout -b feat/kb-port-to-studio origin/main
```
Expected: 切到新分支,工作区变为 `apps/studio` 结构;本计划文件(untracked)仍在 `docs/superpowers/plans/` 下。

- [ ] **Step 3: 装依赖并确认基线 typecheck 通过**

```bash
bun install
bun run typecheck
```
Expected: typecheck 全绿(这是移植前的"零点基线",证明 origin/main 本身是干净的;后续每步都跟这个基线比)。

- [ ] **Step 4: 提交计划文件占位(可选,便于追踪)**

```bash
git add docs/superpowers/plans/2026-07-07-kb-managed-repo-port-to-studio.md
git commit -m "docs(plan): KB 托管仓库 P2 移植到 studio 新线的实施计划"
```

---

### Task 1: shared 底座层(类型契约先行)

先把渲染层、main 层都要 import 的共享类型/常量落到 `electron/shared`,后续所有 Task 才有可依赖的契约。

**Files:**
- Overwrite: `apps/studio/electron/shared/kbConfig.ts` ← HEAD `apps/desktop/src/shared/kbConfig.ts`(HEAD 是 origin 的**严格超集**,已 diff 确认:仅多 `KbMode` 类型 + `KbConfig.mode` 字段 + 注释,可安全整файл覆盖)
- Modify: `apps/studio/electron/shared/kbIndex.ts`(补 3 处 additive:`KbIndexFile.importedAtMs?: number`、`KbIndexFile.sizeBytes?: number`、`KbIndex.version: 2 | 3`)
- Create: `apps/studio/electron/shared/kbAdmin.ts` ← HEAD `apps/desktop/src/shared/kbAdmin.ts`(原样搬,内部无跨目录 import)
- Create: `apps/studio/electron/shared/kbAdmin.test.ts` ← HEAD 对应测试
- Create: `apps/studio/electron/shared/kbBuildStatus.ts` ← HEAD `apps/desktop/src/shared/kbBuildStatus.ts`

**Interfaces:**
- Consumes: 无(最底层)。
- Produces:
  - `kbConfig.ts`: `KbMode = 'managed' | 'remote'`、`KbConfig = { mode: KbMode | null; kbRoot: string | null; remote: KbRemoteConfig | null }`、`parseKbConfig(...)`、`KbRemoteConfig`。
  - `kbIndex.ts`: `KbIndexFile`(新增可选 `importedAtMs?`/`sizeBytes?`)、`KbIndex`(`version: 2 | 3`)、`SemanticHit`、`KB_MODEL_ID`、`VectorMeta`、`VectorStoreMeta`。
  - `kbAdmin.ts`: `KbTree`、`KbToolingStatus`、`KbImportPayload`、`KbDocsListResult`、`KbMovePayload`、`KbCategoryPayload` 等管理页数据类型。
  - `kbBuildStatus.ts`: `KbBuildStatus`。

- [ ] **Step 1: 覆盖 kbConfig.ts**

```bash
git show HEAD:apps/desktop/src/shared/kbConfig.ts > apps/studio/electron/shared/kbConfig.ts
```
再确认 diff 只增不减:
Run: `diff <(git show origin/main:apps/studio/electron/shared/kbConfig.ts) apps/studio/electron/shared/kbConfig.ts`
Expected: 只有 `>` 行(HEAD 新增的 KbMode/mode/注释),无 `<` 行被删。

- [ ] **Step 2: 给 kbIndex.ts 补三处可选字段**

在 `KbIndexFile` interface 内补:
```ts
  /** v3：首次入库时间（epoch ms）。旧 index 无此字段，读取端按「—」降级。 */
  importedAtMs?: number
  /** v3：原件字节数。旧 index 无此字段，读取端按「—」降级。 */
  sizeBytes?: number
```
把 `KbIndex` 的 `version: 2` 改为 `version: 2 | 3`。
> 参考 HEAD 版:`git show HEAD:apps/desktop/src/shared/kbIndex.ts` 逐字段比对,确保只做这三处 additive 改动,不动其余(其余两版一致)。

- [ ] **Step 3: 搬 kbAdmin.ts / kbAdmin.test.ts / kbBuildStatus.ts**

```bash
git show HEAD:apps/desktop/src/shared/kbAdmin.ts        > apps/studio/electron/shared/kbAdmin.ts
git show HEAD:apps/desktop/src/shared/kbAdmin.test.ts   > apps/studio/electron/shared/kbAdmin.test.ts
git show HEAD:apps/desktop/src/shared/kbBuildStatus.ts  > apps/studio/electron/shared/kbBuildStatus.ts
```
检查这三个文件的 import：若有 `from './kbIndex'`/`from './kbConfig'` 等同目录 import,路径不变(同在 electron/shared);若引用了 HEAD 独有的其他 shared 文件,记录待补。

- [ ] **Step 4: typecheck + 测试**

Run: `bun run typecheck`
Expected: 全绿(shared 层无未决 import)。
Run: `bun test apps/studio/electron/shared/kbAdmin.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/studio/electron/shared/kbConfig.ts apps/studio/electron/shared/kbIndex.ts apps/studio/electron/shared/kbAdmin.ts apps/studio/electron/shared/kbAdmin.test.ts apps/studio/electron/shared/kbBuildStatus.ts
git commit -m "feat(kb): 移植 P2 shared 底座——kbAdmin/kbBuildStatus + kbConfig.mode + kbIndex v3 字段"
```

---

### Task 2: main 进程构建/存储栈

把管理页背后的主进程逻辑搬齐:文档存储、工具检查、索引重建(worker + runner)、admin 服务门面。

**Files:**
- Create: `apps/studio/electron/main/core/kbStore.core.ts` ← HEAD `.../kbStore.core.ts`
- Create: `apps/studio/electron/main/core/kbStore.ts` ← HEAD `.../kbStore.ts`
- Create: `apps/studio/electron/main/core/kbTooling.ts` ← HEAD `.../kbTooling.ts`
- Create: `apps/studio/electron/main/core/kbBuild/{scan,convert,embed,build,assets}.ts` ← HEAD 对应 5 文件
- Create: `apps/studio/electron/main/core/kbBuildRunner.ts` ← HEAD `.../kbBuildRunner.ts`
- Create: `apps/studio/electron/main/workers/kbBuildWorker.ts` ← HEAD `.../kbBuildWorker.ts`
- Create: `apps/studio/electron/main/core/kbAdminService.ts` ← HEAD `.../kbAdminService.ts`
- Create: 上述文件对应的 `*.test.ts`(`kbStore.core.test.ts`、`kbStore.test.ts`、`kbTooling.test.ts`、`kbBuild/build.test.ts`、`kbAdminService.test.ts`)
- Merge: `apps/studio/electron/main/core/kbIndexStore.ts`(两版差 11 行,以 HEAD 为准并保留 origin 独有改动——见 Step)
- Reuse-verify(不改): `apps/studio/electron/main/core/kbSemanticSearch.ts`、`apps/studio/electron/main/services/kbAssetProtocol.ts`(两线逐字节相同)

**Interfaces:**
- Consumes: Task 1 的 `kbAdmin`/`kbBuildStatus`/`kbConfig`/`kbIndex` 类型;origin 既有 `kbIndexStore`(`getKbConfig/setKbRoot/readKbIndex/kbOutDir`)、`kbSemanticSearch`、`kbAssetProtocol`。
- Produces(供 Task 3 的 IPC handler 调用,签名以 HEAD 为准,移植时逐一核对):
  - `kbAdminService`: `listDocs()`、`importFiles(payload)`、`deleteDoc(id)`、`moveDoc(payload)`、`retryDoc(id)`、`createCategory(payload)`、`renameCategory(payload)`、`deleteCategory(payload)`、`openDocSource(id)`、`previewDoc(id)`、`migrateFromFolder()` 等。
  - `kbTooling`: `checkKbTooling(): Promise<KbToolingStatus>`。
  - `kbBuildRunner`: `getBuildStatus()`、`onBuildStatus(cb)`/广播机制、触发重建入口。
  - `kbBuild/build`: `buildKbIndex(...)`(被 runner/worker 调用)。

- [ ] **Step 1: 搬运全部 main 侧文件(保持相对 import 不变)**

```bash
# core
for f in kbStore.core kbStore kbTooling kbBuildRunner kbAdminService; do
  git show HEAD:apps/desktop/src/main/core/$f.ts > apps/studio/electron/main/core/$f.ts
done
# core/kbBuild
mkdir -p apps/studio/electron/main/core/kbBuild
for f in scan convert embed build assets; do
  git show HEAD:apps/desktop/src/main/core/kbBuild/$f.ts > apps/studio/electron/main/core/kbBuild/$f.ts
done
# worker
git show HEAD:apps/desktop/src/main/workers/kbBuildWorker.ts > apps/studio/electron/main/workers/kbBuildWorker.ts
# tests
for f in kbStore.core kbStore kbTooling kbAdminService; do
  git show HEAD:apps/desktop/src/main/core/$f.test.ts > apps/studio/electron/main/core/$f.test.ts 2>/dev/null || true
done
git show HEAD:apps/desktop/src/main/core/kbBuild/build.test.ts > apps/studio/electron/main/core/kbBuild/build.test.ts 2>/dev/null || true
```
> 这些文件在 HEAD 里用相对路径互引(`../core/...`、`../../shared/...`),目录映射后**相对关系不变**(core→core、shared 从 `../../shared` 仍是 `../../shared`,因为 `electron/main/core` → `electron/shared` 也是上两级),多数无需改。逐文件核对 import 头。

- [ ] **Step 2: 核对每个搬入文件的 import 头,修不匹配的路径**

Run: `grep -rn "from '" apps/studio/electron/main/core/kb*.ts apps/studio/electron/main/core/kbBuild/*.ts apps/studio/electron/main/workers/kbBuildWorker.ts`
逐条确认引用的目标文件在 studio 下存在。重点:
- 引 `../../shared/kbAdmin` 等 → 确认 Task 1 已建。
- 引 embed worker / 构建产物路径(`kbBuildWorker` 里可能有 `out-electron/...` 或 `__dirname` 相关的 worker fork 路径)→ 与 studio 的 `electron.vite.config.ts` worker 输出约定对齐(参考已有 `embedWorker` 的 fork 方式)。
- kbBuild 里若写死了 `apps/desktop/...` 路径注释或常量 → 改为 studio 对应路径。

- [ ] **Step 3: 合并 kbIndexStore.ts(11 行差异)**

Run: `diff <(git show origin/main:apps/studio/electron/main/core/kbIndexStore.ts) <(git show HEAD:apps/desktop/src/main/core/kbIndexStore.ts)`
以 HEAD 版为基线覆盖,但逐行核对 origin 侧是否有 HEAD 没有的改动(如 origin 后续对 P1 的修补);若有,合并保留。写操作 bump `builtAtMs` 的不变量必须在最终版本里存在。

- [ ] **Step 4: 确认复用文件无需改动**

Run: `diff <(git show HEAD:apps/desktop/src/main/core/kbSemanticSearch.ts) apps/studio/electron/main/core/kbSemanticSearch.ts && diff <(git show HEAD:apps/desktop/src/main/services/kbAssetProtocol.ts) apps/studio/electron/main/services/kbAssetProtocol.ts`
Expected: 无输出(证明 HEAD 依赖的这两个底座与 studio 版一致,kbAdminService 可安全依赖)。

- [ ] **Step 5: typecheck + 测试**

Run: `bun run typecheck`
Expected: node 侧全绿(renderer 侧此时还未接,ChatApi 未补方法不影响 main)。
Run: `bun test apps/studio/electron/main/core/kbStore.test.ts apps/studio/electron/main/core/kbAdminService.test.ts apps/studio/electron/main/core/kbTooling.test.ts apps/studio/electron/main/core/kbBuild/build.test.ts`
Expected: 全 PASS(如个别测试依赖尚未接的 IPC/renderer,记录并在 Task 3 后复跑)。

- [ ] **Step 6: Commit**

```bash
git add apps/studio/electron/main/core/kb* apps/studio/electron/main/core/kbBuild apps/studio/electron/main/workers/kbBuildWorker.ts
git commit -m "feat(kb): 移植 P2 主进程栈——kbAdminService/kbStore/kbTooling/kbBuildRunner/kbBuild/worker"
```

---

### Task 3: IPC 三处对接(~17 条 admin 通道)

把管理页的全部前后台通信管道接上。studio 改三处:ipc-channels、preload/index.ts、register.ts。

**Files:**
- Modify: `apps/studio/electron/shared/ipc-channels.ts`(① `IPC_CHANNELS` 补常量,插在 `KB_ROOT_PICK`(~line 654)之后、`PROPOSAL_EXPORT`(~662)之前;② 补 Payload/Result interface,放在 `KbSemanticSearchResult`(~line 1425)一带;③ `ChatApi` interface 补方法声明,放在 `kbSemanticSearch`(~1985)后)
- Modify: `apps/studio/electron/preload/index.ts`(补对应方法实现)
- Modify: `apps/studio/electron/main/ipc/register.ts`(在 `registerIpcHandlers()` 内:开头 `removeHandler` 区补清理、主体补 `ipcMain.handle`;补 import kbAdminService/kbTooling/kbBuildRunner)

**Interfaces:**
- Consumes: Task 2 的 `kbAdminService`/`kbTooling`/`kbBuildRunner` 导出;Task 1 的 `kbAdmin`/`kbBuildStatus` 类型。
- Produces: `ChatApi` 上新增 15 个方法 + 1 个 push 订阅,供 Task 5/6 渲染层调用:
  `kbDocsList()`、`kbToolingCheck()`、`kbPickImportFiles()`、`kbImport(payload)`、`kbDeleteDoc(id)`、`kbMoveDoc(payload)`、`kbRetryDoc(id)`、`kbCreateCategory(payload)`、`kbRenameCategory(payload)`、`kbDeleteCategory(payload)`、`kbDocOpenSource(id)`、`kbDocPreview(id)`、`kbMigrateFromFolder()`、`kbBuildStatusGet()`、`onKbBuildStatus(cb): () => void`。
- 通道常量(15 request/response + 1 push + 1 get):`KB_DOCS_LIST`、`KB_TOOLING_CHECK`、`KB_IMPORT_PICK`、`KB_IMPORT`、`KB_DOC_DELETE`、`KB_DOC_MOVE`、`KB_DOC_RETRY`、`KB_CATEGORY_CREATE`、`KB_CATEGORY_RENAME`、`KB_CATEGORY_DELETE`、`KB_DOC_OPEN_SOURCE`、`KB_DOC_PREVIEW`、`KB_MIGRATE_FROM_FOLDER`、`KB_BUILD_STATUS_GET`、`KB_BUILD_STATUS`(push)。

- [ ] **Step 1: 补通道常量**

从 HEAD 抄常量定义(值逐字节一致,保证前后端契约不漂):
Run: `git show HEAD:apps/desktop/src/shared/ipc-channels.ts | grep -E "KB_(DOCS_LIST|TOOLING_CHECK|IMPORT|DOC_|CATEGORY_|MIGRATE|BUILD_STATUS)"`
把这 16 行插入 studio ipc-channels.ts 的 `KB_ROOT_PICK` 之后(`KB_SEMANTIC_SEARCH` 已在文件末尾,单独保留)。

- [ ] **Step 2: 补 Payload/Result 类型 + ChatApi 方法声明**

从 HEAD ipc-channels.ts 抄 P2 相关的 interface(`KbImportPayload` 若在 kbAdmin.ts 则 import;IPC 专用的 payload/result 抄过来)与 `ChatApi` 上的 15+1 个方法声明,分别插入 studio ipc-channels.ts 的类型区与 `ChatApi` interface。渲染层引 shared 类型改 `@desktop-shared/*`,但 ipc-channels.ts 内部用相对 `import('./kbAdmin')`。

- [ ] **Step 3: 补 preload 实现**

在 `apps/studio/electron/preload/index.ts` 的 chatApi 对象里,按现有 `kbSemanticSearch`/`onKbSyncStatus` 的写法补 15 个 `invoke` 方法 + `onKbBuildStatus` 的 on/off+unsubscribe 方法。参考 HEAD `apps/desktop/src/preload/index.ts` 的对应实现照搬(仅 import 路径按 studio 调整)。

- [ ] **Step 4: 补 register.ts handler**

在 `registerIpcHandlers()`:
- 顶部 removeHandler 区补 15 行 `ipcMain.removeHandler(IPC_CHANNELS.KB_xxx)`(push 型 `KB_BUILD_STATUS` 不加)。
- import 区补 `import { ... } from '../core/kbAdminService'`、`'../core/kbTooling'`、`'../core/kbBuildRunner'`。
- 主体按 HEAD register 的对应 handler 照搬,全部 engine-free(直接调 service 函数,不经 resolveEngine)。`KB_BUILD_STATUS` 的 push:在 kbBuildRunner 的广播回调里 `webContents.send(IPC_CHANNELS.KB_BUILD_STATUS, status)`(参考 origin 的 `KB_SYNC_STATUS` 广播方式)。
- import 防御式降级、入参校验照 HEAD 保留。

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: 全绿(此时 main+preload+shared 三方 IPC 契约自洽;renderer 尚未用到不报错)。

- [ ] **Step 6: Commit**

```bash
git add apps/studio/electron/shared/ipc-channels.ts apps/studio/electron/preload/index.ts apps/studio/electron/main/ipc/register.ts
git commit -m "feat(kb): 接通 P2 管理页 ~17 条 admin IPC(通道+preload+handler)"
```

---

### Task 4: main 后台初始化(构建进度广播接线)

若 `kbBuildRunner` 需要 app 级单例/进度广播(P2 构建进度条依赖),照 origin 的 `startKbSyncScheduler()` 方式接进 index.ts。

**Files:**
- Modify: `apps/studio/electron/main/index.ts`(`app.whenReady().then(async () => { ... })` 回调内,`startKbSyncScheduler()` 一带 ~line 290)

**Interfaces:**
- Consumes: Task 2 的 kbBuildRunner 初始化/广播接口。
- Produces: 构建状态 push 能到达渲染层。

- [ ] **Step 1: 判断是否需要启动期初始化**

Run: `git show HEAD:apps/desktop/src/main/index.ts | grep -nE "kbBuild|BuildRunner|BuildStatus"`
若 HEAD 在启动期有 kbBuildRunner 初始化(如注册进度广播的 webContents 目标/清理旧状态),照搬到 studio index.ts 的 whenReady 回调、`startKbSyncScheduler()` 之后。若 HEAD 无(runner 纯惰性按需),跳过本 Task。

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 全绿。

- [ ] **Step 3: Commit(若有改动)**

```bash
git add apps/studio/electron/main/index.ts
git commit -m "feat(kb): 主进程启动期接线 kbBuildRunner 构建进度广播"
```

---

### Task 5: 渲染层组件 + store

搬管理页 UI 与其 zustand store,接上 Task 3 暴露的 chatApi 方法。

**Files:**
- Create: `apps/studio/src/chat/components/kb/{KbManagerView,KbDocList,KbToolbar,KbPreviewModal,kbIcons}.tsx` ← HEAD `apps/desktop/src/renderer/src/components/kb/*`
- Create: `apps/studio/src/chat/stores/kb.ts` ← HEAD `apps/desktop/src/renderer/src/stores/kb.ts`
- Reuse-verify(不改): `apps/studio/src/chat/lib/kbAssetUrl.ts`(两线一致)
- Merge: `apps/studio/src/chat/lib/kbProductMatch.ts`(两线不一致,以 HEAD 为准并核对 origin 独有改动)

**Interfaces:**
- Consumes: `window.chatApi` 上 Task 3 暴露的 15+1 方法;Task 1 的 `@desktop-shared/kbAdmin`、`@desktop-shared/kbBuildStatus`、`@desktop-shared/kbIndex` 类型。
- Produces: `useKbStore`(zustand),含 `open`/`tree`/`readOnly`/`total`/`tooling`/`build`/`loading` 状态 + `openManager()`/`closeManager()`/`refresh()`/`subscribeBuild()` 动作;`<KbManagerView />` 顶层组件(`open` 为假时 `return null`)。

- [ ] **Step 1: 搬组件与 store**

```bash
mkdir -p apps/studio/src/chat/components/kb
for f in KbManagerView KbDocList KbToolbar KbPreviewModal kbIcons; do
  git show HEAD:apps/desktop/src/renderer/src/components/kb/$f.tsx > apps/studio/src/chat/components/kb/$f.tsx
done
git show HEAD:apps/desktop/src/renderer/src/stores/kb.ts > apps/studio/src/chat/stores/kb.ts
```

- [ ] **Step 2: 改 import 路径(相对 → 别名;组件内互引核对)**

在搬入的 6 个文件里:
- shared 引用 `../../../shared/kbAdmin` → `@desktop-shared/kbAdmin`(kbBuildStatus/kbIndex 同理)。
- 组件间互引(如 KbManagerView 引 KbDocList/KbToolbar/KbPreviewModal/kbIcons)相对路径不变(同目录)。
- 引 `stores/kb` 的路径按 studio 结构调整(`../../stores/kb`)。
- 若引用了 studio 尚无的公共 UI 组件(如某些 `components/ui/*`),就近替换为 studio 已有等价物或内联(参考 origin 已有 `components/ui/checkbox.tsx`)。
Run: `grep -rn "from '" apps/studio/src/chat/components/kb/ apps/studio/src/chat/stores/kb.ts`
逐条确认目标存在。

- [ ] **Step 3: 核对 lib 文件**

Run: `diff <(git show HEAD:apps/desktop/src/renderer/src/lib/kbAssetUrl.ts) apps/studio/src/chat/lib/kbAssetUrl.ts`
Expected: 无输出(一致,不动)。
Run: `diff <(git show origin/main:apps/studio/src/chat/lib/kbProductMatch.ts) <(git show HEAD:apps/desktop/src/renderer/src/lib/kbProductMatch.ts)`
审差异:以 HEAD 为准覆盖,但若 origin 侧有 P1 修补则合并保留。

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: web 侧全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/studio/src/chat/components/kb apps/studio/src/chat/stores/kb.ts apps/studio/src/chat/lib/kbProductMatch.ts
git commit -m "feat(kb): 移植 P2 管理页组件 + kb store 到 studio 渲染层"
```

---

### Task 6: 设置页升级 + 全屏挂载

给 KnowledgeBaseSection 升级到"托管/远程只读"模型并加管理页入口;在 App.tsx 全屏挂载 KbManagerView。

**Files:**
- Overwrite+改路径: `apps/studio/src/chat/components/settings/KnowledgeBaseSection.tsx` ← HEAD 版(HEAD 已是 managed/remote 模型;依赖的 `kbConfig.mode` 已在 Task 1 补齐)
- Modify: `apps/studio/src/chat/App.tsx`(在 `<SettingsView />` 挂载点旁加 `<KbManagerView />`)

**Interfaces:**
- Consumes: Task 5 的 `useKbStore.openManager()` / `<KbManagerView />`;Task 3 的 chatApi 方法;Task 1 的 `KbConfig.mode`。
- Produces: 设置页"知识库"分类展示托管/远程 + 一个"打开管理页"按钮;管理页作为 `z-40` 全屏 overlay 与 SettingsView 平级挂在 App 根部。

- [ ] **Step 1: 覆盖 KnowledgeBaseSection 并核对**

```bash
git show HEAD:apps/desktop/src/renderer/src/components/settings/KnowledgeBaseSection.tsx > apps/studio/src/chat/components/settings/KnowledgeBaseSection.tsx
```
改 import:
- shared 引用改 `@desktop-shared/*`。
- 复用 studio 的 `Section` 布局助手(已从 `SettingsView.tsx` 导出)与既有 `SyncStatusRow` 等;若 HEAD 版自带这些助手的副本,优先复用 studio 版避免重复。
- i18n key(如 `catKnowledgeBase`/`kbSourceTitle`)确认 studio 的 i18n 表已有,缺失的 key 补进 studio i18n(参考 HEAD 的 key 定义)。
- 入口按钮 handler = `useKbStore.getState().openManager()`,挂在 h1 下方、`<Section>` 之外。

- [ ] **Step 2: App.tsx 挂载 KbManagerView**

在 `apps/studio/src/chat/App.tsx` 找到 `<SettingsView />`(约 line 290),其旁加:
```tsx
<KbManagerView />
```
并在文件顶部 import:`import { KbManagerView } from './components/kb/KbManagerView'`(按实际导出名/路径调整)。

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add apps/studio/src/chat/components/settings/KnowledgeBaseSection.tsx apps/studio/src/chat/App.tsx
git commit -m "feat(kb): 设置页升级托管/远程 + 管理页入口 + App 全屏挂载 KbManagerView"
```

---

### Task 7: 全量验证 + dev 冒烟

**Files:** 无(纯验证)。

- [ ] **Step 1: 全量 typecheck**

Run: `bun run typecheck`
Expected: `tsc -p tsconfig.node.json` 与 `tsc -p tsconfig.web.json` 均 0 error。

- [ ] **Step 2: 跑 KB 相关全部测试**

Run: `bun test apps/studio/electron apps/studio/src 2>&1 | tail -30`(或按项目实际 test glob)
Expected: KB 相关测试全绿;若有非 KB 的既有失败,确认与本次移植无关。

- [ ] **Step 3: dev 冒烟(人工/受控)**

Run: `bun run dev`
逐项确认:① 设置页"知识库"分类能打开、显示托管/远程模型;② 点"打开管理页"→ KbManagerView 全屏出现;③ 文档列表能加载(kbDocsList 通),工具检查状态显示(kbToolingCheck 通);④ 导入一个文件 → 触发重建 → 构建进度条走动(KB_BUILD_STATUS push 通)→ 结束后列表刷新、`builtAtMs` 已 bump;⑤ 分类新建/重命名/删除、文档删除/移动/预览各点一遍无报错;⑥ 关闭管理页回到聊天。
> 无法自动化,靠观察。任一项失败按 systematic-debugging 定位,不跳过。

- [ ] **Step 4: 收尾**

- 更新记忆 `proposal-kb-managed-repository.md`:P2 已移植到 studio 新线(分支 `feat/kb-port-to-studio`),记录目录映射与"底座已在 P1 就位"的前提。
- 按 finishing-a-development-branch 决定合并/PR 方式。

---

## Self-Review

**Spec coverage(对照移植清单):**
- shared 层(kbAdmin/kbBuildStatus/kbConfig.mode/kbIndex v3)→ Task 1 ✅
- main 栈(kbAdminService/kbStore(.core)/kbTooling/kbBuildRunner/kbBuild/*/kbBuildWorker/kbIndexStore 合并)→ Task 2 ✅
- ~17 admin IPC 三处对接 → Task 3 ✅
- 后台广播接线 → Task 4 ✅
- 渲染层组件 + store + lib → Task 5 ✅
- 设置页升级 + 入口 + App 挂载 → Task 6 ✅
- 复用文件(kbSemanticSearch/kbAssetProtocol/kbAssetUrl 两线一致)→ Task 2/5 已核对不改 ✅
- 全量验证 + 冒烟 → Task 7 ✅

**待执行期确认(已在对应 Step 写成 diff/grep 动作,非占位符):** kbIndexStore 11 行合并(T2S3)、kbProductMatch 合并(T5S3)、kbBuildWorker 的 worker fork 路径与 electron.vite.config 对齐(T2S2)、i18n key 补全(T6S1)、组件依赖的公共 UI 就近替换(T5S2)。

**Type consistency:** ChatApi 15+1 方法名(kbDocsList/kbToolingCheck/kbPickImportFiles/kbImport/kbDeleteDoc/kbMoveDoc/kbRetryDoc/kbCreateCategory/kbRenameCategory/kbDeleteCategory/kbDocOpenSource/kbDocPreview/kbMigrateFromFolder/kbBuildStatusGet/onKbBuildStatus)在 Task 3 定义、Task 5/6 消费,前后一致;通道常量名与 HEAD 逐字节一致(T3S1 用 grep 抄原值)。
