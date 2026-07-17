# P1c python-runtime 按需下载搬迁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** python-runtime(mac 落盘 67MB / 压缩 ~24MB)从 CI 随包改为按需下载组件,接进既有 componentRegistry/componentOrchestrator/组件中心框架;顺带补组件中心导航入口、弹窗定位分类、toast 6s。

**Architecture:** 名册加第四张 `kind:'archive'` 档案卡(平台三选一封在名册内);编排器按组件分家安装根目录(embed 字节不变);main 在 tool_use 转发路侦听 ppt-master 调用→新单向 IPC 推「建议下载」→复用 P1b 渐进弹窗;CI/extraResources 的 python 打包链退役。

**Tech Stack:** Electron main(TypeScript)+ React 19 + zustand + bun:test。包管理器是 **bun**,不是 npm。

**Spec:** `docs/superpowers/specs/2026-07-17-p1c-python-runtime-on-demand-design.md`(含 6 项用户拍板决策,任何取舍疑问以它为准)

## Global Constraints

- 只 `git add` 本任务列出的确切文件,**绝不 `git add -A`**——工作区有 ~104 个不相关脏文件(ppt PNG / bun.lock)。
- 唯一自动化门:`cd apps/studio && bun run typecheck`(双 tsc)+ `bun test electron/`(基线 479 pass,允许因新增测试而增加,不允许减少/失败)。无 ESLint、无 E2E。子代理**不跑 dev**,运行时验证留用户。
- **已终审代码零改动清单**(评审逐项核对):`electron/main/services/componentInstaller/hostedFilesInstaller.ts`、`downloadUnit.ts`、`skills/ppt-master/bin/ensure-python.sh`、`engine.ts` 的 pythonHome 注入段(1747-2012 行一带)。`electron/shared/componentDownload.ts` 仅允许 Task 1 的一项纯追加字段。
- 注释密度沿仓库惯例:解释「为什么这样而不是那样」,不写「做了什么」流水账。
- 版本钉:python-build-standalone tag `20260510`、版本 `3.12.13`(与 CI 现值一致,Task 8 退役 CI 后名册是唯一事实源)。
- 提交信息格式沿用分支惯例:`feat(component-download): …` / `chore(ci): …`,结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: ComponentState 追加 origin 字段(「随包」来源注记)

**Files:**
- Modify: `apps/studio/electron/shared/componentDownload.ts`
- Test: `apps/studio/electron/shared/componentDownload.test.ts`

**Interfaces:**
- Produces: `ComponentState.origin: 'bundled' | null`(新字段,默认 null);`initialComponentState(id)` 返回值含 `origin: null`。Task 3 的就绪探针写 `'bundled'`,Task 5 的 UI 读它显示「随包」灰字。
- 铁律:本文件**其余任何字段、函数、类型一概不动**(spec「零改动清单」的唯一放行项就是这一个追加)。

- [ ] **Step 1: 写失败测试**

在 `componentDownload.test.ts` 里现有 `initialComponentState` 相关 describe 内追加(若该文件没有专门 describe,就在文件末尾加一个):

```ts
test('initialComponentState 含 origin: null(P1c 随包来源注记的缺省值)', () => {
  expect(initialComponentState('x').origin).toBeNull()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/shared/componentDownload.test.ts`
Expected: FAIL(`origin` 不存在,TS 编译期或断言期报错)

- [ ] **Step 3: 实现**

`componentDownload.ts` 的 `ComponentState` 接口追加一个字段,并在 `initialComponentState` 里补缺省值:

```ts
export interface ComponentState {
  id: string
  status: ComponentStatus
  percent: number | null      // 仅 installing 且可测量时有值,否则 null
  currentFile: string | null  // 下载型当前文件(供 UI 文本),否则 null
  errorMessage: string | null // error 态原因,否则 null
  /** ready 态的来源注记:'bundled' = 靠随包/dev 目录里的现成品判的就绪(userData 没有下载副本)。
   *  仅 python-runtime 的就绪探针会写它(componentOrchestrator 的 READY_PROBES),其余组件恒 null。
   *  为什么进共享状态而不是前端推断:前端只见整表,不知道 main 侧探测走的哪条判据,来源只能由
   *  唯一写手(编排器)注记。UI 用它在「✓ 已就绪」旁挂『随包』灰字(i18n compBundled 键转正)。 */
  origin: 'bundled' | null
}
```

```ts
export function initialComponentState(id: string): ComponentState {
  return { id, status: 'idle', percent: null, currentFile: null, errorMessage: null, origin: null }
}
```

- [ ] **Step 4: 跑测试 + 全量门**

Run: `cd apps/studio && bun test electron/shared/componentDownload.test.ts && bun test electron/ && bun run typecheck`
Expected: 全 PASS。若 `bun test electron/` 有别处测试因手写 `ComponentState` 字面量对象而编译失败(缺 origin),给那些字面量补 `origin: null`——这是本追加唯一允许的连带,不许改任何断言语义。

- [ ] **Step 5: Commit**

```bash
git add apps/studio/electron/shared/componentDownload.ts apps/studio/electron/shared/componentDownload.test.ts
git commit -m "feat(component-download): ComponentState 追加 origin 随包来源注记"
```

---

### Task 2: 名册加 python-runtime 档案卡(平台三选一封在名册内)

**Files:**
- Modify: `apps/studio/electron/main/core/componentRegistry.ts`
- Test: `apps/studio/electron/main/core/componentRegistry.test.ts`

**Interfaces:**
- Consumes: 既有 `ComponentDescriptor` / `HostedArchiveInstall`(shared,不改)。
- Produces:
  - `export const PYTHON_COMPONENT_ID = 'python-runtime'`
  - `export function pickPythonDist(platform: string, arch: string): { url: string; sha256: string; size: number; readyCheck: string; chmodExec: string[] } | undefined`(纯函数,注入平台可测)
  - `COMPONENT_REGISTRY` 在 mac-arm64/mac-x64/win-x64 上含第四张卡(id = PYTHON_COMPONENT_ID,`strategy:'hosted-files'`,`install.kind:'archive'`,`destSubdir:'python-runtime'`);未知平台**不注册**(不给坏卡)。

- [ ] **Step 1: 写失败测试**

`componentRegistry.test.ts` 末尾追加:

```ts
import { PYTHON_COMPONENT_ID, pickPythonDist } from './componentRegistry'

describe('python-runtime 档案卡(P1c)', () => {
  test('三个已支持平台各返回一份完整 dist,未知平台返回 undefined', () => {
    const mac = pickPythonDist('darwin', 'arm64')!
    const macX64 = pickPythonDist('darwin', 'x64')!
    const win = pickPythonDist('win32', 'x64')!
    expect(mac.url).toContain('aarch64-apple-darwin-install_only.tar.gz')
    expect(macX64.url).toContain('x86_64-apple-darwin-install_only.tar.gz')
    expect(win.url).toContain('x86_64-pc-windows-msvc-install_only.tar.gz')
    // 版本钉出现在 url 里(名册是唯一事实源,CI 的 env 钉在 Task 8 退役)
    for (const d of [mac, macX64, win]) {
      expect(d.url).toContain('20260510')
      expect(d.url).toContain('3.12.13')
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(d.size).toBeGreaterThan(10_000_000)
    }
    // 就绪判据/chmod 按平台分岔:mac 解释器在 bin/python3(需补 +x),win 在根下 python.exe
    expect(mac.readyCheck).toBe('bin/python3')
    expect(mac.chmodExec).toEqual(['bin/python3'])
    expect(win.readyCheck).toBe('python.exe')
    expect(win.chmodExec).toEqual([])
    expect(pickPythonDist('linux', 'x64')).toBeUndefined()
    expect(pickPythonDist('win32', 'arm64')).toBeUndefined()
  })

  test('本机平台(darwin-arm64 CI/dev 机)注册了 python 卡且忠实于 pickPythonDist', () => {
    // 本仓 dev/CI 都是 mac;若将来在别的平台跑测试,这条按平台自适应即可
    const dist = pickPythonDist(process.platform, process.arch)
    const d = getComponentDescriptor(PYTHON_COMPONENT_ID)
    if (!dist) { expect(d).toBeUndefined(); return }
    expect(d).toBeDefined()
    expect(d!.strategy).toBe('hosted-files')
    if (d!.install.kind !== 'archive') throw new Error('python 应为 archive 形态')
    expect(d!.install.destSubdir).toBe('python-runtime')
    expect(d!.install.format).toBe('tar.gz')
    expect(d!.install.stripComponents).toBe(1)
    expect(d!.install.readyCheck).toBe(dist.readyCheck)
    expect(d!.install.archive.urls).toEqual([dist.url])
    expect(d!.install.archive.sha256).toBe(dist.sha256)
    expect(d!.install.archive.size).toBe(dist.size)
    expect(d!.sizeEstimateBytes).toBe(dist.size)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/main/core/componentRegistry.test.ts`
Expected: FAIL(`pickPythonDist` 未导出)

- [ ] **Step 3: 实现**

`componentRegistry.ts` 在 soffice 卡之后追加(并把文件头注释第 3 行「P1b 已把 markitdown/soffice 追加进来…reranker/python-runtime 仍待后续任务加」更新为「P1c 已加 python-runtime;仅 reranker 待将来加」):

```ts
export const PYTHON_COMPONENT_ID = 'python-runtime'

// python-runtime:ppt-master 技能的运行基座,P1c 起从 CI 随包改为按需下载(spec
// 2026-07-17-p1c-python-runtime-on-demand-design.md)。版本钉的唯一事实源在这里——
// 钉 3.12 的原因(从 build.yml 已退役的 Bundle 步注释搬来):py3.14 下 PyMuPDF/Pillow/numpy
// 无预编译 wheel,pip 退化源码编译会极慢甚至失败;3.12 有成熟 cp312 wheel。
// install_only tarball 顶层是单个 python/ 目录(bin/、lib/ 在其下),stripComponents:1
// 剥掉它,解释器落 <destSubdir>/bin/python3(win 是 <destSubdir>/python.exe)——与
// resolveBundledPythonHome() 的解释器判据(cliDetect.ts)一致。
const PYTHON_STANDALONE_TAG = '20260510'
const PYTHON_STANDALONE_VERSION = '3.12.13'

// 三平台小表:平台差异(url/sha256/size/判据)全部封死在本文件,下游(installer/IPC/UI)
// 只见一张普通 archive 卡(用户拍板的「名册登记时三选一」方案)。sha256/size 来自该 release
// 官方 SHA256SUMS 与 GitHub API 实测(2026-07-17 取值),同 embed 卡 pin 校验和的做法。
const PYTHON_DISTS: Record<string, { dist: string; sha256: string; size: number }> = {
  'darwin-arm64': {
    dist: 'aarch64-apple-darwin',
    sha256: '5a30271f8d345a5b02b0c9e4e31e0f1e1455a8e4a04fba95cd9762472abc3b17',
    size: 25102827,
  },
  'darwin-x64': {
    dist: 'x86_64-apple-darwin',
    sha256: 'cd369e76973c3179bc578230d8615ab621968ed758c5e32f636eecef4ad79894',
    size: 24783117,
  },
  'win32-x64': {
    dist: 'x86_64-pc-windows-msvc',
    sha256: '346dfbcb95171dd6d1275e6f8cb2e656cc15cb054c399ae54db57bfad4b1a60f',
    size: 45962574,
  },
}

/** 平台三选一(纯函数,测试注入平台)。未知平台返回 undefined——名册随之不注册 python 卡,
 *  组件中心该行不出现、触发器查无此组件也不弹,与「CI 本就只打这三个平台」的现状一致。 */
export function pickPythonDist(platform: string, arch: string):
  { url: string; sha256: string; size: number; readyCheck: string; chmodExec: string[] } | undefined {
  const entry = PYTHON_DISTS[`${platform}-${arch}`]
  if (!entry) return undefined
  const asset = `cpython-${PYTHON_STANDALONE_VERSION}+${PYTHON_STANDALONE_TAG}-${entry.dist}-install_only.tar.gz`
  return {
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_STANDALONE_TAG}/${asset}`,
    sha256: entry.sha256,
    size: entry.size,
    readyCheck: platform === 'win32' ? 'python.exe' : 'bin/python3',
    // win 无 unix 权限位不需要 chmod;installer 对空数组是 no-op
    chmodExec: platform === 'win32' ? [] : ['bin/python3'],
  }
}

const pythonDist = pickPythonDist(process.platform, process.arch)
const pythonDescriptor: ComponentDescriptor | null = pythonDist
  ? {
      id: PYTHON_COMPONENT_ID,
      title: 'Python 运行环境',
      description: '制作 PPT(ppt-master 技能)的运行基座;缺失时用系统 Python 兜底',
      strategy: 'hosted-files',
      sizeEstimateBytes: pythonDist.size,
      install: {
        kind: 'archive',
        destSubdir: 'python-runtime',
        format: 'tar.gz',
        stripComponents: 1,
        chmodExec: pythonDist.chmodExec,
        readyCheck: pythonDist.readyCheck,
        archive: { urls: [pythonDist.url], sha256: pythonDist.sha256, size: pythonDist.size },
      },
    }
  : null
```

并把名册导出改为:

```ts
export const COMPONENT_REGISTRY: ComponentDescriptor[] = [
  embedDescriptor, markitdownDescriptor, sofficeDescriptor,
  ...(pythonDescriptor ? [pythonDescriptor] : []),
]
```

- [ ] **Step 4: 跑测试 + 门**

Run: `cd apps/studio && bun test electron/main/core/componentRegistry.test.ts && bun run typecheck`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/studio/electron/main/core/componentRegistry.ts apps/studio/electron/main/core/componentRegistry.test.ts
git commit -m "feat(component-download): 名册加 python-runtime 档案卡,平台三选一封在名册内"
```

---

### Task 3: 安装根目录分家 + 随包互认探针 + resolveBundledPythonHome 认 userData

**Files:**
- Create: `apps/studio/electron/main/core/componentsDir.ts`
- Modify: `apps/studio/electron/main/services/componentInstaller/componentOrchestrator.core.ts`
- Modify: `apps/studio/electron/main/services/componentInstaller/componentOrchestrator.ts`
- Modify: `apps/studio/electron/main/core/cliDetect.ts`(只动 `resolveBundledPythonHome` 的 candidates 数组与其 docstring)
- Test: `apps/studio/electron/main/services/componentInstaller/componentOrchestrator.core.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ComponentState.origin`;Task 2 的 `PYTHON_COMPONENT_ID`;既有 `isComponentInstalled(d, root, exists)` / `resolveBundledPythonHome()`。
- Produces:
  - `componentsDir(): string`(= `join(app.getPath('userData'), 'components')`)
  - core: `componentInstallRootFor(id: string, roots: { kbModel: string; components: string }): string`(embed → kbModel,其余 → components)
  - orchestrator: `export function isPythonRuntimeReady(): boolean`(Task 4 的触发器消费;**廉价同步探测**,绝不调 detectTooling)
- 铁律:embed 的安装根必须仍是 `kbModelDir()` **字节不变**;`hostedFilesInstaller.ts` 不改。

- [ ] **Step 1: 写失败测试(core 纯函数)**

`componentOrchestrator.core.test.ts` 追加:

```ts
import { componentInstallRootFor } from './componentOrchestrator.core'

describe('componentInstallRootFor(P1c 根目录分家)', () => {
  const roots = { kbModel: '/ud/kb-model', components: '/ud/components' }
  test('embed 仍住 kb-model(字节不变铁律)', () => {
    expect(componentInstallRootFor('kb-embed', roots)).toBe('/ud/kb-model')
  })
  test('python-runtime 与其他一切组件住 components', () => {
    expect(componentInstallRootFor('python-runtime', roots)).toBe('/ud/components')
    expect(componentInstallRootFor('anything-else', roots)).toBe('/ud/components')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/main/services/componentInstaller/componentOrchestrator.core.test.ts`
Expected: FAIL(函数不存在)

- [ ] **Step 3: 实现 core 纯函数**

`componentOrchestrator.core.ts` 追加(该文件 electron-free,保持零 electron import):

```ts
/** 按组件挑安装根目录(P1c 根目录分家)。embed 历史落点是 userData/kb-model(P1a 迁移时
 *  与 kbModelDir() 布局对齐,评审以「字节不变」为门,不能挪);其后一切新组件(python-runtime
 *  起)统一住 userData/components/——python 不是知识库的东西,落 kb-model 语义错乱。
 *  纯函数注入两个根路径,electron 依赖留在 orchestrator 侧(kbModelDir/componentsDir)。 */
export function componentInstallRootFor(id: string, roots: { kbModel: string; components: string }): string {
  return id === 'kb-embed' ? roots.kbModel : roots.components
}
```

(id 用字面量 `'kb-embed'` 而非 import 常量:core 保持只依赖 shared 的既有纪律,且 registry 的 `EMBED_COMPONENT_ID` 本身就是字面量 `'kb-embed'`——测试两头钉死防漂移。)

- [ ] **Step 4: 新建 componentsDir.ts**

```ts
// 通用组件安装根目录(P1c 起)。范式对齐 kbModelDir.ts:dev 与打包统一走 userData
// (可写、每用户独立)。embed 因历史落点仍在 kbModelDir(),不迁——见
// componentOrchestrator.core.ts 的 componentInstallRootFor 注释。
// 目录布局:<componentsDir>/<descriptor.destSubdir>/…(python-runtime 即
// <componentsDir>/python-runtime/bin/python3)。
import { app } from 'electron'
import { join } from 'node:path'

export function componentsDir(): string {
  return join(app.getPath('userData'), 'components')
}
```

- [ ] **Step 5: orchestrator 接线(根目录 + 随包探针)**

`componentOrchestrator.ts`:

a) 顶部 import 追加:

```ts
import { componentInstallRootFor } from './componentOrchestrator.core'
import { componentsDir } from '../../core/componentsDir'
import { resolveBundledPythonHome } from '../../core/cliDetect'
import { PYTHON_COMPONENT_ID } from '../../core/componentRegistry'
```

(`COMPONENT_REGISTRY, getComponentDescriptor, EMBED_COMPONENT_ID` 的既有 import 行保持不动,PYTHON_COMPONENT_ID 并进同一行也可。)

b) 加一个局部 helper + 就绪探针表 + 导出的触发器判据(放在 SUCCESS_HOOKS 附近,同一「按 id 挂小表」模式):

```ts
// 安装根目录(P1c 分家):embed 字节不变住 kb-model,其余住 components。
function installRoot(d: { id: string }): string {
  return componentInstallRootFor(d.id, { kbModel: kbModelDir(), components: componentsDir() })
}

// 就绪探测覆盖(只 python 有;模式同 SUCCESS_HOOKS——组件特例挂小表,不泄进通用循环)。
// python 在通用判据(userData 落点 readyCheck)之外额外认随包/dev 目录里的现成 runtime
// (resolveBundledPythonHome:resourcesPath / 仓内 dev 目录 / Task 3 新增的 userData 候选)——
// 否则 dev 机上明明能用还会被组件中心/触发器催下载。origin:'bundled' 供 UI 显示「随包」灰字;
// 判据来源只能由这里(唯一写手)注记,前端无从推断。
const READY_PROBES: Record<string, () => { ready: boolean; origin: 'bundled' | null }> = {
  [PYTHON_COMPONENT_ID]: () => {
    const d = getComponentDescriptor(PYTHON_COMPONENT_ID)
    if (!d) return { ready: false, origin: null } // 未注册平台不会走到(registry 无卡即无格)
    const downloaded = isComponentInstalled(d, installRoot(d), existsSync)
    const bundled = !downloaded && resolveBundledPythonHome() !== null
    return { ready: downloaded || bundled, origin: bundled ? 'bundled' : null }
  },
}

/** 触发器(engine 侦听 ppt-master 调用)的就绪判据。必须保持**廉价同步**(几次 existsSync)——
 *  这条路挂在 assistant 消息处理热路径上,绝不能调 refreshComponentInstalled()(它会拖进
 *  detectTooling 最坏 8s 同步阻塞,P1b 终审 Important 3 的教训)。
 *  未注册平台(linux 等)返回 true = 永不提示,与「组件行不存在」一致。 */
export function isPythonRuntimeReady(): boolean {
  const probe = READY_PROBES[PYTHON_COMPONENT_ID]
  if (!getComponentDescriptor(PYTHON_COMPONENT_ID)) return true
  return probe().ready
}
```

c) `refreshComponentInstalled` 的 files/archive 分支改为(只这一支,pipx/detect-only 分支不动):

```ts
    if (i.kind === 'files' || i.kind === 'archive') {
      const probe = READY_PROBES[d.id]
      if (probe) {
        const { ready, origin } = probe()
        applyDetectedStatus(d.id, ready)
        // origin 只在 ready 落定且值真的变了才补记,避免给广播添无谓 churn
        // (applyDetectedStatus 本身的 churn 是 P1b 已知留后续项,不在此扩大)。
        if (table[d.id]?.status === 'ready' && table[d.id]?.origin !== origin) {
          patch(d.id, { origin })
        }
      } else {
        applyDetectedStatus(d.id, isComponentInstalled(d, installRoot(d), existsSync))
      }
    }
```

d) `run()` 里两处 `kbModelDir()` 换成 `installRoot(d)`(安装调用与 catch 里的取消复核):

```ts
      await installComponent(d, installRoot(d), controller.signal, (p) => {
```
```ts
      const installed = isComponentInstalled(d, installRoot(d), existsSync)
```

- [ ] **Step 6: cliDetect 加 userData 候选**

`resolveBundledPythonHome()`(`cliDetect.ts:189` 一带)的 `candidates` 数组,在 resourcesPath 候选之后、dev 仓内候选之前插入一条,并在函数 docstring 里补一行来源说明:

```ts
  const candidates = [
    ...(resourcesPath ? [resolve(resourcesPath, 'python-runtime')] : []),
    // P1c 按需下载落点(componentsDir()/python-runtime,无平台子层——一台机器只有一种平台,
    // 与随包/dev 的 <platform>/ 子目录布局不同)。排在 resourcesPath 之后:正式包自 P1c 起
    // 不再随包,该候选通常落空、纯防御;排在 dev 仓内候选之前:用户真下载过就优先用钉版。
    resolve(app.getPath('userData'), 'components', 'python-runtime'),
    resolve(selfDir, '../../python-runtime', platformDir),
    resolve(process.cwd(), 'python-runtime', platformDir),
    resolve(process.cwd(), 'apps/studio/python-runtime', platformDir)
  ]
```

(`app` 已在该文件顶部 import,`resolve` 亦已 import——零新增依赖。不要用 `componentsDir()` import:cliDetect 属 core 层,反向 import services 会引环;路径字面拼写与 componentsDir 保持一致即可,componentRegistry.test 已钉 destSubdir='python-runtime',这里的字面量由 Step 8 的 grep 核对。)

- [ ] **Step 7: 跑测试 + 门**

Run: `cd apps/studio && bun test electron/main/services/componentInstaller/componentOrchestrator.core.test.ts && bun test electron/ && bun run typecheck`
Expected: 全 PASS

- [ ] **Step 8: 核对 embed 字节不变 + 路径字面一致**

Run: `grep -n 'kbModelDir()' apps/studio/electron/main/services/componentInstaller/componentOrchestrator.ts`
Expected: 只剩 `installRoot` helper 内一处(embed 经它仍解析到 kbModelDir())。
Run: `grep -n "components', 'python-runtime'\|'python-runtime'" apps/studio/electron/main/core/cliDetect.ts apps/studio/electron/main/core/componentRegistry.ts | head`
Expected: cliDetect 的 userData 候选与 registry 的 destSubdir 拼出同一目录名。

- [ ] **Step 9: Commit**

```bash
git add apps/studio/electron/main/core/componentsDir.ts apps/studio/electron/main/services/componentInstaller/componentOrchestrator.core.ts apps/studio/electron/main/services/componentInstaller/componentOrchestrator.ts apps/studio/electron/main/core/cliDetect.ts apps/studio/electron/main/services/componentInstaller/componentOrchestrator.core.test.ts
git commit -m "feat(component-download): 安装根分家(embed 字节不变)+ python 随包互认探针 + userData 候选"
```

---

### Task 4: 触发器——engine 侦听 ppt-master 调用 + COMPONENT_PROMPT 单向 IPC

**Files:**
- Create: `apps/studio/electron/main/services/componentInstaller/componentTrigger.core.ts`
- Test: `apps/studio/electron/main/services/componentInstaller/componentTrigger.core.test.ts`
- Modify: `apps/studio/electron/shared/ipc-channels.ts`(通道常量 + ChatApi 接口)
- Modify: `apps/studio/electron/preload/index.ts`
- Modify: `apps/studio/electron/main/core/engine.ts`(只加:一个 import、一个私有字段、一个私有方法、handleAssistantMessage 里一行调用)

**Interfaces:**
- Consumes: Task 2 `PYTHON_COMPONENT_ID`;Task 3 `isPythonRuntimeReady()`。
- Produces:
  - `matchesPptPythonTrigger(toolName: string, input: unknown): boolean`(纯函数)
  - IPC 通道 `COMPONENT_PROMPT: 'component:prompt'`(main→renderer 单向,payload 为组件 id 字符串)
  - preload 方法 `onComponentPrompt(handler: (id: string) => void): () => void`(Task 5 的 App.tsx 消费)
- 背景铁证(写计划时核实):Skill 调用的 tool_use 形状是 `name === 'Skill'` + `input.skill: string`(SDK cli.js 内 `if(q!=="Skill")return; ... typeof K.skill==="string"`)。挂点选 tool_use 转发路而非 canUseTool:预放行/bypass 模式会跳过权限回调,转发路所有工具调用必经。

- [ ] **Step 1: 写失败测试**

`componentTrigger.core.test.ts`(新文件):

```ts
import { describe, expect, test } from 'bun:test'
import { matchesPptPythonTrigger } from './componentTrigger.core'

describe('matchesPptPythonTrigger', () => {
  test('Skill 工具且 skill 含 ppt-master → 命中(含插件前缀形态)', () => {
    expect(matchesPptPythonTrigger('Skill', { skill: 'ppt-master' })).toBe(true)
    expect(matchesPptPythonTrigger('Skill', { skill: 'my-plugin:ppt-master' })).toBe(true)
  })
  test('Bash 工具且 command 含 ensure-python.sh → 命中(技能真正要 python 的那一刻)', () => {
    expect(matchesPptPythonTrigger('Bash', { command: 'source /x/skills/ppt-master/bin/ensure-python.sh' })).toBe(true)
  })
  test('不相干工具/参数/畸形输入 → 不命中且不抛', () => {
    expect(matchesPptPythonTrigger('Skill', { skill: 'draw' })).toBe(false)
    expect(matchesPptPythonTrigger('Bash', { command: 'ls -la' })).toBe(false)
    expect(matchesPptPythonTrigger('Read', { file_path: '/ppt-master' })).toBe(false)
    expect(matchesPptPythonTrigger('Skill', null)).toBe(false)
    expect(matchesPptPythonTrigger('Skill', undefined)).toBe(false)
    expect(matchesPptPythonTrigger('Skill', { skill: 42 })).toBe(false)
    expect(matchesPptPythonTrigger('Bash', 'not-an-object')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/main/services/componentInstaller/componentTrigger.core.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现纯匹配器**

`componentTrigger.core.ts`(新文件,electron-free):

```ts
// 「AI 正要做 PPT」的 tool_use 侦听判据(P1c 触发器,纯函数供 bun test)。
// 为什么是这两个信号:做 PPT 没有界面按钮可挂功能门——是 AI 在会话里自主调用 ppt-master
// 技能(engine 的 tool_use 转发路所有工具调用必经,不像 canUseTool 会被预放行跳过)。
//  a) Skill + input.skill 含 'ppt-master':SDK 的技能调用形状(cli.js 铁证:工具名 'Skill'、
//     参数字段 skill: string);用 includes 而非 === 兼容将来可能的插件前缀(plugin:skill)。
//  b) Bash + command 含 'ensure-python.sh':技能引导文档让模型 source 这个脚本拿解释器,
//     是「真正要 python 的那一刻」,对 a 漏报(技能改名/直呼脚本)兜底。
// input 是未净化的 unknown(上游 block.input 形状不保证),所有取值都先窄化、绝不抛。
export function matchesPptPythonTrigger(toolName: string, input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false
  const rec = input as Record<string, unknown>
  if (toolName === 'Skill') {
    return typeof rec.skill === 'string' && rec.skill.includes('ppt-master')
  }
  if (toolName === 'Bash') {
    return typeof rec.command === 'string' && rec.command.includes('ensure-python.sh')
  }
  return false
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && bun test electron/main/services/componentInstaller/componentTrigger.core.test.ts`
Expected: PASS(3 test 全绿)

- [ ] **Step 5: IPC 三处(通道 + ChatApi 类型 + preload)**

a) `ipc-channels.ts` 的 `IPC_CHANNELS` 里,紧挨既有 `COMPONENT_STATUS: 'component:status'`(约 895 行)之后加:

```ts
  /** main→renderer 单向:建议下载某组件(P1c 触发器;payload = 组件 id)。只发给触发它的
   *  会话所在 tab 的 webContents(engine 直发,不走 tabRegistry 广播——别的窗口没在做 PPT,
   *  不该被打扰),renderer 收到后经 componentPrompt store 开渐进弹窗。 */
  COMPONENT_PROMPT: 'component:prompt',
```

b) 同文件 ChatApi 接口里,紧挨既有 `onComponentStatus`(约 2473 行)之后加:

```ts
  /** 订阅「建议下载组件」推送(P1c 触发器,main 直发本 tab)。返回退订函数。 */
  onComponentPrompt(handler: (id: string) => void): () => void
```

c) `preload/index.ts` 里,紧挨既有 `onComponentStatus` 方法(约 859-865 行)之后加(照抄其 on/off 模式):

```ts
  onComponentPrompt(cb: (id: string) => void): () => void {
    const listener = (_e: unknown, id: string): void => cb(id)
    ipcRenderer.on(IPC_CHANNELS.COMPONENT_PROMPT, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.COMPONENT_PROMPT, listener)
    }
  },
```

(P1b Task 4 已核实 `preload/index.d.ts` 无镜像声明、ChatApi 类型住 ipc-channels.ts,故 index.d.ts 不改;若 typecheck 报缺,以报错为准补齐。main 侧无 handler——单向推送没有 invoke 端。)

- [ ] **Step 6: engine 接线**

`engine.ts`:

a) 顶部 import 区(找到既有从 componentInstaller/componentRegistry 导入的邻近位置,没有就近放)加:

```ts
import { matchesPptPythonTrigger } from '../services/componentInstaller/componentTrigger.core'
import { isPythonRuntimeReady } from '../services/componentInstaller/componentOrchestrator'
import { PYTHON_COMPONENT_ID } from './componentRegistry'
```

(注意:engine.ts 相对路径按其所在 `electron/main/core/` 拼;若已有从 componentRegistry 的 import 行则并入。)

b) 类私有字段(放在其他私有布尔字段附近):

```ts
  /** P1c 触发器的 fire-once 标记:本 engine(=本 tab)整个生命周期至多推一次「建议下载
   *  python」。spec 原写「每 SessionRuntime」,收紧为每 engine——防骚扰更强、不用动
   *  SessionRuntime 结构;renderer 侧 dismissed 语义是第二重,main 的就绪检查是第三重。 */
  private componentPromptFired = false
```

c) 私有方法(放 handleAssistantMessage 附近):

```ts
  /** tool_use 转发路上的组件触发器(P1c):侦听「AI 正要做 PPT」,python 未就绪则向本 tab
   *  推一条 COMPONENT_PROMPT(renderer 开渐进弹窗)。为什么挂这条路而非 canUseTool:预放行
   *  /bypassPermissions 会跳过权限回调,而这里所有 tool_use 必经。isPythonRuntimeReady 是
   *  廉价 existsSync 探测(绝不 detectTooling,8s 同步阻塞的教训见 componentOrchestrator)。
   *  命中即熄火(含已就绪的情形):就绪了永远不需要提示,未就绪也只提示这一次。 */
  private maybeSendComponentPrompt(toolName: string, input: unknown): void {
    if (this.componentPromptFired) return
    if (!matchesPptPythonTrigger(toolName, input)) return
    this.componentPromptFired = true
    if (isPythonRuntimeReady()) return
    if (this.webContents.isDestroyed()) return
    this.webContents.send(IPC_CHANNELS.COMPONENT_PROMPT, PYTHON_COMPONENT_ID)
  }
```

d) `handleAssistantMessage`(约 3650 行)的 tool_use 分支里,`active.toolNameByUseId.set(block.id, block.name)` 之后**、streamed 早返回之前**插一行(必须在早返回之前——流式路径的块也要过侦听):

```ts
        active.toolNameByUseId.set(block.id, block.name)
        this.maybeSendComponentPrompt(block.name, block.input)
```

- [ ] **Step 7: 门**

Run: `cd apps/studio && bun run typecheck && bun test electron/`
Expected: 全 PASS

- [ ] **Step 8: Commit**

```bash
git add apps/studio/electron/main/services/componentInstaller/componentTrigger.core.ts apps/studio/electron/main/services/componentInstaller/componentTrigger.core.test.ts apps/studio/electron/shared/ipc-channels.ts apps/studio/electron/preload/index.ts apps/studio/electron/main/core/engine.ts
git commit -m "feat(component-download): engine 侦听 ppt-master 调用,COMPONENT_PROMPT 单向 IPC 推荐下载 python"
```

---

### Task 5: 渲染层——弹窗接收推送 + python 文案 + 组件中心行 + 「随包」灰字

**Files:**
- Modify: `apps/studio/src/chat/App.tsx`(加一个订阅 effect)
- Modify: `apps/studio/src/chat/components/ComponentPrompt.tsx`(TITLE_KEY/BODY 分岔)
- Modify: `apps/studio/src/chat/components/settings/ComponentsSection.tsx`(ROWS + 随包灰字)
- Modify: `apps/studio/src/chat/i18n.ts`(zh/en 各 3 键)

**Interfaces:**
- Consumes: Task 4 `window.chatApi.onComponentPrompt`;Task 1 `ComponentState.origin`;既有 `promptComponent(id)` / `useComponentPromptStore.isDismissed`。
- Produces: i18n 键 `compPythonTitle` / `compPythonDesc` / `compPromptBodyPython`(中英)。

- [ ] **Step 1: i18n 键(zh 块与 en 块各加,插在既有 comp* 键群内)**

zh(约 174 行 `compSofficeDesc` 之后):

```ts
    compPythonTitle: 'Python 运行环境',
    compPythonDesc: '制作 PPT(ppt-master 技能)的运行基座,钉死 3.12;缺失时用系统 Python 兜底',
```

zh(约 189 行 `compPromptBody` 之后):

```ts
    // python 专属邀请正文(P1c):触发点是「AI 正在做 PPT」,必须对兜底诚实——本次不等下载、
    // 系统 Python 照跑,下载的收益是之后的会话用上钉版 3.12(避开系统版本无 wheel 的坑)。
    compPromptBodyPython: '用「{title}」制作 PPT 更稳(钉死 3.12,避开系统 Python 版本坑)。要现在下载吗?本次会先用系统 Python 继续,不打断你。',
```

en(对应位置,`compSofficeDesc` 英文行后 / `compPromptBody` 英文行后):

```ts
    compPythonTitle: 'Python runtime',
    compPythonDesc: 'Runtime base for making PPTs (ppt-master skill), pinned to 3.12; falls back to system Python when missing',
```

```ts
    // Python-specific invitation body (P1c): triggered while the AI is already making a PPT, so the
    // copy must stay honest about the fallback — this run continues on system Python regardless.
    compPromptBodyPython: 'Downloading “{title}” makes PPT generation more reliable (pinned 3.12, avoids system-Python wheel issues). Download now? This run continues on system Python — no interruption.',
```

- [ ] **Step 2: App.tsx 订阅推送**

在既有 `onShellMenuAction` effect(约 130-146 行)之后加一个新 effect;顶部 import 区补 `import { promptComponent, useComponentPromptStore } from './stores/componentPrompt'`(该文件若已 import 其一则合并):

```ts
  // P1c 触发器的渲染端:main 侦听到「AI 正在做 PPT 且 python 未就绪」时经 COMPONENT_PROMPT
  // 推组件 id,这里开渐进弹窗。dismissed 复核是第二重防骚扰(main 侧 fire-once 是第一重):
  // 用户对同一组件点过[暂不]后,即便换了个 tab 的 engine 再推,本渲染进程也不再弹。
  useEffect(() => {
    if (!window.chatApi?.onComponentPrompt) return
    return window.chatApi.onComponentPrompt((id) => {
      if (!useComponentPromptStore.getState().isDismissed(id)) promptComponent(id)
    })
  }, [])
```

- [ ] **Step 3: ComponentPrompt.tsx 三处**

a) `TITLE_KEY` 表加一行:

```ts
  'python-runtime': 'compPythonTitle',
```

b) `TITLE_KEY` 表下方加正文分岔表(带注释):

```ts
// idle 态邀请正文的 per-id 覆盖(仅 python):它的触发场景是「AI 正在做 PPT」,通用的
// compPromptBody(「这个功能需要 X」)说不清「本次不等你、系统 Python 照跑」这层诚实,
// 单独给一句。其余组件继续走通用键。
const BODY_KEY: Record<string, StringKey> = {
  'python-runtime': 'compPromptBodyPython',
}
```

c) idle/error 分支的正文行(现为 `tFormat(state.status === 'error' ? 'compPromptErrorBody' : 'compPromptBody', { title })`)改为:

```tsx
              {tFormat(state.status === 'error' ? 'compPromptErrorBody' : (BODY_KEY[openFor] ?? 'compPromptBody'), { title })}
```

- [ ] **Step 4: ComponentsSection.tsx 两处**

a) `ROWS` 追加(soffice 行后;python 无 guideUrl——它 hosted-files 策略,永不落 unavailable):

```ts
  // python-runtime(P1c):hosted-files/archive 策略,状态机与 embed 同款。linux 等未支持平台
  // 上名册不注册此卡→整表无此格→本行兜底渲染成 idle 死按钮,但正式包只发 mac/win,不处理。
  { id: 'python-runtime', titleKey: 'compPythonTitle', descKey: 'compPythonDesc' },
```

b) `RowAction` 的 ready 分支(现为单行 `✓ {t('compReady')}`)改为:

```tsx
  if (state.status === 'ready') {
    return (
      <span className="text-[12px] font-medium text-emerald-600 dark:text-emerald-400">
        ✓ {t('compReady')}
        {/* 「随包」来源注记(P1c):就绪是靠随包/dev 目录里的现成 runtime 判的(userData 无下载
            副本)时,补一个灰字标签——P1b 预留的 compBundled 死键就此转正。只有 python 的就绪
            探针会写 origin='bundled'(componentOrchestrator READY_PROBES)。 */}
        {state.origin === 'bundled' && (
          <span className="ml-1.5 font-normal text-muted-foreground/70">{t('compBundled')}</span>
        )}
      </span>
    )
  }
```

- [ ] **Step 5: 门**

Run: `cd apps/studio && bun run typecheck && bun test electron/`
Expected: 全 PASS(compBundled 死键从此有主,i18n 无新死键——compPythonTitle/Desc/BodyPython 三键均有消费)

- [ ] **Step 6: Commit**

```bash
git add apps/studio/src/chat/App.tsx apps/studio/src/chat/components/ComponentPrompt.tsx apps/studio/src/chat/components/settings/ComponentsSection.tsx apps/studio/src/chat/i18n.ts
git commit -m "feat(component-download): 渲染层接 COMPONENT_PROMPT,python 行/文案/随包灰字"
```

---

### Task 6: pendingCategory 定位 + [查看下载详情] 直达 + toast 6s

**Files:**
- Modify: `apps/studio/src/chat/stores/settings.ts`
- Modify: `apps/studio/src/chat/components/settings/SettingsView.tsx`(只动 SettingsBody 的 activeCategory 初始化与消费 effect)
- Modify: `apps/studio/src/chat/components/ComponentPrompt.tsx`(goDetails 传分类 + 订正过时注释)
- Modify: `apps/studio/src/chat/stores/toast.ts`(4000 → 6000)

**Interfaces:**
- Produces: `useSettingsStore` 新契约:`openSettings(category?: string)`、`pendingCategory: string | null`、`clearPendingCategory()`。Task 7 的 `open-components` 动作消费同一契约。
- 既有无参调用 `openSettings()` 全仓不需改(参数可选、语义不变)。

- [ ] **Step 1: settings store 加 pendingCategory**

`stores/settings.ts` 整体改为:

```ts
import { create } from 'zustand'

/**
 * Settings view visibility + 一次性的目标分类。
 * pendingCategory(P1c):打开设置页时想直达的分类 id(如 'components')。SettingsBody 的
 * activeCategory 是组件内 local state(头注释:nothing outside it cares)——外部唯一的定位
 * 通道就是这个「便签」:openSettings('components') 写下,SettingsBody 挂载/变化时读走并清空。
 * 为什么不直接把 activeCategory 提升进 store:全仓只有「打开时定位一次」这一个外部诉求,
 * 提升整个分类状态会让每次点分类都走 store、扩大耦合面(Task 9 评审记录里的非侵入修法)。
 * 类型用 string 而非 CategoryId:store 反向 import 视图组件的类型会引环,消费端窄化。
 */
interface SettingsState {
  open: boolean
  pendingCategory: string | null
  openSettings: (category?: string) => void
  closeSettings: () => void
  clearPendingCategory: () => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  open: false,
  pendingCategory: null,
  openSettings: (category) => set({ open: true, pendingCategory: category ?? null }),
  closeSettings: () => set({ open: false }),
  clearPendingCategory: () => set({ pendingCategory: null })
}))
```

- [ ] **Step 2: SettingsBody 消费便签**

`SettingsView.tsx` 的 `SettingsBody`(约 79-82 行)改 activeCategory 初始化并加消费 effect(文件顶部若未 import `useSettingsStore` 则补;`useEffect` 已在 React import 里则复用):

```tsx
export function SettingsBody(): React.JSX.Element {
  const t = useT()
  // 初始值先读一次便签:SettingsBody 随 open 翻真才挂载,「关着→带分类打开」走这里,零闪跳。
  const [activeCategory, setActiveCategory] = useState<CategoryId>(
    () => (useSettingsStore.getState().pendingCategory as CategoryId | null) ?? 'appearance'
  )
  // 「已经开着→又收到定位请求」(弹窗[查看下载详情]在设置页开着时被点)走这里:订阅便签,
  // 变了就切分类并清空。挂载后首轮也会跑一次,顺手把初始化读走的那张便签清掉。
  const pendingCategory = useSettingsStore((s) => s.pendingCategory)
  useEffect(() => {
    if (pendingCategory) {
      setActiveCategory(pendingCategory as CategoryId)
      useSettingsStore.getState().clearPendingCategory()
    }
  }, [pendingCategory])
```

(`as CategoryId` 窄化的安全性:写入方只有 'components' 一个字面量(本任务 + Task 7),真传了未知 id 也只是渲染 PlaceholderSection,不炸。)

- [ ] **Step 3: ComponentPrompt goDetails 传分类 + 订正注释**

`ComponentPrompt.tsx`:

a) `goDetails` 改为:

```ts
  const goDetails = (): void => { openSettingsPage('components') /* 保留弹窗,用户可在两处看进度 */ }
```

b) 把 `openSettingsPage` 声明上方那段「useSettingsStore 实际只有布尔 open 态 + 无参 openSettings()…不定位到分类…超出本任务范围」的核实注释块**整段替换**为:

```ts
  // 「查看下载详情」直达「组件/扩展」分类(P1c 补齐):Task 9 时代 useSettingsStore 只有无参
  // openSettings()、activeCategory 是 SettingsBody 的 local state,按钮只能开到设置页首屏
  // (当时评审裁定超范围、记录在案)。现在走 pendingCategory 便签(stores/settings.ts):
  // openSettings('components') 写下目标,SettingsBody 挂载/变化时消费定位。
  const openSettingsPage = useSettingsStore((s) => s.openSettings)
```

- [ ] **Step 4: toast 6s**

`stores/toast.ts` 的 `const DURATION_MS = 4000` 改为:

```ts
// 6s(P1c 从 4s 加长):实机验证时用户切页错过 4s 的报喜 toast(2026-07-17 台账),报喜类
// 消息读完需要的窗口比确认类长。
const DURATION_MS = 6000
```

- [ ] **Step 5: 门**

Run: `cd apps/studio && bun run typecheck && bun test electron/`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add apps/studio/src/chat/stores/settings.ts apps/studio/src/chat/components/settings/SettingsView.tsx apps/studio/src/chat/components/ComponentPrompt.tsx apps/studio/src/chat/stores/toast.ts
git commit -m "feat(component-download): 设置页 pendingCategory 定位,[查看下载详情]直达分类,toast 6s"
```

---

### Task 7: 组件中心正常入口(rail 新行 → open-components 菜单动作)

**Files:**
- Modify: `apps/studio/electron/shared/ipc-channels.ts`(`ShellMenuAction` 联合,约 1434 行)
- Modify: `apps/studio/electron/main/ipc/register.ts`(白名单,约 1618 行)
- Modify: `apps/studio/src/chat/App.tsx`(菜单动作分支,约 133 行)
- Modify: `apps/studio/src/chat/components/tabs/TabBar.tsx`(新 NavActionRow + 图标)

**Interfaces:**
- Consumes: Task 6 的 `openSettings('components')`;既有 `window.tabApi.triggerMenuAction` / `dispatchMenuActionToActiveTab` 转发链(shell rail → main → active chat tab,web tab 静默跳过——与 open-search 同款、同限制)。
- Produces: `ShellMenuAction` 新成员 `'open-components'`。

- [ ] **Step 1: 联合类型加成员**

`ipc-channels.ts` 的 `ShellMenuAction`(约 1434 行)在 `'open-search'` 成员后加:

```ts
  // 打开应用内设置页并直达「组件/扩展」分类(P1c 补入口)。此前该设置页(含组件中心)在正常
  // UI 里不可达:rail/TabBar/UserInfoBar 的「设置」都开 web 版设置,监听 open-settings 的
  // in-chat SettingsView 全仓零发送方(历史菜单搬迁只接了 open-search),唯一活入口是缺组件
  // 弹窗——组件全齐时死循环。python 接入后组件中心承载 4 个组件,必须有正门。
  | 'open-components'
```

- [ ] **Step 2: register.ts 白名单放行**

`TAB_TRIGGER_MENU_ACTION` handler(约 1616-1622 行)的条件加一行:

```ts
      if (
        action !== 'open-settings' &&
        action !== 'open-logs' &&
        action !== 'toggle-lang' &&
        action !== 'open-search' &&
        action !== 'open-components'
      ) {
        return
      }
```

- [ ] **Step 3: App.tsx 动作分支**

`onShellMenuAction` effect(约 133 行)里 `open-settings` 分支后加:

```ts
      } else if (action === 'open-components') {
        // 同 open-settings 但直达「组件/扩展」分类(pendingCategory 便签,见 stores/settings.ts)
        useSettingsStore.getState().openSettings('components')
```

- [ ] **Step 4: TabBar 新行**

`TabBar.tsx` 在「设置」`NavActionRow`(约 127-131 行)之后、「搜索对话」行之前加(标签硬编码中文,与同文件「设置」「搜索对话」现状一致——rail 属 shell 渲染进程,不在 chat 的 i18n 体系里):

```tsx
      <NavActionRow
        label="组件与扩展"
        icon={<PuzzleGlyph />}
        onClick={() => void window.tabApi?.triggerMenuAction('open-components')}
      />
```

文件底部 glyph 区(GearGlyph 附近)加:

```tsx
function PuzzleGlyph(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
      <path
        d="M10 4.5A1.5 1.5 0 0 1 11.5 3h1A1.5 1.5 0 0 1 14 4.5V6h3a1 1 0 0 1 1 1v3h1.5a1.5 1.5 0 0 1 0 3H18v3a1 1 0 0 1-1 1h-3v-1.5a1.5 1.5 0 0 0-3 0V17H8a1 1 0 0 1-1-1v-3H5.5a1.5 1.5 0 0 1 0-3H7V7a1 1 0 0 1 1-1h2V4.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}
```

- [ ] **Step 5: 门**

Run: `cd apps/studio && bun run typecheck && bun test electron/`
Expected: 全 PASS(联合类型加成员后,App.tsx 的 handler 参数与 register.ts 白名单靠 typecheck 互锁)

- [ ] **Step 6: Commit**

```bash
git add apps/studio/electron/shared/ipc-channels.ts apps/studio/electron/main/ipc/register.ts apps/studio/src/chat/App.tsx apps/studio/src/chat/components/tabs/TabBar.tsx
git commit -m "feat(component-download): rail 加「组件与扩展」入口,open-components 直达组件分类"
```

---

### Task 8: CI / 打包退场(最后拆桥)

**Files:**
- Modify: `.github/workflows/build.yml`
- Modify: `apps/studio/package.json`

**Interfaces:**
- Consumes: Task 2 的名册档案卡已是版本钉唯一事实源;Task 3 的 `resolveBundledPythonHome()` resourcesPath 候选保留(拆包后落空、纯防御)。
- 前置确认:Task 1–7 已全部合入且门全绿(本任务是「单轨切换”的拆桥步,放最后是刻意的)。

- [ ] **Step 1: build.yml 删四处**

a) env 块(约 21-29 行):删 `PYTHON_STANDALONE_TAG: '20260510'` 与 `PYTHON_STANDALONE_VERSION: '3.12.13'` 两行,及其上方专讲 python 钉版的注释行(约 21 行「skill with native-extension deps: PyMuPDF/Pillow/numpy). python-build-」所属的那段注释中**只涉及 python 的句子**;若注释整段只讲 python 则整段删)。

b) matrix 三处 `python_dist:` 行(约 56/72/80 行:`aarch64-apple-darwin` / `x86_64-apple-darwin` / `x86_64-pc-windows-msvc`)。约 64 行注释「node/python dists are x64 variants」改为只提 node(`# node dist is the x64 variant`)。

c) 「Bundle Python runtime」整步(约 230-270 行):从它上方紧邻的 `# python-build-standalone install_only tarballs are relocatable …` 注释块开始,到该步结尾的版本断言 `exit 1` 的 `fi` 为止,整块删除。(注释精华——install_only 布局、strip、3.12 wheel 理由——Task 2 已搬进名册,不丢失。)

d) 收尾自查:

Run: `grep -n 'python' .github/workflows/build.yml`
Expected: 只剩与本搬迁无关的命中——约 146 行 `python -c "import json; …"`(校验 env.json 的 CI 自身脚本)与约 554/606 行 `python3 - <<'PY'`(release 脚本),**零** `python_dist` / `PYTHON_STANDALONE` / `Bundle Python` 残留。

- [ ] **Step 2: package.json 删两条 extraResources**

`apps/studio/package.json`:mac 段删(约 96-99 行):

```json
        {
          "from": "python-runtime/mac",
          "to": "python-runtime"
        }
```

win 段删(约 129-132 行):

```json
        {
          "from": "python-runtime/win",
          "to": "python-runtime"
        }
```

注意各自前一条目末尾的逗号要相应收拾(删的是数组最后一项则去掉前项尾逗号)。

- [ ] **Step 3: 语法与门**

Run: `cd apps/studio && bun -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('json ok')" && bun run typecheck`
Expected: `json ok` + typecheck 绿。
Run: `git diff --stat`
Expected: 仅 `.github/workflows/build.yml` 与 `apps/studio/package.json` 两个文件(工作区脏文件不计)。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/build.yml apps/studio/package.json
git commit -m "chore(ci): python-runtime 停止随包——Bundle 步/matrix/extraResources 退役,版本钉归名册"
```

---

## 计划级验收(全部任务完成后,总控核对)

- `cd apps/studio && bun run typecheck` EXIT=0(双 tsc)+ `bun test electron/` 全绿(≥479 pass + 新增,0 fail)。
- 零改动清单核对:`git diff <task1-base>..HEAD -- apps/studio/electron/main/services/componentInstaller/hostedFilesInstaller.ts apps/studio/electron/main/services/componentInstaller/downloadUnit.ts skills/ppt-master/bin/ensure-python.sh` 为空;`engine.ts` 的 diff 只含 Task 4 的四处(import/字段/方法/一行调用)。
- `grep -rn 'compBundled' apps/studio/src/` 至少一处消费(死键转正)。
- 运行时验证(留用户实机,子代理不做):①聊天里让 AI 做一次 PPT → 弹窗出现、当次 PPT 系统 python 照跑;②下载 → 组件中心进度 → 新会话做 PPT 用上 `userData/components/python-runtime`(dev 日志 `pythonHome` 字段可证);③rail「组件与扩展」一键直达;④[查看下载详情] 直达分类;⑤dev 机(仓内有随包 python 时)显示「随包」灰字且不弹提醒;⑥下次 CI tag 打包核实安装包小 ≈24MB(mac)。
