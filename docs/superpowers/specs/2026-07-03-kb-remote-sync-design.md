# 写方案·知识库远程同步（服务器集中构建 + 客户端拉取制品）设计

日期：2026-07-03
状态：已与用户对齐方案 A，待用户审阅本 spec

## 背景与问题

「写方案」的知识库目前是纯本机模型：用户选一个源目录（kbRoot），本机跑 `scripts/build-kb-index.ts`（依赖 markitdown + LibreOffice）产出镜像到 `userData/kb-index/`，运行时（检索、提示词注入、`kbasset://` 显图、权限静默放行）只读这份镜像。

用户诉求：**团队多人、多台电脑共用同一份知识库，新电脑开箱即用、自动同步**。约束与现状：

- 有公司内网服务器可用；
- 知识库经常更新，多人都会往里加改文件；
- 「开箱即用」的最大障碍不是 3GB 源文件，而是本地构建工具链（markitdown/LibreOffice/xlrd）——每台新机都要装一遍；
- 运行时只读镜像制品（约 1.8GB，291 文件），根本不需要源文件在本机。

结论（已对齐）：**知识库源文件和索引构建都上服务器，客户端只同步构建产物**。

## 已对齐的决策

| 决策点 | 结论 |
|---|---|
| 方案选型 | A：服务器集中构建 + 客户端自动拉取制品（否决 B 各机自建、C 同步盘分发） |
| 团队更新知识库的方式 | 照旧往服务器共享盘（SMB）丢文件，服务器定时重建索引，客户端无上传能力 |
| 多团队多知识库 | **本期不实现**，但协议、配置、目录收口三处从第一天留好口子（见「扩展口子」节） |
| 离线行为 | 服务器不可达时用最后一次同步的本地镜像照常工作，不阻塞「写方案」 |
| 运行时读路径 | **零改动**——同步引擎只是 `userData/kb-index/` 的另一个生产者，所有读方经 `kbOutDir()` 无感 |

## 架构总览

```
服务器（内网）                                客户端（每台电脑）
┌────────────────────────────┐               ┌────────────────────────────┐
│ /srv/kb/source/   ←SMB共享盘 │               │ kb-config.json             │
│   （团队直接增删源文件）        │               │   { remote:{baseUrl,kbId} }│
│        │ cron 定时           │               │        │                   │
│        ▼                    │               │        ▼                   │
│ build-kb-index.ts（现有脚本） │               │ kbSync.ts（新，主进程）      │
│        ▼                    │    HTTP GET   │  fetch manifest → diff →   │
│ /srv/kb/publish/<kbId>/     │ ◄─────────────│  增量下载/删除 → 原子落盘     │
│   index.json + 镜像 + assets │               │        ▼                   │
│   manifest.json（新脚本产出）  │               │ userData/kb-index/（不变）   │
│        ▲                    │               │        ▲                   │
│ nginx 静态服务 /kb/<kbId>/…  │               │ 现有读方全部无感（kbOutDir）   │
└────────────────────────────┘               └────────────────────────────┘
```

数据流一句话：服务器 cron 构建出与今天本机构建完全相同的 kb-index 制品，外加一份 manifest（逐文件 sha1）；客户端定时对比 manifest，增量下载差异文件进本地 `kb-index/`，运行时代码一行不改。

## 详细设计

### ① manifest 与发布脚本（服务器侧，新增 `scripts/publish-kb-manifest.ts`）

构建完成后遍历制品目录生成 `manifest.json`：

```json
{
  "schemaVersion": 1,
  "kbId": "default",
  "name": "福鑫数科产品线资料库",
  "builtAtMs": 1751500000000,
  "files": [
    { "path": "index.json", "sha1": "…", "size": 12345 },
    { "path": "01AI患者服务/1_智能导诊系统/…/方案.docx.md", "sha1": "…", "size": 67890 },
    { "path": "assets/…/img-1.png", "sha1": "…", "size": 4567 }
  ]
}
```

- `path` 一律 POSIX 分隔符、相对制品根；客户端拼 URL 时逐段 `encodeURIComponent`（路径全中文），拼本地路径时按平台分隔符 join（吸取 Windows 分隔符坑的教训，转换收口在一个纯函数里并配单测）。
- `files` 覆盖制品目录**全部**文件（含 `index.json` 与 `assets/**`）；`index.json` 的应用顺序由客户端保证（见 ③）。
- 时间戳由 cron wrapper 传入（`--now`），与 build 脚本同规矩——脚本内不调 `Date.now()`。
- **发布原子性取舍**：不做版本化目录（YAGNI）。构建中途客户端来拉可能读到新旧混合，但逐文件 sha1 校验兜底——下载后校验不符即重试、仍不符跳过留待下轮自愈；`index.json` 最后应用保证引用一致性。撕裂窗口 = 构建时长，内网增量构建通常秒级。

### ② 客户端配置模型（改 `kbIndexStore.ts`）

`userData/kb-config.json` 扩展为：

```ts
{ kbRoot?: string; remote?: { baseUrl: string; kbId: string } }
```

- 防御解析（现有风格延续）：字段缺失/类型不对一律当 null，老格式 `{ kbRoot }` 原样兼容；
- **remote 存在即远程模式**（优先于 kbRoot）；`remote: null` 写回 = 切回本地模式；
- 本期设置 UI 里 `kbId` 固定 `"default"` 不暴露，但配置结构从第一天就带着它。

### ③ 同步引擎（新增 `src/main/core/kbSync.ts`，engine-free 单例）

同步一次的流程：

1. `GET <baseUrl>/kb/<kbId>/manifest.json`（超时 10s）→ 校验 `schemaVersion === 1` 且 `kbId` 匹配，不符即中止并报错状态，本地镜像不动；
2. 与本地基准 `userData/kb-sync/manifest.json`（**上次成功同步后落盘的副本**）做 diff（纯函数 `diffManifests`）：
   - `toDownload`：远端新增或 sha1 变化的文件；
   - `toDelete`：本地基准有、远端没有的文件；
   - 无本地基准（首次同步 / 从本地构建模式切换过来）→ 以**磁盘实际扫描**为基准做对账：全量校对 sha1 决定下载清单，且删除制品目录里不在远端 manifest 中的文件——防止旧本地构建的残留文件污染检索；
3. 并发 4 下载：写 `<目标>.part` → sha1 校验 → `rename` 原子落位；**`index.json` 强制排在最后应用**——中途断电/断网时读方看到的 index 永远不会引用尚未落地的镜像文件；
4. 执行 `toDelete`（只删文件不删目录树根，路径必须解析在 `kbOutDir()` 之内——复用现有 `isPathInsideRoot` 守卫，防 manifest 恶意构造 `../` 逃逸）；
5. 全部成功 → 把远端 manifest 落盘为新基准，广播成功状态；部分文件失败 → 基准**不更新**（下轮重拉差异），广播「部分成功」及失败清单。

触发时机：应用启动后延迟 30s（不挤占冷启动）+ 每 6 小时定时 + 设置页「立即同步」。单飞行锁防重入；应用退出不需要清理（.part 残留由下次同步开头统一清扫）。

失败降级：任何网络/服务器错误都不影响现有镜像——「写方案」永远可用最后一次同步的版本，设置页展示「上次同步时间 + 错误原因」。

### ④ IPC 四件套（按 CLAUDE.md 规矩四处同改）

| 通道 | 方向 | 语义 |
|---|---|---|
| `KB_PATH_GET`（扩展） | R→M | 返回 `{ kbRoot, outDir, remote, lastSync }`——一次往返给设置页全部状态 |
| `KB_REMOTE_SET`（新） | R→M | 写 remote 配置（传 null 切回本地模式）；写入即触发一次立即同步 |
| `KB_SYNC_NOW`（新） | R→M | 手动触发；返回 `started \| alreadyRunning` |
| `KB_SYNC_STATUS`（新） | M→R 推送 | `idle \| syncing{done,total} \| success{atMs,version} \| error{message,failedCount}` |

同改：`ipc-channels.ts` → `preload/index.ts` → `preload/index.d.ts` → `register.ts`。这些 handler 全部 engine-free（同 KB 现有三条通道），不碰任何 per-tab ChatEngine。

### ⑤ 设置 UI（SettingsView 新增「知识库」分区）

现状：KB 的 IPC/preload 早就通了，但 renderer 从来没有调用者——设置 UI 是**新建**不是改造。在 SettingsView 的分区骨架上加一个「知识库」section：

- 来源单选：**本地目录**（现状路径选择器 + 本机构建说明）/ **远程服务器**（baseUrl 输入框）；
- 远程模式下展示：当前版本（builtAtMs 人话化）、上次同步时间、同步进度条（syncing 时）、失败原因（error 时）、「立即同步」按钮；
- 切换来源是就地生效的普通配置写入，无需重启（读方本来就每次 IPC 现读配置）。

### ⑥ 服务器部署（交付一份 `docs/kb-server-deploy.md`，不是应用代码）

- 依赖安装：bun、pipx markitdown（**必须 `pipx inject markitdown xlrd`**，否则 .xls 全军覆没——本机已踩过）、LibreOffice；
- 目录约定：`/srv/kb/source/`（SMB 共享给团队）→ `/srv/kb/publish/default/`（构建产物 + manifest）；
- cron 每小时：`build-kb-index.ts --kb …/source --out …/publish/default --now $(date +%s)000` && `publish-kb-manifest.ts --dir …/publish/default --kb-id default --name …`（构建失败则不生成新 manifest，客户端自然停在旧版本）；
- nginx：`/kb/` 静态映射到 `/srv/kb/publish/`，URL 即 `/kb/<kbId>/<相对路径>`，注意开 percent-encoding 中文路径支持（nginx 默认即可）与 `charset utf-8`。

## 多团队多知识库的扩展口子（本期不实现）

本期只做单知识库，但以下五处从第一天按多 KB 形状落地，P1 时不需要迁移：

1. **URL 布局含 kbId**：`/kb/<kbId>/…`，本期恒为 `default`；
2. **manifest 自带 `kbId`/`name`**：客户端校验 kbId 匹配，P1 直接复用；
3. **配置结构含 `remote.kbId`**：P1 变成 KB 列表 + activeKbId，解析函数向后兼容；
4. **镜像目录收口点唯一（主进程侧）**：主进程所有读方（proposalScopes、engine 提示词注入、权限静默放行、kbasset 守卫）都经 `kbOutDir()` 一个函数。P1 把它参数化为 `kbOutDir(activeKbId)`（目录变 `kb-index/<kbId>/`），主进程读方自动跟随——这正是本期坚持「同步只生产、不新增读路径」的原因。**已知例外（P1 迁移清单第一项）**：renderer 侧 `lib/kbAssetUrl.ts` 的 `KB_ASSET_MARKER = '/kb-index/assets/'` 是 kbOutDir 之外唯一一处 KB 路径字面量（`includes` 判定 KB 图并转 `kbasset://`）——目录一旦多一层 kbId，marker 匹配不上、库图预览全灭。P1 改目录时必须同步改这个判定（且 `proposalAssetUrl.ts` 注释里与它并列的产出图判定同步复核）；本期目录名不变，不受影响；
5. **鉴权注入点**：kbSync 的所有 HTTP 请求走同一个 fetch 封装，P1 加团队 token 时只改这一处（本期内网免鉴权，不做 UI）。

P1 额外需要：`/kb/index.json` 知识库列表接口、设置页 KB 切换器、切换时的镜像目录并存策略。均不在本期范围。

另一个顺手的红利：语义检索（已定设计的 P1 向量索引）产物未来也落在 kb-index 内，天然随 manifest 分发——服务器算一次 embedding，全团队复用，不必每台机器自建。

## 与「写方案 skill 化」改造的关系（2026-07-03 复核）

本 spec 定稿当天「写方案」完成了 skill 化（方法论文本外置到 `skills/proposal-writer/references/append-template.md`，`buildProposalAppend` 改为运行期读模板 + `{{占位符}}` 渲染，另加 `/proposal-writer` 斜杠入口）。逐点核对后**同步方案不受影响**，且要守住一条新边界：

- **两类内容、两条分发通道，不可混**：方法论模板属于**应用资产**（随包发布，`resolveBundledSkillsPluginDir` 解析、随应用版本升级），知识库镜像属于**数据制品**（随服务器 manifest 同步）。模板不进 manifest、kbSync 绝不写 skills 目录——否则应用升级和知识库同步会互相踩（模板与 `shared/proposal.ts` 协议常量有契约测试锁定，数据通道无从保证这种锁定）。
- 提示词里的镜像路径是运行期经 `{{KB_SCOPE}}` 占位符注入的 `kbOutDir()` 值，模板本身零路径字面量——kbOutDir 收口点不受 skill 化影响；
- CI 已新增 bun test 打包硬门（commit 4573ad7c），kbSync 的单测（见「测试」节）自动纳入守门，实施时快照/契约测试必须保持全绿。

## 错误处理汇总

| 场景 | 行为 |
|---|---|
| 服务器不可达 / 超时 | 保留本地镜像照常用；状态=error，显示上次同步时间 |
| manifest 损坏 / schemaVersion 不认识 / kbId 不匹配 | 中止同步，镜像不动 |
| 单文件下载失败 / sha1 不符 | 重试 2 次 → 跳过并计入失败清单；基准 manifest 不更新，下轮自愈 |
| 中途断电 / 强退 | `.part` 残留下次开头清扫；index.json 最后应用保证不出现悬空引用 |
| manifest 含逃逸路径（`../`） | 逐条经 `isPathInsideRoot` 校验，越界即整轮中止（视为恶意/损坏源） |
| 磁盘不足 | 下载前按 manifest 总 size 预检，不足则报错不动手 |

## 测试（bun test，沿用现有基建）

- `diffManifests` 纯函数：新增/变化/删除/index.json 排序最后/空基准全量；
- 路径转换纯函数：POSIX path ↔ 平台路径 ↔ URL 编码（中文、空格、`../` 拒绝）；
- 配置解析向后兼容：老 `{kbRoot}`、缺字段、损坏 JSON、remote 优先级；
- 同步引擎（mock fetch）：sha1 校验失败重试、部分失败不更新基准、首次对账清理多余文件、单飞行锁。

## 非目标（明确不做）

- 客户端上传/双向同步——更新知识库唯一入口是服务器共享盘；
- 文件内增量（rsync 式 delta）——整文件粒度足够，镜像单文件都不大；
- 版本化发布目录与回滚；
- 多团队多知识库的完整实现（只留口子）；
- 公网暴露与鉴权 UI（内网明文 HTTP 起步）。

## 改动清单（预估）

| 位置 | 内容 | 性质 |
|---|---|---|
| `scripts/publish-kb-manifest.ts` | manifest 生成 | 新增 |
| `src/main/core/kbSync.ts` | 同步引擎 | 新增（核心，~300 行） |
| `src/main/core/kbIndexStore.ts` | 配置模型扩展 | 修改 |
| `src/shared/ipc-channels.ts` + preload 两文件 + `ipc/register.ts` | IPC 三新一扩 | 修改 |
| `components/settings/SettingsView.tsx`（+新子组件） | 知识库设置分区 | 新增 |
| `docs/kb-server-deploy.md` | 服务器部署手册 | 新增 |
