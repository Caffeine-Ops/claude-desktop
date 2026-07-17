# 技能市场（Skills Market）

用户在应用内浏览并安装 skill/插件；内容托管在远端静态源（首选 Gitee 公开仓库，
可整体切到自建服务器）。**技能与插件按 kind 分装两个根**（2026-07-17 分家）：
技能落 `~/.cowork/skills/<id>`，插件落 `~/.cowork/plugins/<id>`——**每个安装的
条目独立注册为一个 local plugin**（2026-07-17 更早的 redesign，见下），进入
CLI 会话后命名空间恒为 `cowork:<subid>`。**安装/移除只对新会话生效**。

目录布局仿 OpenAI Codex 插件缓存的实拍结构（`manifest.json` + `README.md` +
`assets/` + `skills/`），字段名基本照抄 `interface.*` 分组，方便日后要接现成
素材/文案时直接抄，不用做名字翻译。

## 架构一览

```
Gitee 仓库（或任意静态 HTTP 源）
  registry.json + skills/<id>/{...} + plugins/<id>/{manifest.json,README.md,assets/,skills/<subid>/SKILL.md}
        │  GET（undici，daemon 内）
        ▼
daemon /api/skills-market/*          apps/daemon/src/skills-market/
  registry 缓存(5min，改写 composerIcon/logo/screenshots 为代理 URL)
  / installed / install(SSE) / uninstall / readme / asset（图标代理）
        │  写盘（按 entry.kind 选根，marketRemoteDirFor 是唯一映射源）
        ▼
~/.cowork/skills/<id>/           ← kind=skill              ~/.cowork/plugins/<id>/  ← kind=plugin
  .claude-plugin/plugin.json  {name:"cowork", skills:"./skills/"}  ← 安装器合成（两根同构）
  .cowork-market.json                            ← 安装器合成的记账（目录即真相）
  manifest.json / README.md / assets/*           ← 下载来的市场资料，原样保留
  skills/<subid>/SKILL.md                        ← 真正喂给 CLI 的内容，可以有多个
~/.cowork/skills/.claude-plugin/plugin.json      ← 根级兼容 manifest（只在 skills 根，手放老式扁平技能用）
        │  spawn 时烘焙
        ▼
engine.ts plugins:[bundled, ...两个根下每个已装条目各一条] → fusion-code → cowork:<subid>
（冷启动预热：seedSkills.ts 遍历 resolveCoworkPluginEntries()）
        ▲
市场 UI  src/canvas/components/market/（?market=1 → SurfaceHost 第三个面，rail「插件」入口）
```

## 市场 UI 的落位（2026-07-17 两次改形态后的定稿）

市场是 **SurfaceHost 里与 chat/canvas 平级的第三个面**，开关是挂在当前
pathname 上的 `?market=1`（`src/stores/marketOverlay.ts`）。SurfaceHost 本身
渲染在 rail 右侧的 shell-stage 里（`app/layout.tsx`），所以市场天然是
「rail 常驻 + 右侧内容区换成市场」——不像知识库/设置那样 `fixed inset-0`
连 rail 一起盖住。

组件树**宿主中立**：`MarketView`/`MarketDetailPage` 只认 props 回调
（`onOpenDetail`/`onBack`），不碰任何 router；两级视图由宿主
（`MarketSurface`）的本地 state 承担、不进 URL。这一点是被两次返工逼出来的，
别退回去：

- **不要给市场占 pathname**（早期是 canvas 的 `/market` + `/market/:id` 路由）：
  SurfaceHost 只认 pathname 二分（`pathname.startsWith('/chat')`），market 占了
  pathname 就会把聊天面拽去画布面——「在智能助手点插件被踢去工作画布」。
  那两条路由已删，故意不留。
- **rail 常驻会暴露「overlay 语义 vs 导航控件」的冲突**（知识库/设置盖住 rail
  所以撞不到，别照抄它们的做法）。核心：rail 里所有「已经在目标位置就 no-op」
  的守卫都基于 pathname，而 market 开着时 pathname **没变**——守卫全部误判，
  用户被困。三处：
  1. rail 的 surface tab 导航走 `TabsTrigger` 的 **onClick 而非 Tabs 的
     onValueChange**——market 开在聊天面时 tab value 仍是 'chat'（value 由
     pathname 派生），点「智能助手」onValueChange 压根不触发。
  2. 「切到聊天面」的入口（`AppRail.goSurface` / `RailSessionList.goChat`）
     各自加 `hasMarketOverlay()` 判断，否则「市场开着点会话」没反应。
     pushState('/chat') 写死路径不带 query，天然剥掉 market。
  3. canvas 的 `navigate()` **自己剥 market**（`stripMarketParam`）——它保留
     query 是为了 `?host=desktop`/`?settings=1`（跟着画布面走的状态），而
     market 是盖在画布面之上的另一个面，语义相反。收在这个唯一出口而不是让
     每个调用方 `closeMarketOverlay()`：画布导航入口太多（rail 项目列表、
     面包屑、卡片…），逐个打补丁必漏——这条就是漏掉后被用户实锤补的。
  4. 「新对话」按钮（`AppRail` 展开态 + `RailShell` 收起态）在聊天面走
     `switchShellSession(null)` —— **只切 runtime、自身不导航**，市场盖着
     的话新会话建好了却看不见，故先 `closeMarketOverlay()`。同类「改变
     chat 内容但不导航」的调用点里，`RailSessionList` 删会话后移交选中与
     `SessionSearchDialog` 的 ⌘K **故意不处理**（它们本就设计成不跳路由，
     注释有据），别当漏网去"修"。
- **rail 的选中态要跟着市场走**：market 开着时 `RailSessionList`/
  `RailProjectList` 的 activeId 一律 null（内容区不是那个会话/项目，留着
  高亮是骗人），「当前位置」由「插件」按钮的选中态表达。rail 订阅
  `useMarketOverlayStore`（URL 的 zustand 镜像）而不是自己 useSearchParams
  ——rail 不在 Suspense 内，直接用会让 static export 的 prerender 报错。

## 为什么每个条目是独立 local plugin（而不是共享一个根 plugin.json）

fusion-code 只认 `.claude-plugin/plugin.json`（`{name, skills}` 两个字段），
`skills` 字段是相对路径、指向"每个免子目录里有 SKILL.md 就是一个技能"的目录。
如果所有市场条目挤在同一个共享根 plugin.json 下，SKILL.md 就必须直接摆在
`<skillsRoot>/<id>/` 这一层——装不下 Codex 那种 `manifest.json + README.md +
assets/ + skills/` 的目录结构（SKILL.md 会和市场资料文件混在一起，也没法一个
条目打包多个技能）。改成每个条目自己带一份 `plugin.json`（`skills:"./skills/"`），
SDK `query()` 的 `plugins` 数组里给每个已装条目各加一条，就能既保持目录整洁、
又天然支持"一个插件打包多个技能"（`skills/` 下多个子目录，各自暴露成
`cowork:<subid>`）。

根级共享 plugin.json（`skills:"./"`）没有删掉，是**给用户手放的老式扁平技能兜底**
（SKILL.md 直接丢进 `~/.cowork/skills/<name>/`，不走市场）——两者互不冲突：
市场条目的 SKILL.md 在更深一层（`<id>/skills/<subid>/`），根的 `"./"` 扫描天然
找不到它们，不会重复加载。这份兜底**只在 skills 根**，`~/.cowork/plugins/`
没有对应物——插件永远来自市场、每个条目自带 `.claude-plugin/plugin.json`，
不存在"手放插件"的场景。

## Gitee 仓库布局

技能与插件分两个前缀目录（2026-07-17 分家），`marketRemoteDirFor(kind)`
（`packages/contracts/src/skills-market.ts`）是这个映射的唯一来源，daemon
下载 URL 拼接与发布脚本的目录扫描都读它，不在别处重复写字面量：

```
<repo>/
  registry.json                              ← scripts/publish-skills-registry.ts 生成，勿手编
  categories.json                            ← 可选 [{id,title,order}]，缺省从条目聚合；
                                                "精选"不用配，manifest 里 featured:true 自动进
  .gitattributes                             ← 写 `* -text`（防 CRLF 改写 sha256）
  skills/<id>/                               ← kind:"skill" 条目
    manifest.json                            ← 必须；市场展示元数据（见下）
    README.md                                ← 建议；技能弹层/详情页展示的人类可读说明
    assets/icon.png                          ← manifest.interface.composerIcon 指向的文件
    assets/logo.png                          ← manifest.interface.logo 指向的文件（可选）
    skills/<subid>/SKILL.md                  ← 真正喂给 CLI 的内容，至少一个；可以有多个
    其余文件                                  ← 单文件 <1MiB（gitee raw 匿名限制，发布脚本硬卡）
  plugins/<id>/                              ← kind:"plugin" 条目，结构同上
```

发布脚本会校验 manifest.json 的 `kind` 与所在前缀目录一致（`plugins/` 下必须
`kind:"plugin"`，`skills/` 下必须 `kind:"skill"`）——放错目录直接报错，不会
静默按目录名重新归类；id 在两个前缀目录间全局去重。

`manifest.json`（`SkillManifestSchema`，`packages/contracts/src/skills-market.ts`）：

```jsonc
{
  "name": "password-generator",      // 必须等于目录名（发布脚本会校验）
  "version": "1.0.0",
  "description": "生成安全的随机密码，支持自定义长度和复杂度",
  "author": { "name": "...", "email": "...", "url": "..." },  // 可选
  "homepage": "...", "repository": "...", "license": "MIT",   // 可选
  "keywords": ["密码", "password"],
  "skills": "./skills/",             // 固定值，schema 用 z.literal 卡死
  "kind": "plugin",                  // "skill" | "plugin"；默认 skill
  "featured": true,                  // 额外出现在市场首屏"精选"分区
  "interface": {
    "displayName": "随机密码生成器", // 市场展示名（可中文）
    "shortDescription": "生成安全的随机密码",
    "longDescription": "……",         // 详情页长文
    "developerName": "...",
    "category": "utility",           // 对应 categories.json 的某个 id（单选）
    "capabilities": ["Interactive", "Write"],
    "websiteURL": "...", "privacyPolicyURL": "...", "termsOfServiceURL": "...",
    "composerIcon": "assets/icon.png",
    "logo": "assets/logo.png",
    "defaultPrompt": ["生成一个16位的强密码", "…"],  // 详情页横幅，UI 取前 3 条
    "brandColor": "#7B5BD6",         // #RRGGBB；图标占位色/横幅基调色
    "screenshots": []
  }
}
```

两份 manifest 不要混淆：`manifest.json`（本节，市场资料，下载到本地保留）
与 `.claude-plugin/plugin.json`（CLI 加载用，daemon 安装时本地合成，**不在
gitee 仓库里**）。

## 发布流程

```bash
# 在 gitee 仓库工作副本上
bun scripts/publish-skills-registry.ts --dir <仓库副本路径> --now $(date +%s000)
git add -A && git commit && git push
```

脚本自检：`manifest.json` 的 `name` 必须等于目录名、`skills/` 下至少一个
`SKILL.md`、`composerIcon`/`logo`/`screenshots` 引用的文件必须真实存在，
产出的 registry 还要过客户端同一个 `parseMarketRegistry`（schema + 路径安全 +
`skills/<subid>/SKILL.md` 必在 + id 去重），任一条不满足直接报错不落盘。

## 配置

| env | 作用 | 默认 |
|---|---|---|
| `COWORK_MARKET_BASE_URL` | registry 源根 URL（`<base>/registry.json`、`<base>/skills\|plugins/<id>/<path>`）。换镜像/自建服务器改这里 | `https://gitee.com/guanzhengbing/plugins-skills/raw/main`（真实仓库，2026-07-17 建仓，见 `market.ts` 的 `DEFAULT_BASE_URL`） |
| `COWORK_SKILLS_DIR` | kind=skill 的安装根，daemon 安装器与 engine 加载器**共用**（测试/诊断用） | `~/.cowork/skills` |
| `COWORK_PLUGINS_DIR` | kind=plugin 的安装根，同上共用规则 | `~/.cowork/plugins` |

## 关键约定（改前必读）

- **每个条目 plugin.json 的 `name: "cowork"` 一旦发布不能改**——它是所有已装
  技能的触发名前缀（`cowork:<subid>`），根级兼容 manifest 与 seedSkills 的
  遍历逻辑也都钉了同一字符串。
- 记账哲学：目录即真相。`.cowork-market.json` 随目录删除天然一致；
  files 的 sha256 支撑增量更新（同 sha 本地 copy 不重下）。条目的
  `.claude-plugin/plugin.json` **每次安装都重新生成**（不是"存在就不碰"），
  手改它没有意义，下次更新会被规范内容覆盖——这是有意为之，内容是纯确定性的。
- **kind 决定安装根/远端前缀目录，`marketRemoteDirFor()` 是唯一映射源**
  （`packages/contracts/src/skills-market.ts`）——daemon 的下载 URL 拼接、
  本地安装根选择，与发布脚本的目录扫描/校验都读它，禁止在别处重复写
  `'skills'`/`'plugins'` 字面量，两处硬编码迟早漂移。市场 UI 的「已安装」
  区（`SkillsTab`/`PluginsTab`）按 `kind`（或 `origin==='local'`，恒属于
  skills 根）过滤，不会互相混进对方 tab。
- 仓库根 `skills/` 里的 skill 迁到 gitee 时，**同一个 release 从 repo 删除**，
  避免 `claude-desktop:x` 与 `cowork:x` 长期双份（市场 UI 对与内置同名的
  条目显示「内置」徽标提示）。
- `composerIcon`/`logo`/`screenshots` 在 registry.json 里的值随管线阶段变化：
  daemon 从 gitee 取到时是相对路径，经 `GET /api/skills-market/registry`
  发给前端时被改写成走 `/api/skills-market/entries/:id/asset?path=...` 代理的
  绝对路径——前端永远不用知道远端 base URL。
- daemon 跑 Node（undici）不吃系统代理 env；bun 直跑本模块调试时 bun fetch
  **会**吃代理（本机地址 502），`env -u HTTP_PROXY …` 或注入 fetchImpl。

## 测试

```bash
cd apps/daemon && bunx vitest run -c vitest.config.ts tests/skills-market.test.ts
```

本地全链路（不碰真 gitee）：把试验仓库副本用任意静态服务器伺服，
`COWORK_MARKET_BASE_URL=http://127.0.0.1:<port>` 起应用即可（诊断时可再叠加
`COWORK_SKILLS_DIR`/`COWORK_PLUGINS_DIR` 指向 tmp 目录，避免污染真实
`~/.cowork`）。仓库根有一份可直接拿来试的示例仓库结构可参考（两个条目：
`skills/` 下一个 skill、`plugins/` 下一个 plugin，含真实生成的图标/logo
PNG），发布产物已本地端到端验证过双根安装链路。
