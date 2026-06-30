# 「写方案」样式模板 · 自定义另存（P2-3）设计

> 对应 backlog `docs/superpowers/plans/2026-06-26-proposal-optimization-backlog.md` 的 **P2-3 · 样式模板可配置 / 自定义**。
> 现状：样式模板功能已能选 3 个内置模板 + 实时预览 + 逐级微调 + 跨会话持久化（单份 active 配置），
> 还做了切模板智能合并（Bug 2）。**缺的是「把微调后的样式另存为可复用的命名模板，与内置共存、可删」**——
> 这份 spec 补完它。

## 目标与非目标

**目标**：用户在样式弹窗里把当前微调后的样式「另存为模板」，得到一张与内置模板并列、可重复选用、可删除的
自定义模板卡；自定义模板跨会话持久化、与现有 active 配置互不干扰；损坏数据安全降级不崩。

**非目标（YAGNI）**：
- 不做模板导入/导出文件、不做跨设备同步。
- 不做模板分类/排序/重命名以外的管理。
- 不做对内置 3 模板的编辑覆盖（内置只读，自定义才可增删）。

## 关键交互决策（已与用户确认）

1. **点内置模板卡 = 智能合并**（保留用户微调，只换未动字段）——已由 `mergeTemplateSwitch` 实现（Bug 2）。
2. **点自定义模板卡 = 整份原样适用**（clone 该保存的完整配置，覆盖当前临时改动）。理由：内置是「起点」适合
   合并，自定义是用户特意存下的「成品」，召回时要的就是那套确切样式。这条非对称是有意为之。
3. **「另存为」同名覆盖**：若已存在同名（去空白后相等）自定义模板，原地覆盖其 config；否则新建。
4. **上限 20，满了拒绝保存并提示**，绝不静默淘汰用户的成品模板（与草稿 LRU 的「可丢」语义不同）。

## 数据模型

### 类型坑：放宽 `templateKey`

当前 `ProposalStyleConfig.templateKey: ProposalTemplateKey`（封闭联合 `'classic'|'business'|'academic'`）。
自定义模板需要任意 id，故：

- `ProposalTemplateKey` 仍是封闭联合，**专门给内置 3 模板**；`PROPOSAL_TEMPLATES` 保持
  `Record<ProposalTemplateKey, ProposalStyleConfig>`（内置引用全程类型安全）。
- 把 `ProposalStyleConfig.templateKey` 字段类型**放宽为 `string`**：内置配置取内置键，自定义配置取自己的
  `id`。
- 抽 `export const BUILTIN_TEMPLATE_KEYS: readonly ProposalTemplateKey[] = ['classic','business','academic']`
  （= 现有 `TEMPLATE_KEYS`，导出复用）供 UI 判定「这是不是内置卡」与 coerce 用。

### 自定义模板集合

```ts
/** 一条用户另存的自定义模板。config.name 即显示名；config.templateKey 恒等于本条 id。 */
export interface ProposalCustomTemplate {
  id: string // 'custom-' + crypto.randomUUID()，renderer 侧生成（shared 不依赖 crypto）
  config: ProposalStyleConfig
}
```

- 不复用 `PROPOSAL_TEMPLATES`（那是内置常量）。自定义集合活在 store + 独立 localStorage。

### 解析器（shared 纯函数）

```ts
/**
 * 按 key 取「该配置所基于的模板」：先查内置 PROPOSAL_TEMPLATES，再查自定义集合，都没有 → null。
 * mergeTemplateSwitch / resetToTemplateDefault 用它定位 merge/reset 的基准；找不到由调用方兜底
 * （merge base 已 `?? 默认模板`，card 高亮则不亮）。纯函数、可单测。
 */
export function resolveTemplateConfig(
  key: string,
  customTemplates: ProposalCustomTemplate[]
): ProposalStyleConfig | null
```

注：`mergeTemplateSwitch` 当前用 `PROPOSAL_TEMPLATES[draft.templateKey]` 作 base。放宽 key 后，对**自定义
base**（用户在某自定义模板上又微调、再切到内置）也要能取到 base。故 `mergeTemplateSwitch` 增一个
`customTemplates` 参数，内部改用 `resolveTemplateConfig`。切到内置仍智能合并；切到自定义不走它（走整份 clone）。

## 持久化

- **新 localStorage 键** `proposal-custom-templates-v1`，独立于现有 active 配置键 `proposal-style-config-v1`。
  老用户零迁移：active 配置照旧，自定义集合首次为空。
- 载入：`JSON.parse` → 数组 → 逐条 `coerceProposalStyle(entry.config)`（复用现成健壮反序列化，缺字段/非法值/
  数值越界全部回退默认）；丢弃结构非法（无 id / config 非对象）的条目；整体解析失败 → 空集合。绝不抛。
- 写入：每次 save/delete 后整体 `JSON.stringify` 落盘；失败静默（隐私模式/配额），内存仍生效。

## Store（`stores/proposalStyle.ts`）

```ts
interface ProposalStyleState {
  config: ProposalStyleConfig // 既有：当前已生效配置
  setConfig: (config: ProposalStyleConfig) => void // 既有
  customTemplates: ProposalCustomTemplate[] // 新增：持久化的自定义模板集合
  /**
   * 把 config 快照存为自定义模板。name 去空白后：与某条同名 → 原地覆盖其 config（id 不变）；
   * 否则新建（id = 'custom-'+randomUUID）。集合满（≥MAX）且为新建 → 返回 {ok:false,reason:'full'}，
   * 不改集合。成功返回 {ok:true,id}。持久化在内部完成。
   */
  saveAsTemplate: (config: ProposalStyleConfig, name: string) => { ok: boolean; id?: string; reason?: 'full' }
  /** 删除自定义模板。不影响 active config（即便正基于它——只是 active 变「脱离」态）。 */
  deleteTemplate: (id: string) => void
}
```

- `MAX_CUSTOM_TEMPLATES = 20`。
- id 生成、name 去空白、同名查找都在 store（renderer，可用 crypto.randomUUID）。
- 空 name → 调用方（modal）兜底成「自定义样式 N」再传入；store 不猜默认名。

## 弹窗 UX（`ProposalStyleModal.tsx`）

### 模板卡区
- 渲染内置 3 卡（保持现状：智能合并 + classic 角标「默认」）+ 自定义 N 卡。
- 自定义卡：`MiniPreview` + 名称 + 右上角删除 ×（点 × 二次确认，避免误删）。点卡体（非 ×）→
  `setDraft(structuredClone(customConfig))`（整份原样适用）。
- 高亮：`draft.templateKey === 卡.key`（内置用内置键、自定义用 id），统一逻辑。

### `MiniPreview` 重构
- 现 `MiniPreview({ tplKey })` 读 `PROPOSAL_TEMPLATES[tplKey]`。改为 `MiniPreview({ config })`，调用方传
  内置或自定义的 config。内置卡传 `PROPOSAL_TEMPLATES[key]`，自定义卡传 `ct.config`。

### 「另存为模板」
- 按钮放「风格名称」输入框旁（与「还原模板默认」并列或同区）。点击：
  - name = `draft.name.trim() || '自定义样式 ' + (customTemplates.length + 1)`；
  - `const r = saveAsTemplate(draft, name)`；
  - `r.ok` → `setDraft((d) => ({ ...d, templateKey: r.id!, name }))`（新/被覆盖的自定义卡随即高亮）；
  - `!r.ok && r.reason==='full'` → 非阻塞提示「自定义模板已达上限 20，请先删除部分」。

### 切到内置时的 merge base
- `selectTemplate(builtinKey)` 改为 `setDraft((d) => mergeTemplateSwitch(d, builtinKey, customTemplates))`——
  传入集合，使「当前基于某自定义模板 → 切到内置」时能正确以该自定义 config 为基准判定用户微调。

## 健壮性 / 边界

- active `config.templateKey` 指向已删除的自定义 id：card 无高亮；`mergeTemplateSwitch` 的
  `resolveTemplateConfig` 返回 null → base 回退默认模板（合并仍可用，不崩）；reset 按钮回退默认模板。
- 自定义集合损坏：逐条 coerce、丢坏留好；全坏 → 空集合，功能退化为「只有内置」，不崩。
- 删除当前正用的自定义模板：已生效 active 配置（纸面样式）不变，仅「脱离」。
- 同名覆盖只在「自定义之间」生效；自定义名与内置名相同不冲突（内置不在集合里）。

## 测试

**纯函数（`bun test`，零新依赖）**：
- `resolveTemplateConfig`：命中内置 / 命中自定义 / 缺失返回 null。
- `mergeTemplateSwitch` 带 customTemplates：自定义 base 上切内置，保留相对自定义 base 的微调。
- 自定义集合反序列化：好/坏混合 → 丢坏留好；全坏 → 空；非数组 → 空。
- （store 的 save 同名覆盖 vs 新建、上限拒绝、delete——store 含 zustand/localStorage，若难纯测则抽出
  纯 reducer `upsertCustomTemplate(list, config, name, max)` / `removeCustomTemplate(list, id)` 到 shared
  单测，store 只做薄包装 + 持久化。优先抽纯函数。）

**typecheck（唯一硬门）**：放宽 `templateKey: string` 后扫所有引用点（`PROPOSAL_TEMPLATES[key]` 处需确保 key
仍是内置键或加守卫；coerce 的 `pick(p.templateKey, …)` 改为「是 string 即保留、否则默认」）。

**手动冒烟（dev）**：另存 → 自定义卡出现并高亮 → 切走再点回 = 原样恢复 → 删除二次确认 → 重启 app 仍在 →
存满 20 拒绝提示 → 同名覆盖 → 导出/预览用自定义样式正确。

## 涉及文件

- `shared/proposalStyle.ts`：放宽 `templateKey`、导出 `BUILTIN_TEMPLATE_KEYS`、`ProposalCustomTemplate`、
  `resolveTemplateConfig`、`mergeTemplateSwitch` 加参、（可选）`upsertCustomTemplate`/`removeCustomTemplate` 纯
  reducer、coerce 的 templateKey 放宽。
- `shared/proposalStyle.test.ts`：上述纯函数测试。
- `stores/proposalStyle.ts`：`customTemplates` + 三个方法 + 新 localStorage 键载入/持久化。
- `components/workspace/ProposalStyleModal.tsx`：自定义卡渲染 + 删除、`MiniPreview` 重构、「另存为」按钮、
  `selectTemplate` 内置/自定义分流、切内置传 customTemplates。

## 自评（spec self-review）

- 占位符：无 TBD/TODO。
- 一致性：templateKey 放宽贯穿 数据模型→解析器→merge→coerce→UI 高亮，一致；自定义=整份适用、内置=合并的
  非对称在「关键交互决策」与「弹窗 UX」两处一致陈述。
- 歧义：①「另存为」同名覆盖范围限定在自定义之间（已明确）；②上限满只挡新建、覆盖不受限（已明确）；
  ③空 name 兜底在 modal 不在 store（已明确）。
- 范围：单一弹窗内的自定义模板增删改查 + 持久化，聚焦，适合单个实现计划。
