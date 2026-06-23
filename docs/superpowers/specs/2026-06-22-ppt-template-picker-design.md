# PPT 模板选择器 — 设计文档

- 日期:2026-06-22
- 分支:Add-Login(本功能建议另开分支实现)
- 状态:已定设计,待实现
- 作者:kika + Claude

## 1. 背景与目标

桌面端目前生成 PPT 只能靠 `/ppt-master` 斜杠命令 + 纯文字描述,用户没有「挑一个风格直接生成」的入口。本功能在聊天输入框上方加 **3 个 PPT 模板芯片**,用户点选一个模板再输入主题即可生成对应风格 + 结构的 PPT。

### 硬约束(用户明确要求)
- **模板是可选的**:默认不选任何模板;不选时发送行为与今天 100% 一致(零回归)。
- 模板是「视觉风格 + 章节结构」的完整套装,选一个就能直接生成。
- 交互形态:输入框上方的模板芯片(参照现有 `PermissionModePicker` / `skillChipRegistry` 风格)。
- 实现方式:模板定义为独立配置文件(复用 `design-templates/template.json` 字段格式)。

### 已定决策(实现时若要改,只动这两处)
- **初版 3 个模板**:商务深蓝 / 清新极简 / 活力渐变。
- **注入块带 `/ppt-master`**:复用现有 SVG→PPTX Python 出图管道,而非另起一套生成逻辑。

## 2. 方案选型

采用 **方案 A:配置打包进 renderer,发送时在前端注入**。

- 模板 JSON 随构建静态打包进 renderer;芯片读元数据显示,发送时在 `onNew` 拼 prompt。
- **0 处 IPC 改动**,改动集中在 renderer 单层,无主进程/SDK/CLI 风险。
- 桌面 app 本就整包发布,「改模板要重打包」不构成问题。

已否决:
- 方案 B(配置留 main + 扩 IPC 传 templateId):仅当「线上不重打包热替换模板」是硬需求时才值得;当前不是,且要改四处 IPC + 额外一条 IPC 把元数据拉回 renderer 显示,复杂度浪费。
- 方案 C(芯片只是 `/ppt-master` 的 prompt 快捷键):模板内容不在自己手里,与「独立配置文件 + 视觉结构套装」两个选择冲突,可控性最差。

## 3. 关键代码事实(实现前必读)

- **发送入口**:`apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx` 的 `onNew` 回调。它把用户输入拼成 `text`,过登录门后 push 进 store 并调 `chatApi.send`。模板指令的唯一注入点就在这里。
- **现有 payload**:`ChatSendPayload = { sessionId; text; images? }`(`apps/desktop/src/shared/ipc-channels.ts:555`)。本功能**不改它**。
- **芯片挂载点**:`apps/desktop/src/renderer/src/components/chat/ThreadView.tsx:2275`,composer 卡片上方的 strip(`min-h-[30px]`)。当前右侧绝对定位放 `PermissionModePicker`,**左侧空闲**,模板芯片放左侧。
  - ⚠️ 该文件被 `file(1)` 识别为 `data`(含非文本字节),普通 `grep` 会静默跳过,需用 `grep -a`。
- **配置格式参考**:`design-templates/*/template.json`,已有 `slug/name/tagline/mood/palette/typography/scheme/slide_count` 等字段,可直接复用其子集。
- **可参照的现有模式**:
  - `components/permissions/PermissionModePicker.tsx`:非模态选择器 + localStorage 持久化 + 同步。
  - `composer/skillChipRegistry.ts`:声明式芯片注册表(纯数据表,新增一项只加一行)。

## 4. 组件设计

系统拆成 4 个相互独立、接口清晰的单元 + 1 处注入点。

### 4.1 模板配置(数据层)— 新建

目录 `apps/desktop/src/renderer/src/templates/ppt/`:

- `business-deep-blue.json`、`minimal-fresh.json`、`vibrant-gradient.json` — 各一个模板。
- `index.ts` — 类型定义 + 集中注册表,`export const PPT_TEMPLATES: readonly PptTemplate[]`。
- 加第 4 个模板 = 多一个 JSON + `index.ts` 数组里加一行,别处不动。

单个模板 schema(复用 template.json 字段子集 + 补 `chip` 与 `structure`):

```jsonc
{
  "id": "business-deep-blue",          // 稳定标识,store/注入都用它
  "name": "商务深蓝",                   // 芯片显示名
  "tagline": "沉稳深蓝 + 高对比白字,适合融资/汇报",
  "chip": { "icon": "ppt", "swatch": "#1B3A6B" },   // 芯片图标键 + 选中高亮色
  "visual": {                                         // 视觉风格
    "palette": { "ink": "#0B1B33", "paper": "#FFFFFF", "accent": "#1B3A6B" },
    "typography": { "display": "Source Han Serif", "body": "Inter" },
    "scheme": "light"
  },
  "structure": [                                       // 章节骨架(有序)
    "封面(主题 + 副标题)", "背景与问题", "解决方案",
    "市场/数据", "落地计划", "团队", "总结与展望"
  ]
}
```

`chip.icon` 取 `FileTypeIcon` 的 `FileIconKey`(`'ppt'` 已存在)。三个模板的 palette/typography/structure 由实现者按风格定型,structure 各自不同(深蓝商务偏融资汇报、极简偏通用、渐变偏发布会/创意)。

TypeScript 类型 `PptTemplate` 在 `index.ts` 内定义并导出,JSON 以 `import xxx from './business-deep-blue.json'` 静态引入(确认 `tsconfig.web.json` 的 `resolveJsonModule` 已开;若未开则在此打开)。

### 4.2 状态(store 层)— 新建

`apps/desktop/src/renderer/src/stores/pptTemplate.ts`(zustand,参照 PermissionModePicker 的持久化写法):

- `selectedId: string | null` — **默认 `null` = 不使用模板**。
- `select(id: string): void` — 单选可清空语义:
  - 传入 id === 当前 `selectedId` → 置 `null`(反选)。
  - 否则 → 切到该 id。
- 持久化到 `localStorage`(key 例如 `ppt-template-selected`),刷新保留。
- 提供 `getState()` 即时读取(供 `onNew` 非 hook 路径用),与 hook 订阅(供芯片 UI 用)。

接口契约:UI 只调 `select(id)`;`onNew` 只读 `getState().selectedId`。互不知道对方内部。

### 4.3 芯片 UI(视图层)— 新建

`apps/desktop/src/renderer/src/components/chat/PptTemplatePicker.tsx`:

- 渲染 `PPT_TEMPLATES.map(...)` 为 3 个小芯片(pill),复用 composer 现有 pill 视觉语言。
- 选中态:用该模板 `chip.swatch` 做高亮(描边/底色)。未选中为常态。
- 点击调 `usePptTemplateStore().select(id)`(含反选)。
- 悬浮显示 `tagline`(title 属性即可,初版不做自定义 tooltip)。

挂载:`ThreadView.tsx:2275` 那条 strip 内,放在左侧。改法示意(strip 现为右侧绝对定位 picker,新增左侧常规流容器):

```tsx
<div className="relative mb-2 min-h-[30px]">
  {/* 新增:左侧模板芯片 */}
  <div className="absolute left-1 top-0 flex h-[30px] items-center">
    <PptTemplatePicker />
  </div>
  {/* 原有:右侧权限模式选择器(不动) */}
  <div className="pointer-events-none absolute right-1 top-0 flex h-[30px] items-center">
    <div className="pointer-events-auto"><PermissionModePicker /></div>
  </div>
</div>
```

> 注意宽度:左右两侧都绝对定位时需保证窄窗口不重叠;3 个短芯片 + 右侧单个 picker 在 `max-w-3xl` 下空间充足,但实现时在窄窗验证一下。

### 4.4 Prompt 注入(发送链路)— 改一处

只改 `runtime/FusionRuntimeProvider.tsx` 的 `onNew`,位置在算出 `text`、过完登录门 **之后**、push 进 store / 调 `chatApi.send` **之前**。

逻辑:

```ts
const selectedId = usePptTemplateStore.getState().selectedId
let wireText = text                        // 发给 CLI 的文本
if (selectedId) {
  const tpl = PPT_TEMPLATES.find(t => t.id === selectedId)
  if (tpl) wireText = buildPptPrompt(tpl, text)   // 模板指令块 + 用户输入
}
// storeContent(Thread 气泡显示)继续用原始 `text`,不含指令块;
// 仅把 wireText 传给 chatApi.send。
```

关键不变量:
- `selectedId === null` → 完全跳过,`wireText === text`,零回归。
- **显示与发送分离**:用户气泡显示其原始输入(`storeContent` 用 `text`),CLI 收到 `wireText`(指令块 + 主题)。空输入校验(`!text && images.length === 0`)仍基于原 `text`,模板不绕过该校验。

`buildPptPrompt(tpl, userText)` 产出(初版,带 `/ppt-master`):

```
/ppt-master
请按以下风格与结构生成一份 PPT。
风格:商务深蓝。主色 #1B3A6B,背景 #FFFFFF,标题字体 Source Han Serif,正文 Inter,浅色方案。
章节结构:封面 → 背景与问题 → 解决方案 → 市场/数据 → 落地计划 → 团队 → 总结与展望。
主题与内容:<userText>
```

`buildPptPrompt` 可与配置同处(`templates/ppt/index.ts`)或单列 `templates/ppt/prompt.ts`,纯函数,便于单测/调整措辞。

### 4.5 不改动的部分

- IPC 全链路:`ipc-channels.ts` / `preload/index.ts` / `preload/index.d.ts` / `main/ipc/register.ts` / `engine.ts` — **全部不碰**。
- `ChatSendPayload` 结构不变。
- `ppt-master` skill 本身不改(注入块通过 `/ppt-master` 复用它)。

## 5. 数据流

```
用户点芯片 → PptTemplatePicker.select(id) → pptTemplate store(selectedId, 持久化 localStorage)
用户输入主题 + 发送 → onNew 读 store.getState().selectedId
   ├─ null → wireText = text(原样)──────────────┐
   └─ 选中 → wireText = buildPptPrompt(tpl, text) ─┤
                                                   ▼
        storeContent 显示原始 text(用户气泡) + chatApi.send({ text: wireText })
                                                   ▼
                       main ChatEngine → fusion-code CLI → /ppt-master 管道 → PPTX
```

## 6. 错误处理与边界

- **选中的 id 在注册表里找不到**(localStorage 残留旧 id):`find` 返回 undefined → 当作未选,`wireText = text`,不抛错。store 初始化时也可校验并清掉无效 id。
- **窄窗口芯片与权限选择器重叠**:实现时在最小窗口宽度下目测验证,必要时让左侧容器在极窄时收起为单个图标。
- **附件/图片 + 模板同时存在**:模板指令块照常前置;空输入校验只看 `text`,与附件流程不冲突。
- **`resolveJsonModule` 未开**:typecheck 会报 import JSON 失败,实现第一步先确认/打开。

## 7. 测试与验收

无单元测试框架,质量门为 `bun run typecheck`。手动验收清单:

1. 不选模板发送 → 行为与改动前一致(回归基线)。
2. 选「商务深蓝」+ 输入主题发送 → CLI 收到带风格/结构指令的 prompt;Thread 气泡只显示用户原文。
3. 再点已选中的芯片 → 回到未选态;再次发送不带模板。
4. 切换不同模板 → 注入块内容随之变化。
5. 刷新/重开 → 上次选择保留(localStorage)。
6. 窄窗口 → 芯片与权限选择器不重叠、不溢出。
7. `bun run typecheck` 通过。

## 8. 实现步骤(给后续实现参考)

1. 确认/打开 `tsconfig.web.json` 的 `resolveJsonModule`。
2. 建 `templates/ppt/` 三个 JSON + `index.ts`(类型 + 注册表)+ `buildPptPrompt`。
3. 建 `stores/pptTemplate.ts`(zustand + localStorage,默认 null,select 可反选)。
4. 建 `components/chat/PptTemplatePicker.tsx`,挂到 `ThreadView.tsx:2275` strip 左侧。
5. 改 `FusionRuntimeProvider.tsx` 的 `onNew`:读 store → 算 `wireText` → 显示用原 `text`、发送用 `wireText`。
6. `bun run typecheck` + 手动走 §7 验收清单。

## 9. 未来扩展(本期不做,YAGNI)

- 模板缩略图预览。
- 用户自定义/导入模板(届时再考虑方案 B 的 main 侧文件 + IPC)。
- 模板与 `skillChipRegistry` 的视觉统一/打通。
