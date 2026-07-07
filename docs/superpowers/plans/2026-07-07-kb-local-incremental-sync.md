# 知识库·本地文件夹增量同步（「刷新」）实施计划

**目标：** 给知识库管理页加一个「同步本地文件夹」按钮，把托管库(`kb-store`)增量对齐成本地源文件夹的当前状态（增/删/改），点一下即可，快。

**为什么能做成增量：** 建索引(`kbBuild/build.ts`)本身已是增量——读上一版 index，按 mtime→sha1 跳过未变文件。所以「同步」只需负责让 `kb-store` 的**文件集**与本地源一致，剩下的"只重转变了的"由构建自理。

**架构：** 单向 本地源 → 托管库。源文件夹路径持久化在 `kbConfig.kbRoot`（旧字段复用）。同步 = 纯 diff（增/删/改）+ 应用（importDocs/deleteDoc）+ scheduleKbBuild。

**可复用零件：** `scanKb(folder)`（扫源）、`listStoreRelPaths(dirs)`（列库内文件）、`readKbIndex()`（拿每文件 sha1 判变化）、`importDocs(overwrite=true)`、`deleteDoc`、`scheduleKbBuild`、`getKbRoot/setKbRoot`。

---

## Task 1：纯 diff 函数 + 单测

**Files:** Create `electron/main/core/kbLocalSync.core.ts` + `.test.ts`

`planLocalSync(source, storeRelPaths, indexSha1ByRel)` → `{ toCopy, toDelete }`：
- `toCopy` = 源里「库中没有 relPath」或「sha1 与索引记录不一致」的文件（新增+改动）。
- `toDelete` = 库里有、源里没有的 relPath（本地删了 → 库也删）。
纯函数、零 fs 依赖，bun test 直测：空库=全拷、无变化=空计划、删除、改名(=删旧+加新)、内容改。

## Task 2：service `syncFromLocal(deps, folder)`

**Files:** Modify `electron/main/core/kbAdminService.ts`；类型加到 `electron/shared/kbAdmin.ts`（`KbLocalSyncResult{added,updated,deleted}`）

scanKb(folder) → 逐文件算 sha1 → 组 source；listStoreRelPaths + index 组 storeRelPaths/indexSha1ByRel → planLocalSync → 应用（toCopy 按(productLine,product)分组 importDocs(overwrite=true)；toDelete 逐个 deleteDoc）→ 有变更则 deps.schedule() → 返回 {added,updated,deleted}。added=库中原本没有的、updated=其余 toCopy。

## Task 3：IPC 接线（四处同改）+ 源文件夹记忆

**Files:** `electron/shared/ipc-channels.ts`（常量 `KB_SYNC_FROM_LOCAL` + ChatApi 方法 `kbSyncFromLocal`）、`electron/preload/index.ts`、`electron/main/ipc/register.ts`

- register：`KB_SYNC_FROM_LOCAL` handler：`getKbRoot()` 有则用；无则弹文件夹选择框→`setKbRoot`→用；取消返回 null；`setKbMode('managed')`；调 `kbAdmin.syncFromLocal(kbDeps(), folder)`。
- 顺带：`KB_MIGRATE_FROM_FOLDER` handler 在选完文件夹后 `setKbRoot(folder)`——让首次批量导入即确立同步源，之后「刷新」免再选。

## Task 4：前端按钮 + i18n

**Files:** `src/chat/components/kb/KbToolbar.tsx`、`src/chat/i18n.ts`

- KbToolbar 在「导入」旁加「同步本地文件夹」按钮（`!readOnly`，busy/构建中禁用）：调 `kbSyncFromLocal()`→成功 refresh()+alert(新增/更新/删除数)。
- i18n：`kbSyncLocal`='同步本地文件夹'/'Sync from folder'；`kbSyncDone`='同步完成：新增 {a}·更新 {u}·删除 {d}'。

## Task 5：类型检查 + bun test

`bun run typecheck` 全绿；`bun test` kbLocalSync.core 通过。GUI 走查：改本地文件夹（加/删/改名一个文件）→点「同步本地文件夹」→只重处理变化项、树同步更新。
