# apps/web Apple 风格重构 — /goal condition 集

把整个 `apps/web` 的 CSS 对齐项目根 `DESIGN.md`（Apple 设计规范）。
因总量超单个 `/goal` 的 50 turn 上限，拆成 5 个子 goal。

## 怎么用

1. **按 G1 → G5 顺序跑**。G1 必须先跑：它把 `:root` 的 `--radius` 改成 Apple 的 11/18，
   G2~G5 都假设圆角变量已对齐（condition 里都写了"圆角走 var(--radius*)，别硬编码"）。
2. **每个 goal 配 auto mode**——否则每个工具调用都要手动点同意，等于白用 `/goal`。
3. 跑完一个 goal、`bun run dev` 扫一眼观感满意，再跑下一个。每个 goal 各自独立通过
   typecheck + build，互不污染。

## 完成定义与已知局限

- 完成 = **代理指标 grep 计数降到分区阈值 + typecheck exit 0 + build exit 0**（用户选定）。
- ⚠️ **代理指标归零 ≠ 视觉对**。grep 阈值验的是"机械偏离改没改"，验不出"看起来像不像 Apple"。
  每个 goal 跑完真正的判断还得靠人眼。
- ⚠️ **content vs chrome 边界**：plugins-home 的缩略图 serif/gradient、index.css 的代码高亮/
  markdown/骨架屏渐变都是"被展示的内容"，不是 UI chrome，一律保留。各 condition 已写明。
- ⚠️ **G5（index.css 主体）最不确定**：27k 行里 content/chrome 没法靠 grep 切干净，所以定成
  "保守降到 ~65%"而非归零，反作弊收得最紧。若跑 G5 时 105 阈值逼着改坏东西，停下细拆。

## 基线计数（生成时实测，2026-05-23）

| 文件 | fw500系列 | var(--serif) | 装饰渐变 |
|---|---|---|---|
| index.css :root --radius | `--radius:12px` `--radius-lg:16px`（待改 11/18） | — | — |
| design-system-flow.css | 9 | 2 | 4 |
| entry-layout.css | 7 | 1 | 3 |
| new-project-modal.css | 0 | 1 | 0 |
| plugins-home.css | 2 | 4(content) | 9(多为content) |
| plugins-view.css | 5 | 1 | 0 |
| tasks.css | 5 | 0 | 2 |
| use-everywhere.css | 4 | 0 | 0 |
| integrations.css | 2 | 0 | 1 |
| index.css 主体 | 160 | 0 | 54 |

---

## Goal 1：全局基础层（token 圆角 + design-system-flow）— 先跑

```
Objective: 把 apps/web 的全局基础样式层对齐 Apple 设计规范（项目根 DESIGN.md），分两件事：(A) 修正 index.css :root 的圆角 token 刻度到 Apple 值；(B) 把 design-system-flow.css 里 UI chrome（非内容预览）的 Apple 偏离点收敛。所有改动以 DESIGN.md 的 token 为准。

Scope（只动这两处）:
- apps/web/src/index.css 的 :root 段（约 79-82 行的 --radius* 定义）
- apps/web/src/styles/design-system-flow.css

CAN edit: 上述两个文件的 CSS 值（圆角变量、font-weight、font-family、background 渐变、box-shadow）
DO NOT edit: 任何其它文件；packages/design-tokens/tokens.css；index.css 除 :root --radius* 外的 27000+ 行主体；任何 .tsx/.ts；DESIGN.md。

Apple 规范要点（来自 DESIGN.md，改时遵守）:
- 圆角刻度：sm=8px / md=11px / lg=18px / pill=999px。把 index.css :root 的 --radius:12px 改 11px、--radius-lg:16px 改 18px，--radius-sm 保持 8px、--radius-pill 保持 999px。
- 字重阶梯 300/400/600/700，禁用 500（含 550/580/650）。UI chrome 的 font-weight: 5x0 改成 400（正文/次要）或 600（强调/标题），按语义就近选。
- 标题/品牌字用 var(--sans)（SF Pro），不用 var(--serif)。但 design-system-flow.css 里若 serif 用在"被展示的设计作品内容预览"（如示意排版块）则保留——那是 content 不是 chrome。
- chrome 零装饰阴影、零装饰渐变；功能性 focus ring（0 0 0 Npx accent）保留；被展示内容的渐变保留。

Done-when（全部满足，每条在 transcript 打印命令输出验证）:
1. 圆角 token 已对齐：`grep -nE '^\s*--radius(-lg)?:' apps/web/src/index.css` 输出显示 `--radius: 11px` 且 `--radius-lg: 18px`（其余 --radius-sm:8px / --radius-pill:999px 不变）。
2. design-system-flow.css 的 UI font-weight 500/550/580/650 计数从基线 9 降到 ≤3：`grep -cE 'font-weight:\s*5[0-9]0|font-weight:\s*650' apps/web/src/styles/design-system-flow.css` 输出 ≤3。
3. design-system-flow.css 的装饰渐变计数从基线 4 降到 ≤2（保留的须是内容预览渐变，在 diff 旁注明）：`grep -cE 'linear-gradient|radial-gradient' apps/web/src/styles/design-system-flow.css` 输出 ≤2。
4. 类型门绿：`cd apps/web && bunx tsc -b --noEmit` 打印结束且 exit 0，无 `error TS`。
5. 构建门绿：`cd apps/web && bun run build` 打印 `Compiled successfully` 或等价成功行且 exit 0。

Stop-if（命中任一即停，向用户报告）:
1. 已用满 18 个 turn 仍未让全部 Done-when 通过。
2. 反作弊·删规则充数：`git diff --stat apps/web/src/styles/design-system-flow.css` 显示净删除行数 > 60（靠删 CSS 规则压低 grep 计数，而非改值）。
3. 反作弊·伪改值：出现 `font-weight: 501` / `font-weight: 499` 这类"为躲 grep 而非整字重"的值——`grep -nE 'font-weight:\s*(49[0-9]|50[1-9]|5[1-9][1-9])' apps/web/src/styles/design-system-flow.css` 命中任何行。
4. 反作弊·挪进注释：偏离代码被注释掉而非真改——`git diff apps/web/src/styles/design-system-flow.css` 新增的 `/*` 注释行数 > 8。
5. 越界：`git status --porcelain` 显示除 apps/web/src/index.css 和 apps/web/src/styles/design-system-flow.css 以外的文件被修改。
```

---

## Goal 2：入口布局 + 新建项目弹窗

```
Objective: 把 apps/web 的"入口布局 + 新建项目弹窗"两块样式对齐 Apple 设计规范（项目根 DESIGN.md）。收敛其中 UI chrome（非内容预览）的 Apple 偏离点：字重 500、UI 衬线体、装饰渐变、chrome 软阴影。所有改动以 DESIGN.md token 为准。

Scope（只动这两个文件）:
- apps/web/src/styles/home/entry-layout.css
- apps/web/src/styles/home/new-project-modal.css

CAN edit: 这两个文件的 CSS 值（font-weight / font-family / background 渐变 / box-shadow / border-radius）
DO NOT edit: 任何其它文件；index.css；packages/design-tokens；任何 .tsx/.ts；DESIGN.md。

Apple 规范要点（来自 DESIGN.md）:
- 字重阶梯 300/400/600/700，禁 500/550/580/650。UI 的 font-weight:5x0 改 400（正文/次要）或 600（强调/标题），按语义就近选。
- 标题/品牌用 var(--sans)（SF Pro），不用 var(--serif)；若 serif 用在被展示的设计作品内容预览则保留（content 非 chrome），在 diff 旁注明。
- chrome 零装饰阴影/渐变；功能性 focus ring（0 0 0 Npx accent）保留；被展示内容渐变保留。
- 圆角走 var(--radius*) 变量（G1 已对齐 8/11/18/pill），别硬编码新刻度。

Done-when（全部满足，每条打印命令输出）:
1. entry-layout.css UI font-weight 500 系列从基线 7 降到 ≤2：`grep -cE 'font-weight:\s*5[0-9]0|font-weight:\s*650' apps/web/src/styles/home/entry-layout.css` 输出 ≤2。
2. entry-layout.css 装饰渐变从基线 3 降到 ≤1：`grep -cE 'linear-gradient|radial-gradient' apps/web/src/styles/home/entry-layout.css` 输出 ≤1。
3. 两文件的 UI serif 已去除（基线各 1，保留的须是 content 预览并在 diff 注明）：`grep -c 'var(--serif)' apps/web/src/styles/home/entry-layout.css apps/web/src/styles/home/new-project-modal.css` 两文件合计 ≤1。
4. 类型门绿：`cd apps/web && bunx tsc -b --noEmit` exit 0，无 `error TS`。
5. 构建门绿：`cd apps/web && bun run build` 打印成功行且 exit 0。

Stop-if（命中任一即停并报告）:
1. 用满 18 个 turn 仍未全部 Done-when 通过。
2. 反作弊·删规则：`git diff --stat apps/web/src/styles/home/entry-layout.css` 净删除 > 50。
3. 反作弊·伪改值：`grep -nE 'font-weight:\s*(49[0-9]|50[1-9]|5[1-9][1-9])' apps/web/src/styles/home/entry-layout.css apps/web/src/styles/home/new-project-modal.css` 命中任何行。
4. 反作弊·挪注释：`git diff apps/web/src/styles/home/entry-layout.css` 新增 `/*` 注释行 > 8。
5. 越界：`git status --porcelain` 显示除这两个文件外有文件被修改。
```

---

## Goal 3：plugins-home + plugins-view

```
Objective: 把 apps/web 的 plugins-home + plugins-view 两块样式对齐 Apple 设计规范（项目根 DESIGN.md）。收敛 UI chrome 的 Apple 偏离：字重 500、UI 衬线体、装饰渐变。注意 plugins-home.css 里大量 serif/gradient 是 community 缩略图里"被展示的用户设计作品内容"，必须保留——只改 UI chrome。所有改动以 DESIGN.md token 为准。

Scope（只动这两个文件）:
- apps/web/src/styles/home/plugins-home.css
- apps/web/src/styles/home/plugins-view.css

CAN edit: 这两个文件的 CSS 值（font-weight / font-family / background 渐变 / box-shadow / border-radius）
DO NOT edit: 任何其它文件；index.css；packages/design-tokens；任何 .tsx/.ts；DESIGN.md。

Apple 规范要点（来自 DESIGN.md）:
- 字重阶梯 300/400/600/700，禁 500/550/580/650。UI 的 5x0 改 400 或 600 按语义就近。
- 标题/品牌用 var(--sans)。但 plugins-home.css 的 .plugins-home__html--fallback / .plugins-home__design / .plugins-home__text-glyph / .plugins-home__media-fallback-glyph 等是被展示的设计作品内容预览，其 serif + gradient 一律保留，不得改。
- chrome 零装饰阴影/渐变；功能 focus ring 保留；内容预览渐变保留。
- 圆角走 var(--radius*)（G1 已对齐），别硬编码。

Done-when（全部满足，每条打印命令输出）:
1. plugins-view.css UI font-weight 500 系列从基线 5 降到 ≤2：`grep -cE 'font-weight:\s*5[0-9]0|font-weight:\s*650' apps/web/src/styles/home/plugins-view.css` 输出 ≤2。
2. plugins-home.css UI font-weight 500 系列从基线 2 降到 0：`grep -cE 'font-weight:\s*5[0-9]0|font-weight:\s*650' apps/web/src/styles/home/plugins-home.css` 输出 0。
3. plugins-home.css 的 serif 计数维持 ≤4 且 plugins-view.css 的 UI serif 从基线 1 降到 0：`grep -c 'var(--serif)' apps/web/src/styles/home/plugins-view.css` 输出 0。（plugins-home 的 4 处是 content，不动）
4. 类型门绿：`cd apps/web && bunx tsc -b --noEmit` exit 0，无 `error TS`。
5. 构建门绿：`cd apps/web && bun run build` 打印成功行且 exit 0。

Stop-if（命中任一即停并报告）:
1. 用满 18 个 turn 仍未全部 Done-when 通过。
2. 反作弊·删规则：`git diff --stat apps/web/src/styles/home/plugins-home.css apps/web/src/styles/home/plugins-view.css` 净删除 > 50。
3. 反作弊·误删内容预览：plugins-home.css 的 gradient 计数跌破 8（基线 9，只许 chrome 那 ≤1 处动）——`grep -cE 'linear-gradient|radial-gradient' apps/web/src/styles/home/plugins-home.css` 输出 < 8。
4. 反作弊·伪改值：`grep -nE 'font-weight:\s*(49[0-9]|50[1-9]|5[1-9][1-9])' apps/web/src/styles/home/plugins-home.css apps/web/src/styles/home/plugins-view.css` 命中任何行。
5. 越界：`git status --porcelain` 显示除这两个文件外有文件被修改。
```

---

## Goal 4：tasks + use-everywhere + integrations

```
Objective: 把 apps/web 的 tasks + use-everywhere + integrations 三块样式对齐 Apple 设计规范（项目根 DESIGN.md）。收敛 UI chrome 的 Apple 偏离：字重 500、装饰渐变、chrome 软阴影。所有改动以 DESIGN.md token 为准。

Scope（只动这三个文件）:
- apps/web/src/styles/home/tasks.css
- apps/web/src/styles/home/use-everywhere.css
- apps/web/src/styles/home/integrations.css

CAN edit: 这三个文件的 CSS 值（font-weight / font-family / background 渐变 / box-shadow / border-radius）
DO NOT edit: 任何其它文件；index.css；packages/design-tokens；任何 .tsx/.ts；DESIGN.md。

Apple 规范要点（来自 DESIGN.md）:
- 字重阶梯 300/400/600/700，禁 500/550/580/650。UI 的 5x0 改 400 或 600 按语义就近。
- 标题/品牌用 var(--sans)；被展示内容预览的 serif 保留并在 diff 注明。
- chrome 零装饰阴影/渐变；功能 focus ring 保留；内容预览渐变保留。
- 圆角走 var(--radius*)（G1 已对齐），别硬编码。

Done-when（全部满足，每条打印命令输出）:
1. tasks.css UI font-weight 500 系列从基线 5 降到 ≤2：`grep -cE 'font-weight:\s*5[0-9]0|font-weight:\s*650' apps/web/src/styles/home/tasks.css` 输出 ≤2。
2. use-everywhere.css 从基线 4 降到 ≤1：`grep -cE 'font-weight:\s*5[0-9]0|font-weight:\s*650' apps/web/src/styles/home/use-everywhere.css` 输出 ≤1。
3. integrations.css 从基线 2 降到 0：`grep -cE 'font-weight:\s*5[0-9]0|font-weight:\s*650' apps/web/src/styles/home/integrations.css` 输出 0。
4. tasks.css 装饰渐变从基线 2 降 ≤1 且 integrations.css 从基线 1 降 0：`grep -cE 'linear-gradient|radial-gradient' apps/web/src/styles/home/tasks.css` 输出 ≤1，且 `grep -cE 'linear-gradient|radial-gradient' apps/web/src/styles/home/integrations.css` 输出 0。
5. 类型门绿：`cd apps/web && bunx tsc -b --noEmit` exit 0，无 `error TS`。
6. 构建门绿：`cd apps/web && bun run build` 打印成功行且 exit 0。

Stop-if（命中任一即停并报告）:
1. 用满 20 个 turn 仍未全部 Done-when 通过。
2. 反作弊·删规则：`git diff --stat apps/web/src/styles/home/tasks.css apps/web/src/styles/home/use-everywhere.css apps/web/src/styles/home/integrations.css` 净删除 > 60。
3. 反作弊·伪改值：`grep -nE 'font-weight:\s*(49[0-9]|50[1-9]|5[1-9][1-9])' apps/web/src/styles/home/tasks.css apps/web/src/styles/home/use-everywhere.css apps/web/src/styles/home/integrations.css` 命中任何行。
4. 反作弊·挪注释：`git diff apps/web/src/styles/home/tasks.css` 新增 `/*` 注释行 > 8。
5. 越界：`git status --porcelain` 显示除这三个文件外有文件被修改。
```

---

## Goal 5：index.css 主体（硬骨头，保守清理）

```
Objective: 把 apps/web 主样式表 index.css 的 27k 行主体里【明确属于 UI chrome】的 Apple 偏离点收敛对齐 DESIGN.md：字重 500、装饰渐变、chrome 软阴影。这是大文件保守清理——不要求归零，只要求明显下降且零回归。无法确定一处是 chrome 还是 content（代码高亮/markdown 正文/骨架屏/被展示内容）时一律保留。

Scope（只动一个文件）:
- apps/web/src/index.css（除 :root 的 --radius* 外，那已在 G1 改完，本 goal 不再碰 :root token 定义）

CAN edit: index.css 选择器规则体内、明确是 UI chrome 的 font-weight / background 渐变 / box-shadow 值
DO NOT edit: 任何其它文件；index.css 的 :root token 定义段；packages/design-tokens；任何 .tsx/.ts；DESIGN.md。

Apple 规范要点（来自 DESIGN.md）:
- 字重阶梯 300/400/600/700，禁 500/550/580/650。把【明确是 UI chrome（按钮/标签/导航/卡片标题/工具栏）】的 5x0 改 400 或 600 按语义就近。markdown 正文、代码高亮 token、prose、表格内容文字的字重一律不动（content）。
- chrome 零装饰渐变/软阴影；功能性 focus ring、骨架屏 shimmer 渐变、被展示内容的渐变保留。
- 不新增硬编码圆角；圆角走 var(--radius*)。

Done-when（全部满足，每条打印命令输出）:
1. index.css UI font-weight 500 系列从基线 160 降到 ≤105：`grep -cE 'font-weight:\s*5[0-9]0|font-weight:\s*650' apps/web/src/index.css` 输出 ≤105。
2. index.css 装饰渐变从基线 54 降到 ≤40：`grep -cE 'linear-gradient|radial-gradient' apps/web/src/index.css` 输出 ≤40。
3. 类型门绿：`cd apps/web && bunx tsc -b --noEmit` exit 0，无 `error TS`。
4. 构建门绿：`cd apps/web && bun run build` 打印成功行且 exit 0。
5. 测试不回归：`cd apps/web && bun run test` 打印结尾汇总且 exit 0（无新增 failed）。

Stop-if（命中任一即停并报告）:
1. 用满 30 个 turn 仍未全部 Done-when 通过。
2. 反作弊·删规则充数：`git diff --stat apps/web/src/index.css` 显示净删除行数 > 120（靠删规则压 grep 计数）。
3. 反作弊·伪改值：`grep -nE 'font-weight:\s*(49[0-9]|50[1-9]|5[1-9][1-9])' apps/web/src/index.css` 命中任何行。
4. 反作弊·挪注释：`git diff apps/web/src/index.css` 新增的 `/*` 注释行数 > 15。
5. 反作弊·过度删渐变伤内容：index.css 渐变计数跌破 30（基线 54，超过 24 处被删意味着误伤了 content/shimmer）——`grep -cE 'linear-gradient|radial-gradient' apps/web/src/index.css` 输出 < 30。
6. 越界：`git status --porcelain` 显示除 apps/web/src/index.css 外有文件被修改。
```
