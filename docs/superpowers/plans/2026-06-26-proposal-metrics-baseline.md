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

## 4. 手工核对基线（首份已跑，2026-06-30）

自动指标已能持续产出；下面这张表是**人工校准** verification 阈值用的——验收要求覆盖 ≥1 份真实方案。
跑法：dev 里对某产品线生成一份完整方案 → 导出（落一条自动记录）→ 人工逐条核对该方案每句「（据《X》）」
是否真出自原文，与自动 verdict 对照。

> ⚠️ **跑基线时发现的阻断性 bug（见下「索引污染」小节）**：当前 app 加载的 `userData/kb-index/index.json`
> 是一次 demo 构建（`kbRoot=/tmp/kb-demo-root`、121 文件）覆盖出来的**脏索引**，所有 `mirrorPath` 指向
> 已被清空的 `/tmp/kb-index-demo/`。真实镜像（112 个 .md + assets）就躺在 `userData/kb-index/` 下、相对路径
> 一致，但索引不指向它们。后果：**app 内校验对每条引用都读不到镜像 → 全判 file-not-found（引错率假性 100%），
> 或埋点里整片 unverified**（已落的 6 条记录正是 `totalCitations:0 / unverifiedSections:9`，校验从没产出过
> verdict）。下面这份基线是把镜像路径**离线重指**到真实 `userData/kb-index` 后复算的（脚本复用仓库真实
> `verifyCitationsCore` + 真实草稿 `6413ae91…`），数字才有意义。**修好索引前，app 内的红/绿徽标与埋点的
> 引用三态都不可信。**

| 方案 / 产品线 | content 节数 | 引用条数 | 人工判定编造数 | 自动 unsupported 数 | 人工引错数 | 自动 fileNotFound 数 | 可交付率代理 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 智能导诊+预问诊系统 / 01AI患者服务 | 9 | 68 | **0** | 2 | **0** | 0（离线重指后）| **1.00** | 导出前未编辑（netEdited=0）；2 条 unsupported 经核对均为假阳 |

**自动 verdict（离线复算，阈值 0.5）**：supported 66 / unsupported 2 / file-not-found 0；overlap 中位数 **0.898**、
均值 0.858、min 0.323、max 1.000。→ 编造率（自动）2.9%、引错率 0%、zeroCitationSections 0。

**逐条人工核对 2 条 unsupported**（两条都**接地、非编造**，属合法归纳/扩写被低 trigram 惩罚 → 假阳）：
- `overlap 0.323`「需求分析 / 患者就诊需求」：源文（导诊建设方案）确有「导诊护士专业水平参差不齐导致患者挂错号」
  「科室选择」，方案**换主体改写**成「患者缺乏医学知识→挂错号、走错科室」。概念有据，是归纳改写非编造。
- `overlap 0.430`「30. 医生预问诊报表」：源文（预问诊建设方案）确有「医生预问诊报表」「查看预问诊报告」
  「使用情况」，方案**基于要点合理扩写**成完整描述段。功能名与关键指标全在原文，非编造。

**校准结论**：
- 阈值 0.5 在这份方案上：**假阳 2/68（2.9%）、假阴 0**（无漏判编造）。两条假阳都是「需求分析/功能扩写」
  这类**合成型段落**——它们本就改写、重组原文，trigram 天然偏低，被误标 unsupported。「功能详述」等
  忠实搬运段全部 0.9+ 顺利 supported。
- **建议：维持 `TRIGRAM_THRESHOLD=0.5`**（`main/core/proposalVerify.core.ts`），不据这 1 份就改常量。理由：
  ① 假阴=0，底线（绝不漏判编造）守住了；② 假阳都是合法改写，而本功能哲学是「宁可误报、不可漏报」，
  让人工瞄一眼合成段是可接受的；③ N=1 太薄，调全局常量需 2~3 份方案数据。若假阳噪音变烦，下一步**降到
  0.4**（清掉「扩写」类 0.43，仍保留「重度换主体改写」类 0.32 的提示），**绝不上调**。

### 4.1 索引污染 bug（跑基线时发现，最高优先修）

**现象**：`userData/kb-index/index.json`（385KB，`files=121`）的 `kbRoot=/tmp/kb-demo-root`、每个 `mirrorPath`
形如 `/tmp/kb-index-demo/01AI患者服务/…`。这批 `/tmp` 镜像已被系统清理（121 个全缺失）。而 `userData/kb-index/`
目录下**真实镜像仍在**（112 个 .md + 112 assets，原 6-23 真索引产物），相对路径与脏索引完全一致。

**根因推断**：某次用 `/tmp/kb-demo-root` 做 demo 跑了一次 `kb:index --out userData/kb-index`，新 `index.json`
把真索引覆盖了，但只覆盖了 `index.json` 本身、没动旁边的真实镜像目录 → 索引与镜像「貌合神离」。

**影响面**：
- **校验链路（P0-1）全废**：`verifyCitations` 读这份索引 → `resolveContent` 去 `/tmp/kb-index-demo` 读 → 全 null
  → 所有引用判 `file-not-found`。app 里所有引用徽标会假性飘红（或埋点 unverified）。
- **内容级召回（P0-2）也受污染**：`proposalRetrieve` 扫的是这份索引限定的镜像，同样指向 `/tmp` → 召回可能为空
  或读不到原文。（已生成的 `6413ae91` 草稿质量高，说明它生成那一刻索引大概率还是好的；污染发生在之后。）

**修复（二选一，按成本）**：
- **最省（2026-06-30 已应用）**：把 `index.json` 里每个 `mirrorPath`/`assets` 的 `/tmp/kb-index-demo` 前缀
  批量重指回 `userData/kb-index`。实测重指后 **119/119 ok 镜像、2006/2006 assets 全部可解析**（demo 镜像本就
  整套搬到了 userData、相对路径一致，无一缺失）；原脏索引已备份为 `index.json.demo-bak-20260630`。校验链路
  即刻复活。**局限**：这份索引只含 **121 文件**，是真实 KB（312 文件/3GB）的**部分/demo 子集**——能用、不全。
- **最稳（覆盖全量时再做）**：用真实 KB 根重建索引（真实根目录与 markitdown 均在位，已确认）：
  `export PATH="$HOME/.local/bin:$PATH"; bun run kb:index -- --kb /Users/kika/Desktop/fusion方案资料/福鑫数科产品线资料库 --out <userData>/kb-index --now <ts>`
  （命令见 [[proposal-writer-feature]] 记忆）。重建后镜像与索引一致、覆盖全 312 文件，召回/校验同时复活。

**第二个 bug：恢复路径不触发校验（已定位 + 已修，2026-06-30）**。已落 6 条埋点是 `unverifiedSections:9 /
totalCitations:0`——脏索引只会让校验判 **file-not-found**（不是 unverified）。`unverified` 意味着 verification
**从没挂回 section**。根因：`triggerProposalCitationVerification` 只在**实时生成路径**（`end` 后 appendSections /
syncSections / reviseSection，FusionRuntimeProvider.tsx 三处）触发；而 `verification` 刻意**不持久化**（派生信号），
于是 `rebuildProposalFromTranscript` 走 `restoreFromDisk` / `restoreFromTranscript` 把旧会话草稿恢复回来时，每节
`verification` 都是 undefined、且**没有任何地方重新校验**。重开 `6413ae91`（盘恢复）→ 9 个 content 节全 undefined →
导出 → 埋点 `unverified:9 / total:0`，与实测完全吻合。**与索引污染独立**：即便索引干净，重开旧会话导出照样 unverified。
**修复**：在 `rebuildProposalFromTranscript` 的两个恢复出口（disk / transcript）各补一行 `triggerProposalCitationVerification()`
（幂等、异步、失败静默，不阻塞）。typecheck 绿。**待 dev 端到端确认**：重开 `6413ae91` 导出，新埋点应变
`supported:66 / unsupported:2 / total:68`（索引也已修，二者合力）。

**防回归**：demo/测试索引绝不能 `--out` 到真实 `userData/kb-index`；demo 应指向独立 out 目录。可考虑在
`kbIndexStore.readKbIndex` 加一道「`kbRoot` 含 `/tmp/` 或 mirrorPath 首文件不存在 → 警告/拒绝加载」的健全性检查。

## 5. 这两个数怎么反推 backlog 重排（验收第 3 条）

跑出基线后，按数据落到下面分支，决定 P0~P2 谁先做：

- **可交付率代理低、但编造/引错率也低** → 卡在**排版/措辞**而非内容。
  → 把 **P2-1 品牌化导出** 与 **P1-1 段落级轻量编辑** 提前（backlog 诚实提醒里点名的「若卡在排版则 P2-1 应升 P0」就是这条）。
- **编造率 / 引错率高** → 卡在**内容与检索盲区**。
  → **P0-2 内容级召回** 维持高优先；若关键词版召回仍治不住词汇不匹配，再上 embedding 语义召回。
- **zeroCitationSections 占比高** → 整章无来源、AI 在兜底糊。→ 同样指向 **P0-2**（召回没把料喂到）。
- **unverified / degraded 占比高** → 不是质量问题，是**校验链路/索引**问题。→ 先修 P0-1 链路与 KB 索引可用性，否则准确度数本身不可信。

> 诚实提醒（同 backlog）：在跑出真实数据前，上面的排序仍是假设。**先让 M-0 攒几份真实导出记录，再让数据替你定优先级。**

### 5.1 首份基线落到哪条分支（2026-06-30）

这份 `6413ae91` 方案：**编造率真值≈0%、引错率 0%、可交付率代理 1.00**（导出前零编辑）。对照上面分支：

- **不卡内容/检索**：grounding+召回（#1/#2）在这份上做得很好——68 条引用 66 条忠实搬运、2 条假阳，AI 确实
  在拷原文而非空泛编造。→ **P0-2 的 embedding 语义召回暂无数据支撑，可继续往后放。**
- **可交付率代理 1.00 是退化样本**：netEdited=0 只能说明「用户这次没在导出前改」，不等于「不需要改」（也可能
  导出后逃去 Word 改了，本代理测不到）。**单这 1 份不足以判排版 vs 内容**，需要更多份、且最好覆盖「用户确实在
  app 里改过」的会话才有区分度。
- **真正的当务之急不在 backlog 排序，而在修数据管道**：① 索引污染（已修）让此前所有 app 内信号失真；② 疑似
  verify 不回写（4.1 遗留疑点）。**这两个不修，埋点攒再多也是脏数据。** → 下一步：dev 重导一次确认 verdict
  回写 → 再连续攒 3~5 份真实方案（含编辑过的）→ 那时再用 §5 决策树重排 P0~P2。
