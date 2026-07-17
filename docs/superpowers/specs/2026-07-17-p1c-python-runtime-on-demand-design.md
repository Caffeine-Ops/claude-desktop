# 按需下载组件框架 P1c — python-runtime 搬出安装包(首个真实搬迁)

日期:2026-07-17
状态:设计草案(用户已批准 6 项关键决策 + 七节设计)→ 待用户复核 spec → writing-plans
分支:feat/kb-markitdown-one-click-install(继续,不新开——用户已拍板,沿 P1a/P1b 惯例)

## 关系与前序

- **总设计(伞)**:`2026-07-16-on-demand-component-download-design.md` —— 本 spec 落地其 **Phase 2 候选 #1**(python-runtime 首搬),套用其「单次搬迁验收模板」。这是框架搭好后**第一次真实瘦身**:新装用户安装包约小 24MB 压缩 / 67MB 落盘(≈10%)。
- **P1a(通用下载引擎,已合入本分支)**:`hostedFilesInstaller` 已支持 `kind:'archive'` + strip/chmod/readyCheck,python 的 tarball 正好是这个形状——**后端下载能力零新增**。
- **P1b(状态表/IPC/组件中心/弹窗,已终审 Ready to merge + 实机验证闭环)**:组件状态表、`COMPONENT_*` 四通道、组件中心 UI、渐进弹窗、toast 全部现成——**本期加一张卡就自动获得全部 UI**。
- **P1a/P1b 留给本期的技术备忘(必须遵守)**:
  - 镜像回退只覆盖「传输失败」、不覆盖「sha 校验失败」。本期 python 卡 `urls` 只填单一 astral 官方源、镜像位留空;将来真加镜像须先把 sha 校验挪进 `downloadWithMirrors` 单次尝试内。
  - `installComponent` 按 registry 逐组件调用,勿回退循环整清单(P1b 编排器已如此,本期不动)。
  - 进度分母可复用 `descriptorTotalBytes()`(python 卡是单 archive,天然成立)。
  - i18n 死键 `compBundled`('随包'/'Bundled')系 P1b 为本期预留,本期转正(见第⑤节)。

## 本期范围(P1c)

1. **名册加第四张卡** `python-runtime`(`kind:'archive'`,平台三选一在名册内完成)。
2. **落盘根目录按组件分家**(顺路修正:python 不落 kb-model 目录)。
3. **消费方接线**:`resolveBundledPythonHome()` 认 userData 下载落点;venv 零改动靠既有自愈。
4. **触发器(本期唯一新机制)**:main 侧侦听 ppt-master 技能调用 → 推送「建议下载」给发起会话的界面 → 复用 P1b 渐进弹窗。新增一条单向 IPC。
5. **随包互认**:dev / 残存随包环境下 python 组件显示就绪(「随包」灰字),不误催下载。
6. **CI / 打包退场**:删「Bundle Python runtime」步 + extraResources 两条,版本钉搬进名册。
7. **顺带三件**(用户拍板捎上):组件中心正常导航入口 / `[查看下载详情]` 直达分类(pendingCategory)/ toast 4s→6s。

### 明确不做(YAGNI / 留后续)

- node-runtime、reranker 搬迁(伞 spec 候选 #2/#3)。
- 镜像实填、断点续传、后台自动预下载、磁盘占用管理(伞 spec 待办②)。
- 打包体积守卫 bundle-decisions.json + CI 硬卡(伞 spec 待办①,框架之后)。
- venv 主动重建/迁移(已拍板:健康不碰,坏了靠既有自愈)。
- 双轨过渡(已拍板:本期直接停随包)。

---

## 已定的 6 项关键决策(用户拍板,2026-07-17)

| 决策 | 选择 | 理由 |
|---|---|---|
| 分支策略 | **同分支续做**(feat/kb-markitdown-one-click-install) | 沿 P1a/P1b 惯例,台账/评审 base 机制已适配 |
| 平台维度 | **名册登记时三选一,共享类型零改动** | 平台差异封在名册一个文件内;不动已终审的下载器与其测试 |
| 触发时机 | **main 侧侦听 ppt-master 技能调用,用到才提醒** | 无「做 PPT」按钮可挂门;缺 python 有系统兜底故提醒非拦路;不做 PPT 的用户永不被打扰 |
| 过渡策略 | **本期直接停 CI 随包(单轨切换)** | 新包立省 ~10%;老升级用户靠「下次做 PPT 弹窗 + venv 自愈 + 系统 python 兜底」三层闭环 |
| venv 联动 | **不主动重建,自然过渡** | `ensure-python.sh` 就绪判据 `-x venv/bin/python` 对悬空符号链接判 false → 自动重建,自愈已存在;推倒健康环境违反「不让功能比之前更糟」铁律 |
| 顺带范围 | **三件全捎**:组件中心入口 + pendingCategory 定位 + toast 6s | 与本期动的是同一片代码;python 接入后组件中心无入口会更扎眼 |

---

## ① 名册加卡:python-runtime(平台三选一在此完成)

`electron/main/core/componentRegistry.ts` 加第四张档案卡。文件内放一张**三平台小表**,模块加载时按 `process.platform` + `process.arch` 三选一,拼成一张**普通的** `kind:'archive'` 档案卡——共享类型(`componentDownload.ts`)、下载器、IPC、UI 全部零感知:

```ts
// 形如(实施时以真值替换 sha256/size):
const PYTHON_DISTS = {
  'darwin-arm64': { dist: 'aarch64-apple-darwin',    sha256: '<pin>', size: <bytes> },
  'darwin-x64':   { dist: 'x86_64-apple-darwin',     sha256: '<pin>', size: <bytes> },
  'win32-x64':    { dist: 'x86_64-pc-windows-msvc',  sha256: '<pin>', size: <bytes> },
} // key = `${process.platform}-${process.arch}`
```

- **来源与版本钉**:沿用 CI 同源 astral-sh/python-build-standalone,`install_only` tar.gz,tag `20260510` / 版本 `3.12.13`(**版本钉的唯一事实源从 build.yml env 搬到这里**,含「为何钉 3.12——避开 py3.14 无 wheel 源码编译坑」的注释一并搬来)。
- **档案卡字段**:`strategy:'hosted-files'`、`install: { kind:'archive', format:'tar.gz', stripComponents:1, destSubdir:'python-runtime', chmodExec:['bin/python3'](win 不需要), readyCheck:'bin/python3'(win 'python.exe'), archive:{ urls:[官方 GitHub release 地址], sha256, size } }`。
- **sha256/size 取真值**:实施时从该 release 的 `.sha256` 资产 + GitHub API 取三平台真值钉进代码(同 embed 模型的 pin 做法)。
- **未知平台(如 linux / win-arm64)**:小表查不到 → 名册**不注册这张卡**(而非注册一张坏卡)。组件中心该行自然不出现,触发器查不到组件也不弹——与「CI 本就只打这三个平台」现状一致。
- `title`/`description` 人话:「Python 运行环境 —— 制作 PPT(ppt-master 技能)的基座,约 24MB;缺失时用系统 Python 兜底」。

## ② 落盘根目录按组件分家(顺路修正)

现状:`componentOrchestrator.ts` 对所有组件统一用 `kbModelDir()`(= userData/kb-model)当安装根——embed 住那里合理,python 落进 kb-model 语义错乱。

改法:编排器加一个**按组件挑根目录**的小函数(`componentInstallRoot(d)` 之类):embed → `kbModelDir()` **一字节不变**(零回归铁律);python-runtime → `userData/components/`(配合 `destSubdir:'python-runtime'`,最终落 `userData/components/python-runtime/`,解释器在其 `bin/python3`)。共享类型零改动。编排器内三处 `kbModelDir()` 调用(探测/安装/复核)统一改经该函数。

## ③ 消费方接线(下载完怎么被用上)

- **`resolveBundledPythonHome()`**(`cliDetect.ts:189`)候选清单**新增 userData 落点**,优先级:`resourcesPath/python-runtime`(切换后不存在,留着无害,兼容未升级场景)→ **`userData/components/python-runtime`(新增)** → 既有 dev 仓库内候选。注意该目录**无平台子层**(一台机器只有一种平台,与随包/dev 的 `<platform>/` 子目录布局不同——现有函数对 resourcesPath 候选本就不带平台子层,模式一致)。userData 路径经参数传入或 `app.getPath('userData')` 取得,实施时按该文件现有依赖风格选最小改法。
- **引擎零改动**:`engine.ts` openSession 本就每次 spawn 现查 `resolveBundledPythonHome()` 再注入 `PPT_MASTER_PYTHON_HOME`——下载完成后**新开会话自动用上**;当前已开会话该次用系统 python 兜底(既有三层降级,不崩)。
- **`ensure-python.sh` 零改动**:venv 自愈已存在(悬空符号链接 → `-x` 判 false → 自动用新 base 重建 + 重装依赖)。已拍板不主动重建健康 venv。

## ④ 触发器:main 侧侦听 ppt-master 调用(本期唯一新机制)

**挂哪**:引擎处理 assistant 消息、finalize `tool_use` 事件的那条路(`handleAssistantMessage` 一线)——**不是 `canUseTool`**(预放行/allowedTools/bypass 模式会跳过权限回调,技能调用大概率被预放行;而画卡片的转发路所有工具调用必经)。

**匹配什么(双信号,纯函数)**:(a) `Skill` 工具且 skill 参数含 `ppt-master`;(b) `Bash` 工具且 command 含 `ensure-python.sh`(技能真正要 python 的那一刻,兜底信号)。⚠️ 仓内无硬编码 `Skill` 字面量可抄,**实施时须用一次真实 ppt-master 调用核实 tool_use 的准确形状**(工具名/参数字段),匹配器按核实结果定稿——此为计划里的显式验证步骤,不许拍脑袋。

**发什么**:命中 → 查编排器组件表,python-runtime 非 `ready` → 经**新增单向 IPC**(main→renderer,广播型,名如 `COMPONENT_PROMPT`)向**本引擎绑定的 webContents**(发起会话的那个 tab,同 canUseTool 回归 runtime 的纪律)发 `{ id:'python-runtime' }`。渲染进程收到 → 调 P1b 既有 `promptComponent('python-runtime')` 打开渐进弹窗。

**防骚扰三层**:main 只在「非 ready」时发;引擎每 SessionRuntime 一个 fire-once 标记(同会话反复调技能不轰炸);渲染层 componentPrompt store 既有 dismissed 语义(`[暂不]` 后本次不再提)第三重兜底。

**IPC 四处同改铁律**照走:`ipc-channels.ts`(通道常量)→ `preload/index.ts`(暴露 `onComponentPrompt` 订阅)→ `preload/index.d.ts`(如承载则同步)→ main 侧发送点。弹窗文案对兜底诚实:「制作 PPT 建议下载 Python 运行环境(约 24MB)。本次先用系统环境继续,不打断。」

## ⑤ 随包互认(防「明明能用还催下载」)

dev 环境(仓库内 `apps/studio/python-runtime/<platform>/` 可能被填过;升级是整包替换,正式包里不存在「新代码+旧随包」共存,resourcesPath 候选纯属防御性保留)下,python 明明可用,组件表若只认 userData 判据会报 idle → 触发器误弹、组件中心误催。

改法:python 组件的就绪探测在通用 readyCheck(userData 落点)之外**额外认 `resolveBundledPythonHome()` 非空**——找到即 `ready`。挂法沿 P1b「按组件 id 挂小表」的既有模式(同成功收尾钩子),**不污染通用编排器**。组件中心该行就绪时若来源是随包,显示 `compBundled`('随包')灰字——P1b 预留死键转正。

## ⑥ CI / 打包退场(瘦身兑现点)

- `.github/workflows/build.yml`:删「Bundle Python runtime」步(240-270 行一带,含 233-238 的布局注释——注释精华随版本钉搬进名册)、矩阵三处 `python_dist`(56/72/80 行)、env `PYTHON_STANDALONE_TAG/VERSION`(28-29 行)。554/606 行的 `python3` 是 CI 自身脚本,**不碰**。
- `apps/studio/package.json`:删 extraResources 两条 python-runtime 声明(mac 97-98 / win 130-131)。
- `resolveBundledPythonHome()` 的 resourcesPath 候选**保留**(见③)。
- **体积核实**:本地打不出 CI 真包(既定约束),验收 = 下次 CI tag 打包后对比 GitHub Release 资产,安装包应小 ≈24MB。

## ⑦ 顺带三件

1. **组件中心正常入口**:侧栏 TabBar 既有「设置」行(`TabBar.tsx:128`,开 web 版设置)下方加一行「组件与扩展」。机制走现成菜单动作转发链:`ShellMenuAction` 联合类型(`ipc-channels.ts:1434` 一带)加 `'open-components'` → `register.ts:1618` 白名单加同值 → `App.tsx:133` 分支加 `openSettings('components')`。零新 IPC 通道。i18n 新键中英对齐。
2. **`[查看下载详情]` 直达分类**:`stores/settings.ts` 加 `pendingCategory: string | null`,`openSettings(category?)` 可选带目标;`SettingsView.tsx` 打开时消费一次(读后清空)定位 `activeCategory`。ComponentPrompt 的 `[查看下载详情]` 与上面新入口都传 `'components'`。台账 Task 9 记录的修法照做。
3. **toast 时长**:`stores/toast.ts` 自动出队 4s → 6s(实机验证时用户差点错过报喜,台账已记)。

---

## 架构与单元边界

- **平台差异**封死在名册一个文件内(下游只见普通档案卡)。
- **根目录选择**是编排器内一个纯映射函数,embed 路径字节不变。
- **触发匹配器**是纯函数(tool_use 形状 → 是否命中),bun:test 直接测;发送/去重是引擎侧薄接线。
- **随包互认**按 id 挂在编排器外围小表,通用引擎不知道 python 的特殊性。
- **已终审代码零改动清单**:`hostedFilesInstaller.ts` / `downloadUnit.ts` / `componentDownload.ts`(共享类型)/ `ensure-python.sh` / `engine.ts` 的 pythonHome 注入段——全部不碰。

## 测试与门

- bun:test 纯核:平台三选一(注入假 platform/arch 验证三分支 + 未知平台不注册)、触发匹配器(Skill 命中 / Bash ensure-python 命中 / 无关工具不命中)、根目录映射(embed 字节不变 / python 落 components)。
- 门照旧:`cd apps/studio && bun run typecheck`(双 tsc)+ `bun test electron/`(479 pass 基线零回归)。无 ESLint/E2E。
- 子代理只 `git add` 任务列出的确切文件,**绝不 `-A`**(工作区 ~104 个不相关脏文件);子代理不跑 dev,运行时验证留用户。

## 验收标准

### 功能
- 组件中心出现「Python 运行环境」行,idle→[下载]→进度条+[取消]→✓ 全链路走通;error 显示原因+[重试]。
- AI 调用 ppt-master 且 python 未就绪 → 渐进弹窗出现;`[暂不]` 后同会话不再弹;当次 PPT 走系统 python 兜底照常完成。
- 下载完成后新开会话的 PPT 用上 userData 下载版(`PPT_MASTER_PYTHON_HOME` 指向之)。
- dev 环境有随包 python 时组件行显示就绪(随包灰字),不弹提醒。
- TabBar 新行「组件与扩展」一键直达组件分类;弹窗 `[查看下载详情]` 同样直达;toast 停 6s。

### 工程
- build.yml 与 package.json 的 python 打包链全部退役;版本钉唯一事实源在名册。
- IPC 新通道四处无类型漏;typecheck 绿 + electron/ 测试零回归;纯核新测试全绿。
- 已终审文件零改动清单兑现(评审逐项核对)。

### 运行时(留用户实机)
- 触发弹窗 → 下载 → 新会话做 PPT 用上下载版,全链实机走一遍。
- 断网/取消下载 → 功能不比没组件更糟(系统 python 兜底照跑)。
- 下次 CI tag 打包后核实安装包体积差 ≈24MB(伞 spec「单次搬迁验收模板」条款)。

## 实施顺序建议(供 writing-plans 参考)

1. 名册三平台小表 + 档案卡(含 sha256/size 取真值钉入)+ 纯核测试。
2. 编排器根目录分家 + 随包互认小表 + 纯核测试(embed 判据字节不变是硬门)。
3. `resolveBundledPythonHome()` 加 userData 候选。
4. 触发器:先用真实调用核实 tool_use 形状 → 纯函数匹配器 + 测试 → 引擎接线 + 新 IPC 四处 + 渲染层订阅接 `promptComponent`。
5. 顺带三件(入口 / pendingCategory / toast)。
6. CI / package.json 退场(放最后——前面全绿才拆桥)。

每步 typecheck 绿 + 纯核 bun:test 为门;运行时留用户。
