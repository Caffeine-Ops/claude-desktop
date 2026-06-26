# 方案草稿落盘持久化 + 多草稿 LRU 设计

日期：2026-06-26
分支：Install-Plan

## 背景与问题

方案草稿（`stores/proposal.ts` 的 `sections` 等）目前是**单草稿、纯内存**：

- 内存里同时只有一份草稿；切到另一个方案会话时 `restoreFromTranscript` 会**整体替换**它。
- 退出 App 后内存清空。AI 正文靠会话 JSONL 里的哨兵块（`shared/proposal.ts` 的 `PROPOSAL_DRAFT_*`）由 `rebuildProposalFromTranscript` 重建，但**用户在纸面上的手动改动**（逐节编辑 / 上移下移 / 删节 / 产品 chip）没进 transcript，会丢。

用户诉求：

1. 打开另一个方案会话后，旧会话的草稿不被替换掉。
2. 退出 App 后草稿（含手动改动）不丢。
3. 为避免无限增长，只保留**最近 10 条**草稿。

## 关键洞察

AI 正文已由 transcript 重建机制免费保证「退出不丢」。真正缺的只有**手动改动的持久化**。因此：

- 内存里**仍只保留 1 份**（前台会话那份）——内存非瓶颈。
- 「多草稿 + 退出不丢」由**磁盘持久层**承载，与 transcript 重建形成「磁盘优先、transcript 兜底」两级。
- LRU 10 是**磁盘上**的上限，不是内存。

## 数据模型与存储

- 目录：`app.getPath('userData')/proposal-drafts/`
- 每会话一个文件：`<sessionId>.json`（sessionId 为 UUID，文件名安全）。
- 文件格式 v1：

```jsonc
{
  "version": 1,
  "sessionId": "string",
  "sections": ProposalSection[],   // 含 id/markdown/kind/truncated
  "products": ProposalProduct[],
  "phase": "cover" | "toc" | "content",
  "updatedAt": number              // epoch ms，写入时戳；LRU 实际用文件 mtime
}
```

- `consumedDraftIds` **不持久化**：messageId 级双触发去重只在单次运行内有意义，resume 不会重放历史 `end` 事件，故载入时置空集即安全。保持文件最小。
- `viewMode` 不持久化：UI 偏好，载入一律回 `edit`。

## IPC（按 CLAUDE.md「加一条 IPC 改四处」）

新增三条通道，集中改：`shared/ipc-channels.ts`（常量+载荷/返回类型）→ `preload/index.ts`（暴露方法）→ `preload/index.d.ts`（类型）→ `main/ipc/register.ts`（handler）。

| 通道 | 载荷 | 返回 | 语义 |
|---|---|---|---|
| `proposal:saveDraft` | 草稿记录（v1 结构） | `{ ok: true }` | 写 `<sessionId>.json` + 跑 LRU 淘汰 |
| `proposal:loadDraft` | `{ sessionId }` | 草稿记录 \| `null` | 读盘；不存在返回 null |
| `proposal:deleteDraft` | `{ sessionId }` | `{ ok: true }` | 删除该会话草稿文件（「清空草稿」用） |

main 侧新增模块 `main/core/proposalDraftStore.ts`：封装 `saveDraft / loadDraft / deleteDraft` 与 LRU 淘汰，文件 I/O 全部在此。register.ts 只做 IPC 绑定。

## 载入优先级（打开 / 切换会话时）

在 `FusionRuntimeProvider.rebuildProposalFromTranscript` 升级为**异步**，优先级：

```
1. 内存里已有该会话草稿（active && sessionId===S && sections 非空）
   → 保留（含未保存手改，比盘上新），仅确保 workspaceOpen=true，return
2. 否则 await loadDraft(S)：
   - 有记录 → restoreFromDisk(record)（手改+产品+phase 全回来，workspaceOpen=true）
   - 无记录 → 从 transcript 重建：
       · 抽到哨兵块 → restoreFromTranscript(...)（仅 AI 正文），订阅器随后写盘建档
       · 抽不到（非方案会话）→ reset() 清空前台 store（旧草稿已在盘上，无损）
```

第 1 步保证「切走再切回不抹手改」；第 2 步保证「退出/跨会话手改回得来」；最后的 `reset()` 是**新增行为**：打开普通会话时清掉前台那份，避免陈旧草稿被「写方案」卡误 `reopen`。

`onSwitchToThread` 的两处 `setSession`（常规路径 + 静默 fork 重绑路径）都改为 `await rebuildProposalFromTranscript(...)`。

## 写盘时机（write-through）

**单一订阅器**：在 `FusionRuntimeProvider` 顶层 `useProposalStore.subscribe(...)`，防抖 ~800ms。条件 `active && sessionId && sections.length > 0` 时 `saveDraft`。优点：不必把 save 散进 `updateSection / removeSection / moveSection / appendSections / setProducts / advancePhase` 每个 action。

**切换会话前 flush**：`onSwitchToThread` 进入时先 flush 待写的防抖任务（同步触发一次 save），防止用户改完立刻切走、最后几笔手改还没落盘就被新会话载入覆盖。

## LRU 保留最近 10

`proposalDraftStore.saveDraft` 写完后：列出 `proposal-drafts/` 下所有 `*.json`，按**文件 mtime** 倒序，保留最新 10 个，其余 `unlink`。

- 用 mtime 而非解析每个文件的 `updatedAt`：省去读全部文件，够用。
- 当前前台那份刚写、mtime 最新，永不被自己淘汰。
- 被淘汰的会话下次打开回退到「transcript 重建」：AI 正文仍在，仅手改丢失（可接受的优雅降级）。

## 「清空草稿」按钮语义升级

`ProposalDocPanel` 的「清空草稿」（二次确认后）：现仅清内存 `start()`；改为**先 `deleteDraft(当前会话)` 再 `start(当前会话)`**。否则删完一刷新草稿又从盘上回来。删盘后订阅器因 sections 空不再写盘。

## Store 改动（`stores/proposal.ts`）

- 新增 action `restoreFromDisk(record)`：`set({ active:true, sessionId, sections, products, seeded:true, phase, consumedDraftIds:new Set(), workspaceOpen:true, viewMode:'edit' })`。
- 现有 `restoreFromTranscript / reopen / leaveMode / start / reset` 保持；其中 `start` 与「清空草稿」配合删盘。
- 不改 store 结构（仍单草稿）。

## 受影响文件清单

| 文件 | 改动 |
|---|---|
| `shared/ipc-channels.ts` | 3 个通道常量 + 载荷/返回类型 |
| `preload/index.ts` | 暴露 `saveProposalDraft / loadProposalDraft / deleteProposalDraft` |
| `preload/index.d.ts` | 对应类型 |
| `main/core/proposalDraftStore.ts` | **新建**：文件 I/O + LRU |
| `main/ipc/register.ts` | 注册 3 个 handler |
| `renderer/stores/proposal.ts` | 加 `restoreFromDisk` |
| `renderer/runtime/FusionRuntimeProvider.tsx` | 异步载入优先级 + 防抖订阅器 + flush-on-switch |
| `renderer/components/workspace/ProposalDocPanel.tsx` | 「清空草稿」并发删盘 |

## 行为决策（已与用户确认）

- **打开方案会话自动展开工作台**（load 后 `workspaceOpen=true`）：点对话即见草稿。副作用：重启时 auto-select 若选中方案会话，启动即进工作台——可接受。
- **LRU 用文件 mtime**。

## 边界与降级

- 磁盘 I/O 失败（saveDraft/loadDraft 抛错）：main handler 捕获并返回 null/ok=false，renderer 降级到 transcript 重建或跳过持久化，**绝不阻塞会话切换**。
- 被 LRU 淘汰的草稿：transcript 兜底，仅手改丢失。
- 非方案会话：不写任何草稿文件。
- 静默 fork 重绑（sessionId 从 id→activeId）：以 activeId 为准载入/写盘；旧 id 的盘文件若存在成为孤儿，由 LRU 最终淘汰（不主动迁移，避免复杂度）。

## 非目标（YAGNI）

- 不做磁盘草稿的列表 UI / 草稿管理器。
- 不做跨设备同步。
- 不持久化 `consumedDraftIds` / `viewMode` / `workspaceOpen`（每会话）。
- 不在 store 里改成多草稿 Map——磁盘即多草稿层。
- 不联动会话删除（删会话时清理其草稿文件可作后续小优化，本次不做）。

## 测试（手动，无单测框架）

1. 会话 A 生成草稿 → 手改某节 → 切到方案会话 B → 切回 A：手改在。
2. A 手改 → 退出 App → 重开 → 点 A：手改在（来自盘）。
3. 连开 12 个方案会话各生成草稿 → 最早 2 个的盘文件被淘汰；重开最早那个：AI 正文在、手改没了。
4. 「清空草稿」确认 → 刷新/重开该会话：草稿不再回来。
5. 打开普通（非方案）会话：不生成草稿文件，前台不残留上一个草稿。
6. `bun run typecheck` 通过。
