# 知识库·完整保留本地文件夹层级 实施计划

**目标：** 导入/迁移/同步时**不再把第三级+拍平**，库按本地文件夹的**完整层级**存（产品线/产品/第三级/…/文件），管理页的树支持**任意深度**。根治：22 个同名文件被拍平覆盖丢失 + 第三级分类丢失。

**关键约束（不破）：** 索引里每个文件仍保留 `productLine=第一级`、`product=第二级`（scanKb 已如此）。写方案检索/选产品只读索引这两个字段（`proposalScopes`、`listKbProducts`），不碰 KbTree——保留字段=写方案零影响。KbTree 仅管理页消费，可自由改成 n 级。

**波及文件：** kbStore.ts（加全路径导入）、kbAdminService.ts（migrate/sync 用全路径 + 不拍平）、shared/kbAdmin.ts（KbTree 改 n 级 + buildKbTree 重写）、KbManagerView.tsx（sel 改路径、树递归渲染）、stores/kb.ts（类型随动）。

---

## Task 1：库按全路径存（后端不拍平）

**Files:** `electron/main/core/kbStore.ts`、`electron/main/core/kbAdminService.ts`

- kbStore 加 `importAtRelPaths(dirs, items:{srcPath,relPath}[], overwrite)`：直接拷到 `storeDir/<全 relPath>`（mkdir 递归 + copyFileSync；conflict && overwrite → 先 deleteDoc 再拷；conflict && !overwrite → 计入 conflicted）。
- `migrateFromFolder`：改用 scanKb 每条的**完整 relPath** → importAtRelPaths（不再 group by productLine/product 走拍平的 importDocs）。
- `syncFromLocal`：source 的 relPath 用 scanKb **完整 relPath**（删掉 docRelPath 拍平 + seen 去重——全路径天然唯一）；diff 后 toCopy 走 importAtRelPaths、toDelete 走 deleteDoc。
- 拖拽导入（进选中分类）维持 importDocs 拍平不变（临时投放，无源子结构）。

## Task 2：n 级树（纯核 + 单测）

**Files:** `electron/shared/kbAdmin.ts` + 新测 `electron/shared/kbAdmin.test.ts`

- 新类型：`KbFolderNode{ name; path; folders:KbFolderNode[]; docs:KbDocEntry[] }`、`KbTree{ roots:KbFolderNode[] }`（删旧 KbProductLine/KbProduct）。
- 重写 `buildKbTree(docs)`：按每条 relPath split（兼容 `/`、`\`），末段=文件挂到最深文件夹的 docs，途经段建/取文件夹节点；末尾按名/标题递归排序。文件夹可同时有 docs 和子文件夹。
- bun test：三级嵌套、同名不同三级不再合并、直接挂产品线根、排序。

## Task 3：管理页树 UI 适配

**Files:** `src/chat/components/kb/KbManagerView.tsx`、`src/chat/stores/kb.ts`

- `sel: string | null`（选中文件夹的 path）。`docs` = 按 path 在树里找到的节点的 docs（写个 findNode 遍历）。
- `KbTreeNode` 改**递归**：渲染本节点为可选中行（按 depth 缩进 + doc 数徽标），再递归渲染 `node.folders`。
- 空态判断改 `tree.roots.length===0`。

## Task 4：类型检查 + 单测 + 重灌验证

- `bun run typecheck` 全绿；`bun test` buildKbTree 通过。
- 清 kb-store+kb-index → 重新「从本地文件夹迁移」（现在保全深度）→ 重建 → 验证：库文件数=291（不再 269）、树里看得到第三级、写方案选产品仍列得出产品。
