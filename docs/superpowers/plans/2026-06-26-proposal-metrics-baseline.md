# 「写方案」M-0 埋点 · 指标定义与基线报告

> 对应 backlog `docs/superpowers/plans/2026-06-26-proposal-optimization-backlog.md` 的 **M-0 · 埋两个核心指标**。
> 北极星：**方案可直接交付率**。M-0 的目的就一句——让 P0~P2 的优先级从「假设驱动」变成「数据驱动」。

---

## 1. 埋点落点

每次**导出成功**（用户真的把文件存盘，非取消），renderer 在 `ProposalDocPanel.handleExport` 里组装一条
`ProposalMetricRecord`（纯函数 `buildProposalMetric`，`shared/proposal.ts`），经 IPC `PROPOSAL_METRIC_LOG`
交给主进程 append 一行 JSON：

```
<userData>/proposal-metrics/metrics.jsonl
```

- **本地、不外传、append-only**。dev userData = `~/Library/Application Support/@claude-desktop/desktop`，
  故 dev 落点 = `~/Library/Application Support/@claude-desktop/desktop/proposal-metrics/metrics.jsonl`。
- 只存**聚合数**，不存任何正文片段——埋点是统计信号，不该把客户方案内容沉到这层。
- 写盘失败静默降级（`ok:false`），绝不阻塞导出。

## 2. 记录字段（ProposalMetricRecord v1）

| 字段 | 含义 |
|------|------|
| `ts` / `sessionId` / `format` | 落点时间戳 / 方案会话 / 导出格式（md\|docx） |
| `sectionCount` | 草稿总节数 |
| `kindCounts` | `{cover,toc,content}` 各阶段段落数 |
| `deliverability.generatedChars` | Σ 各节 **AI 生成原文** 字数（baseline） |
| `deliverability.finalChars` | Σ 各节 **导出时** 字数 |
| `deliverability.netEditedChars` | Σ \|finalLen − baselineLen\|，从生成到交付的净字数变化 |
| `citation.verifiedSections` | 参与统计的 content 节数（有 verification 且非 degraded） |
| `citation.degradedSections` | 校验降级、**排除出分母** 的 content 节数 |
| `citation.unverifiedSections` | 导出时 verification 仍未跑完的 content 节数 |
| `citation.zeroCitationSections` | 已校验但 0 引用（覆盖度红灯）的节数 |
| `citation.totalCitations` | 所有引用条数（同文件跨段多引计多条） |
| `citation.supported` / `unsupported` / `fileNotFound` | 三态计数 |

> `baselineMarkdown` 来源：`appendSections` 时设为 AI 产出原文；`updateSection` 故意不动它。重开会话
> （transcript/disk restore）时无从知晓真原文，退而以重建态 markdown 为基准——此时编辑量从「重开后」算起。
> 与 `verification` 一样**不持久化**（派生信号，沉盘只会与正文漂移）。

## 3. 三个核心率（从字段反算）

- **可交付率代理** ＝ `1 − netEditedChars / generatedChars`（越接近 1 → AI 初稿越接近可直接交付）。
  - 局限：净长度差是**廉价代理**，等长替换记 0、来回改回原样记 0。它答的是「交付前到底改了多少字」，
    不是「改了几次」，也不是编辑距离。够用来分「内容卡」还是「排版卡」，不够用来精算。
- **编造率** ＝ `unsupported / totalCitations`（疑似编造/过度改写）。
- **引错率** ＝ `fileNotFound / totalCitations`（引错文件名 / 镜像读不到）。
- **覆盖度红灯比** ＝ `zeroCitationSections / verifiedSections`。

> 编造率/引错率由 P0-1 已落地的 verification（trigram 重叠，阈值 `TRIGRAM_THRESHOLD=0.5`）**自动产出**，
> 导出这一刻快照。注意 `degraded`/`unverified` 节**不进分母**——绝不把「没校验」误算成「无编造」。

读数据（jq）：

```bash
F=~/"Library/Application Support/@claude-desktop/desktop/proposal-metrics/metrics.jsonl"
# 每条导出的可交付率代理 + 编造率 + 引错率
jq -c '{ts,format,
  deliverable: (1 - (.deliverability.netEditedChars / ([.deliverability.generatedChars,1]|max))),
  fabricate:   (.citation.unsupported   / ([.citation.totalCitations,1]|max)),
  miscite:     (.citation.fileNotFound  / ([.citation.totalCitations,1]|max))}' "$F"
```

## 4. 手工核对基线（待 dev 跑真实方案填入）

自动指标已能持续产出；下面这张表是**人工校准** verification 阈值用的——验收要求覆盖 ≥1 份真实方案。
跑法：dev 里对某产品线生成一份完整方案 → 导出（落一条自动记录）→ 人工逐条核对该方案每句「（据《X》）」
是否真出自原文，与自动 verdict 对照。

| 方案 / 产品线 | content 节数 | 引用条数 | 人工判定编造数 | 自动 unsupported 数 | 人工引错数 | 自动 fileNotFound 数 | 可交付率代理 | 备注 |
|---|---|---|---|---|---|---|---|---|
| _（待填）_ | | | | | | | | |

校准结论（待填）：
- 自动 vs 人工的**假阳/假阴**：阈值 0.5 把多少忠实搬运误判成 unsupported（假阳）、漏判多少编造（假阴）？
- 据此**调 `TRIGRAM_THRESHOLD`**（`main/core/proposalVerify.core.ts`）：假阳多 → 调低；假阴多 → 调高。

## 5. 这两个数怎么反推 backlog 重排（验收第 3 条）

跑出基线后，按数据落到下面分支，决定 P0~P2 谁先做：

- **可交付率代理低、但编造/引错率也低** → 卡在**排版/措辞**而非内容。
  → 把 **P2-1 品牌化导出** 与 **P1-1 段落级轻量编辑** 提前（backlog 诚实提醒里点名的「若卡在排版则 P2-1 应升 P0」就是这条）。
- **编造率 / 引错率高** → 卡在**内容与检索盲区**。
  → **P0-2 内容级召回** 维持高优先；若关键词版召回仍治不住词汇不匹配，再上 embedding 语义召回。
- **zeroCitationSections 占比高** → 整章无来源、AI 在兜底糊。→ 同样指向 **P0-2**（召回没把料喂到）。
- **unverified / degraded 占比高** → 不是质量问题，是**校验链路/索引**问题。→ 先修 P0-1 链路与 KB 索引可用性，否则准确度数本身不可信。

> 诚实提醒（同 backlog）：在跑出真实数据前，上面的排序仍是假设。**先让 M-0 攒几份真实导出记录，再让数据替你定优先级。**
