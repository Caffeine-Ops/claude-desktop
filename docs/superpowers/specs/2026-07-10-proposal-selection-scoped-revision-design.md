# 选区即改·只改选中范围（不再整块重写）— 设计

日期：2026-07-10
分支：feat/proposal-revision-queue

## 问题

「写方案」编辑态的「选区即改」：用户选中段落里的一句话让 AI 改，结果 AI 把
**选区所在的整块（整段）**都重写了，段落里未选中的文字也被改动。用户只想改自己
高亮的那部分。

已确认（用户复现）：改动范围是「选中所在的整段」，**旁边别的块没动**——即这是
「按块替换」设计的必然结果，不是块区间定位错到相邻块的 bug。

## 根因

替换单位是「块」是刻意设计（`proposalBlocks.ts` 顶注：选区纯文本 ↔ markdown 源码
子串的映射会被内联格式/来源标注/编号打乱，「最脆」，故退而按整块替换）。而
`reviseProposalSectionBlocks`（`sendProposalSectionRevision.ts`）拼给 AI 的指令是
「把下面这一小段按要求改写」——只把 `selectedText` 当「用户特别想改的这句」提示，
并未要求保留选区以外的文字。于是 AI 名正言顺地整段重写。

## 方案（路 A：改提示词，不改机制）

在 2 vs 3 vs 折中里选定「改提示词」而非「真·子串替换」或「更细的句级切块」：
用最小改动、最低风险达成「用户看到的结果=只有选中那句变」。代价是不 100% 铁保证
（靠 AI 遵守「其余原样」），实践中此类保留指令模型遵守度很高；真扛不住再上路 B。

### 改动点

1. **抽纯函数** `buildSelectionRevisionMessage({ instruction, focus, context, kind })`
   （`sendProposalSectionRevision.ts` 导出），把原本内联在 `reviseProposalSectionBlocks`
   的 build 回调里的消息拼装逻辑挪出来，便于单测。返回发给引擎的 message 字符串。

2. **措辞改为「只改选中、其余原样、整段返回」**：
   - `focus` 非空（正常路径）：明确「用户只选中了这段里的一部分：『${focus}』。
     请**只改写这部分选中的文字**，本段里选中范围以外的其它文字**必须一字不动、
     原样保留**」，随后仍要求「把整段完整输出（选中部分已改、其余原样）」。
   - `focus` 为空（防御性兜底，理论上选区气泡不会以空选区发起）：退回原「把这一小段
     按要求改写」的措辞。
   - 硬边界段（严禁写文件/评估/收尾/另起章节）与 `groundingSuffix(kind)` 溯源措辞
     **原样保留**，不因本次改动松口。

3. 机制不动：仍 `splitBlocks` → 取 `[start,end]` context → `pendingRevision.blockRange`
   → end 分流 `spliceBlocks` 整块替换。因 AI 输出的整段里只有选中句变了，splice 回去
   的净效果就是只有那句变。

### 通用性

同一句措辞覆盖两种选择：
- 选了段落里一句 → 「选中范围以外」非空 → 只改那句。
- 选了整段 → 「选中范围以外」为空 → 自然整段改（等价旧行为）。
- 跨多块选区 → 「其余原样」对拼接后的整段 context 整体生效。

无需按「focus 是否整块子集」分程序分支，措辞自适应。

## 不在本次范围

- 审阅卡「继续改」（`continueProposalSectionBlocks`）本就不带 `selectedText` 焦点，
  不改。
- 审阅卡红绿 diff 显示不改——内容真的只有选中句变，diff 自然只标那句。
- 路 B（真子串替换）/ 路 C（句级切块）不做。

## 测试

- **单元测试**（`sendProposalSectionRevision` 侧新增，`bun test`）针对
  `buildSelectionRevisionMessage`：
  - `focus` 非空时：message 含「原样保留」类约束 + 含 `focus` 原文 + 含 `context`。
  - `focus` 为空时：退回「这一小段按要求改写」措辞、不含「原样保留」约束。
  - content 与非 content（封面/目录）节：分别带对应 `groundingSuffix`（标《来源》/
    不标来源）。
- **手动 GUI 走查**：dev/打包跑起来，选段落里一句让 AI 改，肉眼确认只有那句变、
  同段其余文字与旁边块均未动。

## 验收标准

选中段落内一句 → AI 改写后，该句以外的同段文字逐字未变（绝大多数情况），相邻块
不受影响。`bun run typecheck` 通过、新单测通过。
