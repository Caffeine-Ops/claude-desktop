# 知识库远程同步（方案 A）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 服务器集中构建知识库镜像制品，客户端按 manifest 增量拉取到 `userData/kb-index/`，运行时读路径零改动；多团队多 KB 留口子（本期单 KB，kbId 恒 `default`）。

**Architecture:** 新增 manifest 发布脚本（服务器侧）+ 客户端同步引擎 `kbSync.ts`（electron-free、依赖注入、bun test 全覆盖）+ 调度器/IPC/设置 UI 三层薄封装。同步引擎只是 `kb-index/` 目录的另一个生产者——所有现有读方（proposalScopes、engine 提示词、权限放行、kbasset）经 `kbOutDir()` 无感。

**Tech Stack:** TypeScript（composite 工程 node+web）、Electron main、bun test、node:crypto sha1、全局 fetch（Electron ≥22 自带）。

**Spec:** `docs/superpowers/specs/2026-07-03-kb-remote-sync-design.md`（改动前先读一遍，尤其「详细设计」与「错误处理汇总」）。

## Global Constraints

- 包管理器是 **bun**，不是 npm；测试命令 `cd apps/desktop && bun test src/`，质量门 `bun run typecheck`（仓库根）。
- **加一条 IPC 四处同改**：`src/shared/ipc-channels.ts` → `src/preload/index.ts` → `src/preload/index.d.ts` → `src/main/ipc/register.ts`。
- 主进程可测模块**顶层不许 import electron**（先例：`skillsDir.ts`、`kbAssetProtocol.ts` 动态导入）；electron 依赖走参数注入或 lazy import。
- `src/shared/` 同时编进 node 和 web 两个 tsconfig——**shared 里不许 import node:fs 等 Node 模块**（纯字符串/JSON 逻辑可以）。
- 脚本内**不许调 `Date.now()`**（与 build-kb-index.ts 同规矩，时间戳经 `--now` 传入）；同步引擎经 `nowMs` 依赖注入。
- 注释解释「为什么这样而不是那样」，沿用仓库高密度注释风格。
- 本期 kbId 恒为 `"default"`，但协议/配置/URL 从第一天带 kbId 字段（spec「扩展口子」节）。
- 快照/契约测试（proposalPrompt.snapshot.test.ts 等）必须保持全绿——本计划任何任务都不碰提示词。

---

### Task 1: shared 层 manifest 协议——类型、防御解析、路径/URL 纯函数

**Files:**
- Create: `apps/desktop/src/shared/kbManifest.ts`
- Test: `apps/desktop/src/shared/kbManifest.test.ts`

**Interfaces:**
- Consumes: 无（叶子模块，零依赖）
- Produces（后续 Task 2/4/5/7 都要用，签名逐字照抄）:
  - `interface KbManifestFile { path: string; sha1: string; size: number }`
  - `interface KbManifest { schemaVersion: 1; kbId: string; name: string; builtAtMs: number; files: KbManifestFile[] }`
  - `function parseKbManifest(raw: unknown): KbManifest | null`
  - `function manifestPathToPlatform(p: string): string`
  - `function kbManifestUrl(baseUrl: string, kbId: string): string`
  - `function kbFileUrl(baseUrl: string, kbId: string, posixPath: string): string`

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/shared/kbManifest.test.ts`：

```ts
import { describe, it, expect } from 'bun:test'
import {
  parseKbManifest,
  manifestPathToPlatform,
  kbManifestUrl,
  kbFileUrl
} from './kbManifest'

const good = {
  schemaVersion: 1,
  kbId: 'default',
  name: '福鑫数科产品线资料库',
  builtAtMs: 1751500000000,
  files: [
    { path: 'index.json', sha1: 'a'.repeat(40), size: 10 },
    { path: '01AI患者服务/1_智能导诊系统/方案.docx.md', sha1: 'b'.repeat(40), size: 20 },
    { path: 'assets/01AI患者服务/1_智能导诊系统/方案.docx/img-1.png', sha1: 'c'.repeat(40), size: 30 }
  ]
}

describe('parseKbManifest', () => {
  it('良构 manifest → 原样返回', () => {
    expect(parseKbManifest(good)).toEqual(good)
  })
  it('null / 非对象 / 缺字段 → null', () => {
    expect(parseKbManifest(null)).toBeNull()
    expect(parseKbManifest('{}')).toBeNull()
    expect(parseKbManifest({ ...good, files: undefined })).toBeNull()
  })
  it('schemaVersion 不是 1 → null（未来版本不认识就拒收）', () => {
    expect(parseKbManifest({ ...good, schemaVersion: 2 })).toBeNull()
  })
  it('files 里混入坏条目（缺 sha1 / size 非数）→ null', () => {
    expect(parseKbManifest({ ...good, files: [{ path: 'x.md', size: 1 }] })).toBeNull()
    expect(parseKbManifest({ ...good, files: [{ path: 'x.md', sha1: 'a', size: '1' }] })).toBeNull()
  })
  it('路径逃逸（.. 段 / 绝对路径 / 反斜杠 / 空段）→ null，整份拒收', () => {
    for (const path of ['../etc/passwd', 'a/../../b.md', '/etc/passwd', 'a\\b.md', 'a//b.md', '']) {
      expect(parseKbManifest({ ...good, files: [{ path, sha1: 'a'.repeat(40), size: 1 }] })).toBeNull()
    }
  })
})

describe('路径与 URL 纯函数', () => {
  it('manifestPathToPlatform 在 posix 平台原样返回', () => {
    // darwin/linux 上 sep === '/'，转换是恒等；win32 行为由 sep 参与，无法在 mac 上直接断言，
    // 但实现必须走 split('/').join(sep)（评审关注点：Windows 分隔符坑）。
    expect(manifestPathToPlatform('a/b/c.md')).toBe(['a', 'b', 'c.md'].join(require('node:path').sep))
  })
  it('kbManifestUrl 拼接并容忍 baseUrl 尾斜杠', () => {
    expect(kbManifestUrl('http://10.0.0.5:8080', 'default')).toBe('http://10.0.0.5:8080/kb/default/manifest.json')
    expect(kbManifestUrl('http://10.0.0.5:8080/', 'default')).toBe('http://10.0.0.5:8080/kb/default/manifest.json')
  })
  it('kbFileUrl 逐段 encodeURIComponent（中文/空格），保留段间 /', () => {
    expect(kbFileUrl('http://h', 'default', '01AI患者服务/a b/方案.docx.md')).toBe(
      `http://h/kb/default/${encodeURIComponent('01AI患者服务')}/${encodeURIComponent('a b')}/${encodeURIComponent('方案.docx.md')}`
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test src/shared/kbManifest.test.ts`
Expected: FAIL（Cannot find module './kbManifest'）

- [ ] **Step 3: Write minimal implementation**

`apps/desktop/src/shared/kbManifest.ts`（**只用 node:path 的 sep——path 是 preload 也可用的例外？不，shared 进 web tsconfig，node:path 不可 import**。改用手写常量：见下）：

```ts
/**
 * 知识库远程同步的 manifest 协议（shared：main / preload / scripts 三方共用）。
 *
 * 为什么 path 处理不 import node:path：本文件编进 web tsconfig（renderer 也可能
 * 引用类型），不许出现 Node 模块。平台分隔符由调用方注入（main 侧传 path.sep），
 * 保持本模块纯字符串逻辑、bun test 直测无环境依赖。
 *
 * 安全约定：路径逃逸（.. 段、绝对路径、反斜杠、空段）在 parse 期整份拒收——
 * 让「恶意/损坏 manifest 中止整轮同步」在最早的关口生效（spec 错误处理表），
 * 引擎侧 isPathInsideRoot 只是纵深防御的第二道。
 */

export interface KbManifestFile {
  /** 相对制品根的 POSIX 路径（与 build-kb-index 的 relPath 同源） */
  path: string
  sha1: string
  size: number
}

export interface KbManifest {
  schemaVersion: 1
  kbId: string
  name: string
  builtAtMs: number
  files: KbManifestFile[]
}

/** 单条相对路径是否安全：非空、无 .. 段、非绝对、不含反斜杠与空段。 */
function isSafeRelPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p.startsWith('/') || p.includes('\\')) return false
  const segs = p.split('/')
  return segs.every((s) => s.length > 0 && s !== '..' && s !== '.')
}

export function parseKbManifest(raw: unknown): KbManifest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (m.schemaVersion !== 1) return null
  if (typeof m.kbId !== 'string' || m.kbId.length === 0) return null
  if (typeof m.name !== 'string') return null
  if (typeof m.builtAtMs !== 'number') return null
  if (!Array.isArray(m.files)) return null
  for (const f of m.files) {
    if (typeof f !== 'object' || f === null) return null
    const e = f as Record<string, unknown>
    if (!isSafeRelPath(e.path)) return null
    if (typeof e.sha1 !== 'string' || e.sha1.length === 0) return null
    if (typeof e.size !== 'number' || !Number.isFinite(e.size) || e.size < 0) return null
  }
  return raw as KbManifest
}

/**
 * POSIX manifest path → 平台路径。sep 参数化（默认 '/'）：main 侧传 node:path 的
 * sep；测试与 web 侧零 Node 依赖。
 */
export function manifestPathToPlatform(p: string, sep: string = '/'): string {
  return p.split('/').join(sep)
}

function trimTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

export function kbManifestUrl(baseUrl: string, kbId: string): string {
  return `${trimTrailingSlash(baseUrl)}/kb/${encodeURIComponent(kbId)}/manifest.json`
}

/** 逐段 encodeURIComponent——路径全中文，整串 encode 会把 / 也吃掉。 */
export function kbFileUrl(baseUrl: string, kbId: string, posixPath: string): string {
  const encoded = posixPath.split('/').map(encodeURIComponent).join('/')
  return `${trimTrailingSlash(baseUrl)}/kb/${encodeURIComponent(kbId)}/${encoded}`
}
```

**注意**：实现里 `manifestPathToPlatform` 带了 `sep` 参数（默认 `'/'`），Step 1 测试相应写成：

```ts
  it('manifestPathToPlatform 按注入 sep 转换', () => {
    expect(manifestPathToPlatform('a/b/c.md', '\\')).toBe('a\\b\\c.md')
    expect(manifestPathToPlatform('a/b/c.md')).toBe('a/b/c.md')
  })
```

（把 Step 1 里那条 `require('node:path')` 的测试**替换**为上面这条——shared 测试同样不该碰 node:path。）

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && bun test src/shared/kbManifest.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/kbManifest.ts apps/desktop/src/shared/kbManifest.test.ts
git commit -m "feat(kb-sync): manifest 协议 shared 层——防御解析含逃逸拒收 + 路径/URL 纯函数"
```

---

### Task 2: 服务器侧 manifest 发布脚本

**Files:**
- Create: `scripts/kb-index/manifest.ts`
- Create: `scripts/publish-kb-manifest.ts`
- Test: `scripts/kb-index/manifest.test.ts`
- Modify: `.github/workflows/build.yml`（typecheck/test 步骤处追加 `bun test scripts/`）
- Modify: `package.json`（根，scripts 加 `"kb:manifest": "bun scripts/publish-kb-manifest.ts"`）

**Interfaces:**
- Consumes: Task 1 的 `KbManifest` / `KbManifestFile` 类型（`import type ... from '../apps/desktop/src/shared/kbManifest.ts'`，先例：build-kb-index.ts 就这样 import shared/kbIndex.ts）
- Produces: `function buildKbManifestFiles(rootDir: string): KbManifestFile[]`（walk + sha1，POSIX 路径、按 path 字典序稳定排序）；CLI `bun scripts/publish-kb-manifest.ts --dir <制品目录> --kb-id default --name <名> --now <ms>` 在 `<dir>/manifest.json` 原子落盘

- [ ] **Step 1: Write the failing test**

`scripts/kb-index/manifest.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { buildKbManifestFiles } from './manifest.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kb-manifest-'))
  mkdirSync(join(dir, '01产品线/1_产品/assets'), { recursive: true })
  writeFileSync(join(dir, 'index.json'), '{"v":1}')
  writeFileSync(join(dir, '01产品线/1_产品/方案.docx.md'), '正文')
  writeFileSync(join(dir, '01产品线/1_产品/assets/img-1.png'), Buffer.from([1, 2, 3]))
  // 应被跳过的四类
  writeFileSync(join(dir, 'manifest.json'), '{}')
  writeFileSync(join(dir, '.DS_Store'), '')
  writeFileSync(join(dir, '半截下载.md.part'), '')
  mkdirSync(join(dir, '.tmp'))
  writeFileSync(join(dir, '.tmp/soffice-中转.txt'), '')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('buildKbManifestFiles', () => {
  it('收录普通文件、路径为 POSIX、sha1/size 正确、按 path 排序', () => {
    const files = buildKbManifestFiles(dir)
    expect(files.map((f) => f.path)).toEqual([
      '01产品线/1_产品/assets/img-1.png',
      '01产品线/1_产品/方案.docx.md',
      'index.json'
    ])
    const img = files[0]!
    expect(img.size).toBe(3)
    expect(img.sha1).toBe(createHash('sha1').update(Buffer.from([1, 2, 3])).digest('hex'))
  })
  it('跳过 manifest.json / 点开头文件与目录 / *.part', () => {
    const paths = buildKbManifestFiles(dir).map((f) => f.path)
    expect(paths.some((p) => p.includes('manifest.json'))).toBe(false)
    expect(paths.some((p) => p.includes('.DS_Store'))).toBe(false)
    expect(paths.some((p) => p.endsWith('.part'))).toBe(false)
    expect(paths.some((p) => p.includes('.tmp'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/kb-index/manifest.test.ts`（仓库根）
Expected: FAIL（Cannot find module './manifest.ts'）

- [ ] **Step 3: Write implementation**

`scripts/kb-index/manifest.ts`：

```ts
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import type { KbManifestFile } from '../../apps/desktop/src/shared/kbManifest.ts'

/**
 * 遍历制品目录产出 manifest 文件清单。跳过：manifest.json 本身（先有鸡后有蛋）、
 * 一切点开头文件/目录（.DS_Store、.tmp 中转目录、备份 dotfile）、*.part（同步半成品）。
 * 路径统一 POSIX、按字典序排序——同一目录两次构建产出 byte 一致的 manifest，
 * 客户端才能拿 sha1 做稳定 diff。
 */
export function buildKbManifestFiles(rootDir: string): KbManifestFile[] {
  const out: KbManifestFile[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name.endsWith('.part')) continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      const rel = relative(rootDir, full).split('\\').join('/')
      if (rel === 'manifest.json') continue
      out.push({
        path: rel,
        sha1: createHash('sha1').update(readFileSync(full)).digest('hex'),
        size: st.size
      })
    }
  }
  walk(rootDir)
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}
```

`scripts/publish-kb-manifest.ts`：

```ts
import { writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildKbManifestFiles } from './kb-index/manifest.ts'
import type { KbManifest } from '../apps/desktop/src/shared/kbManifest.ts'

// 与 build-kb-index.ts 同款的极简 argv 解析——不引依赖。
function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!
  throw new Error(`缺少参数 --${name}`)
}

const dir = arg('dir')
const kbId = arg('kb-id')
const name = arg('name')
const builtAtMs = Number(arg('now')) // 同 build 脚本规矩：时间戳外部传入，脚本不调 Date.now
if (!Number.isFinite(builtAtMs)) throw new Error('--now 必须是毫秒时间戳')
if (!existsSync(join(dir, 'index.json')))
  throw new Error(`${dir} 下没有 index.json——先跑 build-kb-index 再发布 manifest`)

const manifest: KbManifest = {
  schemaVersion: 1,
  kbId,
  name,
  builtAtMs,
  files: buildKbManifestFiles(dir)
}
// tmp+rename 原子落盘：客户端任何时刻读到的 manifest 都是完整 JSON，绝不半截。
// tmp 名点开头，walk 的 dotfile 跳过规则顺带保证它永远不会被收进下一份 manifest。
const tmp = join(dir, '.manifest.json.tmp')
writeFileSync(tmp, JSON.stringify(manifest), 'utf8')
renameSync(tmp, join(dir, 'manifest.json'))
console.log(`manifest.json → ${join(dir, 'manifest.json')}（${manifest.files.length} 文件）`)
```

根 `package.json` scripts 追加（与 `kb:index` 相邻）：

```json
"kb:manifest": "bun scripts/publish-kb-manifest.ts"
```

`.github/workflows/build.yml`：找到跑 desktop bun test 的 step（commit 4573ad7c 加的），紧随其后加一行 `bun test scripts/`（工作目录=仓库根）。

- [ ] **Step 4: Run tests**

Run: `bun test scripts/` 然后手工冒烟：
```bash
bun scripts/publish-kb-manifest.ts --dir "$HOME/Library/Application Support/@claude-desktop/desktop/kb-index" --kb-id default --name "福鑫数科产品线资料库" --now "$(date +%s)000"
python3 -c "import json;m=json.load(open('$HOME/Library/Application Support/@claude-desktop/desktop/kb-index/manifest.json'));print(m['kbId'],len(m['files']))"
```
Expected: 测试 PASS；冒烟输出 `default` + 约 290+ 的文件数（含 assets）。

- [ ] **Step 5: Commit**

```bash
git add scripts/kb-index/manifest.ts scripts/kb-index/manifest.test.ts scripts/publish-kb-manifest.ts package.json .github/workflows/build.yml
git commit -m "feat(kb-sync): manifest 发布脚本——walk+sha1 稳定清单、tmp+rename 原子落盘、CI 补 scripts 测试"
```

---

### Task 3: 客户端配置模型扩展（remote 字段 + 防御解析 + setKbRoot 合并修复）

**Files:**
- Create: `apps/desktop/src/shared/kbConfig.ts`
- Test: `apps/desktop/src/shared/kbConfig.test.ts`
- Modify: `apps/desktop/src/main/core/kbIndexStore.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface KbRemoteConfig { baseUrl: string; kbId: string }`
  - `interface KbConfig { kbRoot: string | null; remote: KbRemoteConfig | null }`
  - `function parseKbConfig(raw: string | null): KbConfig`（shared 纯函数）
  - kbIndexStore 新增：`getKbConfig(): KbConfig`、`setKbRemote(remote: KbRemoteConfig | null): void`；现有 `getKbRoot()/setKbRoot()` 语义不变但 **setKbRoot 改为读-合并-写**（当前实现整文件覆盖会把 remote 抹掉）

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/shared/kbConfig.test.ts`：

```ts
import { describe, it, expect } from 'bun:test'
import { parseKbConfig } from './kbConfig'

describe('parseKbConfig', () => {
  it('老格式 {kbRoot} 向后兼容，remote 为 null', () => {
    expect(parseKbConfig('{"kbRoot":"/a/b"}')).toEqual({ kbRoot: '/a/b', remote: null })
  })
  it('新格式带 remote', () => {
    expect(parseKbConfig('{"kbRoot":"/a","remote":{"baseUrl":"http://h:8080","kbId":"default"}}')).toEqual({
      kbRoot: '/a',
      remote: { baseUrl: 'http://h:8080', kbId: 'default' }
    })
  })
  it('null / 损坏 JSON / 非对象 → 全空配置', () => {
    const empty = { kbRoot: null, remote: null }
    expect(parseKbConfig(null)).toEqual(empty)
    expect(parseKbConfig('{oops')).toEqual(empty)
    expect(parseKbConfig('"str"')).toEqual(empty)
  })
  it('remote 字段残缺（缺 kbId / baseUrl 非串）→ remote 当 null，不连坐 kbRoot', () => {
    expect(parseKbConfig('{"kbRoot":"/a","remote":{"baseUrl":"http://h"}}')).toEqual({ kbRoot: '/a', remote: null })
    expect(parseKbConfig('{"remote":{"baseUrl":1,"kbId":"d"}}')).toEqual({ kbRoot: null, remote: null })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test src/shared/kbConfig.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write implementation**

`apps/desktop/src/shared/kbConfig.ts`：

```ts
/**
 * kb-config.json 的解析（shared 纯函数，kbIndexStore 负责读写文件）。
 * 防御解析延续 kbIndexStore 既有哲学：任何残缺都退安全默认值，绝不抛——
 * 配置文件损坏的代价只能是「回到未配置状态」，不能是应用起不来。
 * remote 残缺时只废 remote 不连坐 kbRoot：两个字段语义独立。
 */
export interface KbRemoteConfig {
  baseUrl: string
  /** 本期恒 "default"；多团队多 KB 的口子（spec 扩展口子 #3） */
  kbId: string
}

export interface KbConfig {
  kbRoot: string | null
  remote: KbRemoteConfig | null
}

export function parseKbConfig(raw: string | null): KbConfig {
  const empty: KbConfig = { kbRoot: null, remote: null }
  if (!raw) return empty
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return empty
  }
  if (typeof obj !== 'object' || obj === null) return empty
  const o = obj as Record<string, unknown>
  const kbRoot = typeof o.kbRoot === 'string' && o.kbRoot.length > 0 ? o.kbRoot : null
  let remote: KbRemoteConfig | null = null
  if (typeof o.remote === 'object' && o.remote !== null) {
    const r = o.remote as Record<string, unknown>
    if (typeof r.baseUrl === 'string' && r.baseUrl.length > 0 && typeof r.kbId === 'string' && r.kbId.length > 0) {
      remote = { baseUrl: r.baseUrl, kbId: r.kbId }
    }
  }
  return { kbRoot, remote }
}
```

`kbIndexStore.ts` 改造（保留现有注释风格，getKbRoot 改为经 getKbConfig 实现）：

```ts
import type { KbConfig, KbRemoteConfig } from '../../shared/kbConfig'
import { parseKbConfig } from '../../shared/kbConfig'

/** 读整份 KB 配置。文件缺失/损坏 → 全空配置（防御哲学见 parseKbConfig）。 */
export function getKbConfig(): KbConfig {
  const p = configPath()
  return parseKbConfig(existsSync(p) ? readFileSync(p, 'utf8') : null)
}

export function getKbRoot(): string | null {
  return getKbConfig().kbRoot
}

/**
 * 读-合并-写：早期实现整文件覆盖 {kbRoot}，remote 字段加入后那样写会把远程配置
 * 静默抹掉（用户改一次本地路径 = 断开服务器），必须合并。setKbRemote 同理。
 */
export function setKbRoot(kbRoot: string): void {
  const cur = getKbConfig()
  writeFileSync(configPath(), JSON.stringify({ ...cur, kbRoot }), 'utf8')
}

export function setKbRemote(remote: KbRemoteConfig | null): void {
  const cur = getKbConfig()
  writeFileSync(configPath(), JSON.stringify({ ...cur, remote }), 'utf8')
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/desktop && bun test src/shared/kbConfig.test.ts && cd ../.. && bun run typecheck`
Expected: 测试 PASS，typecheck 零错误

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/kbConfig.ts apps/desktop/src/shared/kbConfig.test.ts apps/desktop/src/main/core/kbIndexStore.ts
git commit -m "feat(kb-sync): 配置模型扩展 remote 字段——shared 防御解析 + setKbRoot 读合并写防抹除"
```

---

### Task 4: diffManifests 纯函数

**Files:**
- Create: `apps/desktop/src/main/core/kbSyncDiff.ts`
- Test: `apps/desktop/src/main/core/kbSyncDiff.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `KbManifest`/`KbManifestFile`
- Produces:
  - `interface KbSyncPlan { toDownload: KbManifestFile[]; toDelete: string[] }`
  - `function diffManifests(base: KbManifest | null, remote: KbManifest): KbSyncPlan`——`toDownload` 已排序且 **`index.json` 恒在末位**；`toDelete` 是 base 有 remote 无的 POSIX path

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/main/core/kbSyncDiff.test.ts`：

```ts
import { describe, it, expect } from 'bun:test'
import { diffManifests } from './kbSyncDiff'
import type { KbManifest } from '../../shared/kbManifest'

const mk = (files: { path: string; sha1: string }[]): KbManifest => ({
  schemaVersion: 1,
  kbId: 'default',
  name: 'kb',
  builtAtMs: 1,
  files: files.map((f) => ({ ...f, size: 1 }))
})

describe('diffManifests', () => {
  it('base null → 全量下载、零删除', () => {
    const remote = mk([{ path: 'a.md', sha1: 'x' }, { path: 'index.json', sha1: 'y' }])
    const plan = diffManifests(null, remote)
    expect(plan.toDownload.map((f) => f.path)).toEqual(['a.md', 'index.json'])
    expect(plan.toDelete).toEqual([])
  })
  it('sha1 相同跳过、不同重下、新增下载、缺失删除', () => {
    const base = mk([
      { path: '不变.md', sha1: 'same' },
      { path: '变了.md', sha1: 'old' },
      { path: '删了.md', sha1: 'gone' }
    ])
    const remote = mk([
      { path: '不变.md', sha1: 'same' },
      { path: '变了.md', sha1: 'new' },
      { path: '新增.md', sha1: 'add' }
    ])
    const plan = diffManifests(base, remote)
    expect(plan.toDownload.map((f) => f.path).sort()).toEqual(['变了.md', '新增.md'])
    expect(plan.toDelete).toEqual(['删了.md'])
  })
  it('index.json 恒排在 toDownload 末位（哪怕字典序在前）', () => {
    const remote = mk([{ path: 'index.json', sha1: 'a' }, { path: 'z_最后.md', sha1: 'b' }])
    const plan = diffManifests(null, remote)
    expect(plan.toDownload.at(-1)!.path).toBe('index.json')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test src/main/core/kbSyncDiff.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write implementation**

`apps/desktop/src/main/core/kbSyncDiff.ts`：

```ts
import type { KbManifest, KbManifestFile } from '../../shared/kbManifest'

/**
 * 两份 manifest 的同步计划（纯函数，electron/fs 零依赖——bun test 直测）。
 *
 * index.json 恒排 toDownload 末位：它是镜像的「目录卡」，先落文件再落卡，
 * 中途断电/断网时旧 index 仍指向完整旧文件集，绝不出现悬空引用（spec ③）。
 * 「首次同步以磁盘为基准」不在这里做——引擎侧把磁盘扫描伪造成 base manifest
 * 后复用本函数（fs 依赖留在引擎，diff 保持纯）。
 */
export interface KbSyncPlan {
  toDownload: KbManifestFile[]
  toDelete: string[]
}

export function diffManifests(base: KbManifest | null, remote: KbManifest): KbSyncPlan {
  const baseByPath = new Map((base?.files ?? []).map((f) => [f.path, f]))
  const remotePaths = new Set(remote.files.map((f) => f.path))
  const toDownload = remote.files.filter((f) => baseByPath.get(f.path)?.sha1 !== f.sha1)
  toDownload.sort((a, b) =>
    a.path === 'index.json' ? 1 : b.path === 'index.json' ? -1 : a.path < b.path ? -1 : 1
  )
  const toDelete = [...baseByPath.keys()].filter((p) => !remotePaths.has(p))
  return { toDownload, toDelete }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && bun test src/main/core/kbSyncDiff.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/core/kbSyncDiff.ts apps/desktop/src/main/core/kbSyncDiff.test.ts
git commit -m "feat(kb-sync): diffManifests 纯函数——sha1 级 diff + index.json 恒末位"
```

---

### Task 5: 同步引擎 runKbSync（electron-free、依赖注入）

**Files:**
- Create: `apps/desktop/src/shared/kbSyncStatus.ts`
- Create: `apps/desktop/src/main/core/kbSync.ts`
- Test: `apps/desktop/src/main/core/kbSync.test.ts`

**Interfaces:**
- Consumes: Task 1 `parseKbManifest`/`kbManifestUrl`/`kbFileUrl`/`manifestPathToPlatform`；Task 4 `diffManifests`；`isPathInsideRoot`（`../services/localAssetProtocol`，顶层无 electron ✓）
- Produces:
  - `apps/desktop/src/shared/kbSyncStatus.ts`：
    ```ts
    export type KbSyncStatus =
      | { state: 'idle' }
      | { state: 'syncing'; done: number; total: number }
      | { state: 'success'; atMs: number; builtAtMs: number }
      | { state: 'error'; message: string; failedCount: number }
    ```
  - `kbSync.ts`：
    ```ts
    export interface KbSyncDeps {
      outDir: string                       // 镜像目标（生产传 kbOutDir()）
      stateDir: string                     // 基准 manifest 目录（生产传 userData/kb-sync）
      remote: { baseUrl: string; kbId: string }
      nowMs: () => number                  // 时间注入（规矩：不调 Date.now）
      fetchImpl?: typeof fetch             // 测试注入 mock；生产缺省 globalThis.fetch
      onStatus?: (s: KbSyncStatus) => void // 进度回调（调度器接去广播）
      concurrency?: number                 // 默认 4
      retries?: number                     // 每文件重试，默认 2
    }
    export async function runKbSync(deps: KbSyncDeps): Promise<KbSyncStatus>
    ```

**引擎规则（实现与测试都以此为准，逐条来自 spec ③/错误处理表）：**
1. 开工先清扫 `outDir` 下所有 `*.part` 残留；
2. fetch manifest（10s AbortController 超时）→ `parseKbManifest` → `kbId` 匹配校验，任一失败 → `error`，镜像不动；
3. base = `stateDir/manifest.json`（防御解析）；**base 为 null 时以磁盘为基准**：walk `outDir`（跳 `.` 开头与 `.part`）逐文件算 sha1 伪造成 base manifest——从「本地构建模式」切过来时内容相同的文件零重下，且磁盘上多余文件自然进 toDelete；
4. `diffManifests(base, remote)` 得计划；每个 toDownload 目标路径先过 `isPathInsideRoot(resolve(outDir, platformPath), outDir)`（parse 已拒逃逸，这里是纵深第二道）——越界即整轮 `error`；
5. 磁盘预检：`statfsSync(outDir)` 可用字节 < toDownload 总 size × 1.1 → `error`（statfsSync 抛错则跳过预检，老 Node 面前宁可漏检不误伤）；
6. 并发 `concurrency` 下载（**index.json 不进池，单独垫后**）：每文件 fetch → 写 `<target>.part` → sha1 校验 → `renameSync` 落位；失败（网络/非 200/sha1 不符）重试 `retries` 次后计入 failed；
7. **failed > 0 ⇒ 不下载 index.json、不执行删除、不更新 base**——新 index 引用缺失文件比停在旧版本严重得多；状态 `error`（message 含失败数与首个失败路径），已成功文件留在盘上（sha1 相同下轮 diff 自动跳过，即断点续传）；
8. failed = 0 ⇒ 应用 index.json → 执行 toDelete（逐条过 isPathInsideRoot）→ 把 remote manifest 原子写入 `stateDir/manifest.json`（tmp+rename，mkdir -p stateDir）→ `success`；
9. `onStatus` 时机：进池前发 `{syncing, done:0, total}`，每文件落位/失败后发一次递增，收尾发终态；返回值=终态。

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/main/core/kbSync.test.ts`（mock fetch 用 Map<url, body|Error>；工具函数就地实现）：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { runKbSync } from './kbSync'
import type { KbManifest } from '../../shared/kbManifest'

const sha1 = (s: string | Buffer): string => createHash('sha1').update(s).digest('hex')
const BASE_URL = 'http://kb.test'

let outDir: string, stateDir: string
beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'kb-out-'))
  stateDir = mkdtempSync(join(tmpdir(), 'kb-state-'))
})
afterEach(() => {
  rmSync(outDir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

/** bodies: posixPath → 内容。自动生成 manifest 与逐文件响应的 mock fetch。 */
function fixture(bodies: Record<string, string>): { manifest: KbManifest; fetchImpl: typeof fetch } {
  const manifest: KbManifest = {
    schemaVersion: 1,
    kbId: 'default',
    name: 'kb',
    builtAtMs: 42,
    files: Object.entries(bodies).map(([path, body]) => ({ path, sha1: sha1(body), size: body.length }))
  }
  const routes = new Map<string, string>()
  routes.set(`${BASE_URL}/kb/default/manifest.json`, JSON.stringify(manifest))
  for (const [path, body] of Object.entries(bodies)) {
    routes.set(`${BASE_URL}/kb/default/${path.split('/').map(encodeURIComponent).join('/')}`, body)
  }
  const fetchImpl = (async (url: unknown) => {
    const body = routes.get(String(url))
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(body, { status: 200 })
  }) as typeof fetch
  return { manifest, fetchImpl }
}

const deps = (fetchImpl: typeof fetch) => ({
  outDir,
  stateDir,
  remote: { baseUrl: BASE_URL, kbId: 'default' },
  nowMs: () => 1000,
  fetchImpl
})

describe('runKbSync 首次全量', () => {
  it('拉全量、内容落位、index.json 存在、基准 manifest 写入 stateDir', async () => {
    const { fetchImpl } = fixture({
      '01线/1品/方案.docx.md': '正文A',
      'assets/01线/1品/img-1.png': 'PNG',
      'index.json': '{"v":1}'
    })
    const st = await runKbSync(deps(fetchImpl))
    expect(st.state).toBe('success')
    expect(readFileSync(join(outDir, '01线/1品/方案.docx.md'), 'utf8')).toBe('正文A')
    expect(readFileSync(join(outDir, 'index.json'), 'utf8')).toBe('{"v":1}')
    expect(existsSync(join(stateDir, 'manifest.json'))).toBe(true)
  })
})

describe('runKbSync 增量与删除', () => {
  it('第二轮只动差异：改动重下、消失删除、未变不请求', async () => {
    const v1 = fixture({ '保留.md': '老', '要删.md': 'x', 'index.json': 'i1' })
    await runKbSync(deps(v1.fetchImpl))
    let fileRequests = 0
    const v2 = fixture({ '保留.md': '新', 'index.json': 'i2' })
    const counting = (async (url: unknown) => {
      if (!String(url).endsWith('manifest.json')) fileRequests++
      return v2.fetchImpl(url as never)
    }) as typeof fetch
    const st = await runKbSync(deps(counting))
    expect(st.state).toBe('success')
    expect(readFileSync(join(outDir, '保留.md'), 'utf8')).toBe('新')
    expect(existsSync(join(outDir, '要删.md'))).toBe(false)
    expect(fileRequests).toBe(2) // 保留.md + index.json，「要删.md」零请求
  })
})

describe('runKbSync 部分失败', () => {
  it('单文件 404 → error、index.json 不应用、基准不更新、成功文件留盘', async () => {
    const good = fixture({ '好.md': 'ok', '坏.md': 'bad', 'index.json': 'i1' })
    const broken = (async (url: unknown) => {
      if (String(url).includes(encodeURIComponent('坏.md'))) return new Response('', { status: 404 })
      return good.fetchImpl(url as never)
    }) as typeof fetch
    const st = await runKbSync(deps(broken))
    expect(st.state).toBe('error')
    expect(existsSync(join(outDir, 'index.json'))).toBe(false)
    expect(existsSync(join(stateDir, 'manifest.json'))).toBe(false)
    expect(readFileSync(join(outDir, '好.md'), 'utf8')).toBe('ok')
  })
  it('sha1 不符经重试仍不符 → 计失败，.part 不落位', async () => {
    const f = fixture({ '篡改.md': '真身', 'index.json': 'i' })
    const tampering = (async (url: unknown) => {
      if (String(url).includes(encodeURIComponent('篡改.md'))) return new Response('假货', { status: 200 })
      return f.fetchImpl(url as never)
    }) as typeof fetch
    const st = await runKbSync(deps(tampering))
    expect(st.state).toBe('error')
    expect(existsSync(join(outDir, '篡改.md'))).toBe(false)
  })
})

describe('runKbSync 首次对账（从本地构建切换）', () => {
  it('磁盘同内容文件零重下；多余文件被清', async () => {
    writeFileSync(join(outDir, '已有同内容.md'), '相同')
    writeFileSync(join(outDir, '本地残留.md'), '旧索引产物')
    const f = fixture({ '已有同内容.md': '相同', 'index.json': 'i' })
    let downloads = 0
    const counting = (async (url: unknown) => {
      if (!String(url).endsWith('manifest.json')) downloads++
      return f.fetchImpl(url as never)
    }) as typeof fetch
    const st = await runKbSync(deps(counting))
    expect(st.state).toBe('success')
    expect(downloads).toBe(1) // 只有 index.json
    expect(existsSync(join(outDir, '本地残留.md'))).toBe(false)
  })
})

describe('runKbSync 防线', () => {
  it('kbId 不匹配 → error，不发任何文件请求', async () => {
    const f = fixture({ 'a.md': 'x', 'index.json': 'i' })
    const st = await runKbSync({ ...deps(f.fetchImpl), remote: { baseUrl: BASE_URL, kbId: '别的团队' } })
    expect(st.state).toBe('error')
  })
  it('manifest 损坏 → error，镜像不动', async () => {
    const bad = (async () => new Response('{broken', { status: 200 })) as typeof fetch
    writeFileSync(join(outDir, '现有.md'), '在')
    const st = await runKbSync(deps(bad))
    expect(st.state).toBe('error')
    expect(readFileSync(join(outDir, '现有.md'), 'utf8')).toBe('在')
  })
  it('开工清扫 .part 残留', async () => {
    mkdirSync(join(outDir, 'x'), { recursive: true })
    writeFileSync(join(outDir, 'x/半截.md.part'), '')
    const f = fixture({ 'index.json': 'i' })
    await runKbSync(deps(f.fetchImpl))
    expect(existsSync(join(outDir, 'x/半截.md.part'))).toBe(false)
  })
  it('onStatus 收到 syncing 进度与终态 success', async () => {
    const f = fixture({ 'a.md': 'x', 'index.json': 'i' })
    const seen: string[] = []
    await runKbSync({ ...deps(f.fetchImpl), onStatus: (s) => seen.push(s.state) })
    expect(seen[0]).toBe('syncing')
    expect(seen.at(-1)).toBe('success')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && bun test src/main/core/kbSync.test.ts`
Expected: FAIL（`./kbSync` 与 `../../shared/kbSyncStatus` 不存在）

- [ ] **Step 3: Write implementation**

先建 `apps/desktop/src/shared/kbSyncStatus.ts`（内容=Interfaces 节的 KbSyncStatus，附一段「为什么放 shared：main 产、preload 转、renderer 消费」注释）。

再写 `apps/desktop/src/main/core/kbSync.ts`。骨架（完整遵守上面 9 条引擎规则；顶层 import 仅 node 内置 + 本仓 electron-free 模块）：

```ts
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  statfsSync, writeFileSync
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

import { parseKbManifest, kbManifestUrl, kbFileUrl, manifestPathToPlatform } from '../../shared/kbManifest'
import type { KbManifest, KbManifestFile } from '../../shared/kbManifest'
import type { KbSyncStatus } from '../../shared/kbSyncStatus'
import { diffManifests } from './kbSyncDiff'
import { isPathInsideRoot } from '../services/localAssetProtocol'

// KbSyncDeps 接口定义（照 Interfaces 节）…

export async function runKbSync(deps: KbSyncDeps): Promise<KbSyncStatus> { /* 按引擎规则 1→9 */ }
```

实现要点（每处配「为什么」注释）：
- `fetchWithTimeout(url)`：`AbortController` + 10s `setTimeout`（`finally` 里 clearTimeout）；
- 磁盘扫描伪基准 `scanDiskAsManifest(outDir)`：walk 跳 `.` 开头与 `.part`，逐文件 sha1，`builtAtMs: 0`；
- 下载单文件 `downloadOne`：`mkdirSync(dirname(target), {recursive:true})` → `Buffer.from(await res.arrayBuffer())` → sha1 校验 → 写 `.part` → `renameSync`；重试循环包整个过程；
- 并发池：`Promise.all(Array.from({length: c}, worker))`，worker 从共享游标取任务；
- 全部 catch 收敛为返回值 `{state:'error'}`，**本函数绝不 throw**（调度器不用兜异常）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && bun test src/main/core/kbSync.test.ts && bun test src/`
Expected: 新测试全 PASS，存量测试（快照/契约）不受影响

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/kbSyncStatus.ts apps/desktop/src/main/core/kbSync.ts apps/desktop/src/main/core/kbSync.test.ts
git commit -m "feat(kb-sync): 同步引擎——manifest diff 增量下载、.part 原子落位、index.json 垫后、部分失败不半应用"
```

---

### Task 6: 调度器 + 全局状态广播

**Files:**
- Create: `apps/desktop/src/main/core/kbSyncScheduler.ts`
- Modify: `apps/desktop/src/main/tabRegistry.ts`（加 `broadcastKbSyncStatus`）
- Modify: `apps/desktop/src/main/index.ts`（whenReady 里 `startKbSyncScheduler()`）
- Modify: `apps/desktop/src/shared/ipc-channels.ts`（仅本任务用到的 `KB_SYNC_STATUS` 常量；其余通道 Task 7 加）

**Interfaces:**
- Consumes: Task 5 `runKbSync`/`KbSyncStatus`；Task 3 `getKbConfig`；kbIndexStore `kbOutDir()`
- Produces:
  - `function startKbSyncScheduler(): void`（启动后 30s 首触 + 每 6h 定时；无 remote 配置时静默跳过）
  - `function triggerKbSyncNow(): 'started' | 'alreadyRunning' | 'noRemote'`（单飞行锁；Task 7 的 KB_SYNC_NOW/KB_REMOTE_SET handler 调用）
  - `function lastKbSyncInfo(): { atMs: number; builtAtMs: number } | null`（读 `userData/kb-sync/manifest.json` 的 mtime+builtAtMs；Task 7 的 KB_PATH_GET 用）
  - tabRegistry：`function broadcastKbSyncStatus(payload: KbSyncStatus): void`

- [ ] **Step 1: Write implementation**（本任务全是 electron 接线，无单测、typecheck 守门）

`ipc-channels.ts` KB 通道区追加（注释风格对齐邻居）：

```ts
  /**
   * Main → renderer push. Knowledge-base remote sync progress/state.
   * Broadcast to shell + settings overlay + chat tabs (web tabs skipped —
   * no preload there and no KB UI either).
   */
  KB_SYNC_STATUS: 'kb:sync-status',
```

`kbSyncScheduler.ts`：

```ts
import { join } from 'node:path'
import { statSync, existsSync, readFileSync } from 'node:fs'
import { app } from 'electron'

import { runKbSync } from './kbSync'
import type { KbSyncStatus } from '../../shared/kbSyncStatus'
import { parseKbManifest } from '../../shared/kbManifest'
import { getKbConfig, kbOutDir } from './kbIndexStore'
import { broadcastKbSyncStatus } from '../tabRegistry'

/**
 * KB 同步调度器（app 级单例，engine-free）。
 * 触发时机三条（spec ③）：启动后延迟 30s（不挤冷启动的事件循环——spawn warmup、
 * 协议注册都在前 30s）、每 6h 定时、设置页手动。单飞行锁：手动+定时撞车时后来者
 * 直接返回 alreadyRunning，绝不并行跑两轮（两个进程同写 .part 会互相踩）。
 */
let running = false

const stateDir = (): string => join(app.getPath('userData'), 'kb-sync')

export function triggerKbSyncNow(): 'started' | 'alreadyRunning' | 'noRemote' {
  const { remote } = getKbConfig()
  if (!remote) return 'noRemote'
  if (running) return 'alreadyRunning'
  running = true
  void runKbSync({
    outDir: kbOutDir(),
    stateDir: stateDir(),
    remote,
    nowMs: () => Date.now(), // 注入点在这里、不在引擎——保引擎可测（规矩同 build 脚本）
    onStatus: (s: KbSyncStatus) => broadcastKbSyncStatus(s)
  }).then((final) => {
    running = false
    broadcastKbSyncStatus(final)
  })
  return 'started'
}

export function startKbSyncScheduler(): void {
  setTimeout(() => void triggerKbSyncNow(), 30_000)
  setInterval(() => void triggerKbSyncNow(), 6 * 3600_000)
}

/** 上次成功同步：基准 manifest 的 mtime（何时同步的）+ builtAtMs（内容多新）。 */
export function lastKbSyncInfo(): { atMs: number; builtAtMs: number } | null {
  const p = join(stateDir(), 'manifest.json')
  if (!existsSync(p)) return null
  try {
    const m = parseKbManifest(JSON.parse(readFileSync(p, 'utf8')))
    if (!m) return null
    return { atMs: statSync(p).mtimeMs, builtAtMs: m.builtAtMs }
  } catch {
    return null
  }
}
```

`tabRegistry.ts` 在 `broadcastAppearanceChanged` 旁加（形状照抄它，去掉 source 排除、带 payload；web tab 跳过——那里没 preload 也没 KB UI）：

```ts
export function broadcastKbSyncStatus(payload: KbSyncStatus): void {
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.webContents.send(IPC_CHANNELS.KB_SYNC_STATUS, payload)
  }
  if (settingsView && !settingsView.webContents.isDestroyed()) {
    settingsView.webContents.send(IPC_CHANNELS.KB_SYNC_STATUS, payload)
  }
  for (const ctx of tabs.values()) {
    if (ctx.kind === 'web') continue
    const wc = ctx.view.webContents
    if (!wc.isDestroyed()) wc.send(IPC_CHANNELS.KB_SYNC_STATUS, payload)
  }
}
```

`main/index.ts`：`registerIpcHandlers()` 调用行之后加 `startKbSyncScheduler()`（import 对齐文件顶部分组）。

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: 零错误

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/core/kbSyncScheduler.ts apps/desktop/src/main/tabRegistry.ts apps/desktop/src/main/index.ts apps/desktop/src/shared/ipc-channels.ts
git commit -m "feat(kb-sync): 调度器单飞行锁 + 30s/6h 触发 + 全 webContents 状态广播"
```

---

### Task 7: IPC 四件套（扩 KB_PATH_GET、新 KB_REMOTE_SET / KB_SYNC_NOW / KB_ROOT_PICK、订阅 KB_SYNC_STATUS）

**Files:**
- Modify: `apps/desktop/src/shared/ipc-channels.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`
- Modify: `apps/desktop/src/main/ipc/register.ts`

**Interfaces:**
- Consumes: Task 3 `setKbRemote`/`getKbConfig`；Task 6 `triggerKbSyncNow`/`lastKbSyncInfo`；Task 5 `KbSyncStatus`
- Produces（renderer 侧 `window.chatApi` 新形状，Task 8 用）:
  ```ts
  getKbPath(): Promise<{
    kbRoot: string | null
    outDir: string
    remote: { baseUrl: string; kbId: string } | null
    lastSync: { atMs: number; builtAtMs: number } | null
  }>
  setKbRemote(remote: { baseUrl: string; kbId: string } | null): Promise<void>
  kbSyncNow(): Promise<'started' | 'alreadyRunning' | 'noRemote'>
  pickKbRoot(): Promise<{ path: string | null }>
  onKbSyncStatus(cb: (s: KbSyncStatus) => void): () => void
  ```

- [ ] **Step 1: 通道常量**（`ipc-channels.ts` KB 区，每条带对齐邻居的 JSDoc）：`KB_REMOTE_SET: 'kb:remote-set'`、`KB_SYNC_NOW: 'kb:sync-now'`、`KB_ROOT_PICK: 'kb:root-pick'`（`KB_SYNC_STATUS` Task 6 已加）。同文件下方 chatApi 接口文档注释区同步补方法说明（现有 KB 三方法注释旁）。

- [ ] **Step 2: main handler**（`register.ts`，全部 engine-free，放现有 KB 区）：

```ts
  ipcMain.handle(
    IPC_CHANNELS.KB_PATH_GET,
    async (): Promise<{
      kbRoot: string | null
      outDir: string
      remote: KbRemoteConfig | null
      lastSync: { atMs: number; builtAtMs: number } | null
    }> => {
      const cfg = getKbConfig()
      return { kbRoot: cfg.kbRoot, outDir: kbOutDir(), remote: cfg.remote, lastSync: lastKbSyncInfo() }
    }
  )

  ipcMain.handle(IPC_CHANNELS.KB_REMOTE_SET, async (_e, remote: KbRemoteConfig | null): Promise<void> => {
    // 入参防御：renderer 被攻破时 main 是最后防线，形状不对宁可丢弃。
    if (remote !== null && (typeof remote?.baseUrl !== 'string' || typeof remote?.kbId !== 'string')) return
    setKbRemote(remote)
    // 写入即触发：用户填完 URL 不该还要再点一次同步（spec ④）。
    if (remote) triggerKbSyncNow()
  })

  ipcMain.handle(IPC_CHANNELS.KB_SYNC_NOW, async (): Promise<'started' | 'alreadyRunning' | 'noRemote'> =>
    triggerKbSyncNow()
  )

  ipcMain.handle(IPC_CHANNELS.KB_ROOT_PICK, async (event): Promise<{ path: string | null }> => {
    // 不能复用 WORKSPACE_PICK：那条要 resolveEngine（per-tab），设置 overlay 没有 engine。
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { path: null }
    const result = await dialog.showOpenDialog(win, {
      title: '选择知识库目录',
      properties: ['openDirectory']
    })
    return { path: result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]! }
  })
```

（import 区补 `getKbConfig`、`setKbRemote`、`triggerKbSyncNow`、`lastKbSyncInfo`、`KbRemoteConfig` type。）

- [ ] **Step 3: preload 两文件**。`index.ts` 的 chatApi 对象里（现有 kb 方法旁，订阅方法形状照抄 `onChatEvent` 的 on/off 对）：

```ts
  setKbRemote(remote: { baseUrl: string; kbId: string } | null): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_REMOTE_SET, remote) as Promise<void>
  },
  kbSyncNow(): Promise<'started' | 'alreadyRunning' | 'noRemote'> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_SYNC_NOW) as Promise<'started' | 'alreadyRunning' | 'noRemote'>
  },
  pickKbRoot(): Promise<{ path: string | null }> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_ROOT_PICK) as Promise<{ path: string | null }>
  },
  onKbSyncStatus(cb: (s: KbSyncStatus) => void): () => void {
    const listener = (_e: unknown, payload: KbSyncStatus): void => cb(payload)
    ipcRenderer.on(IPC_CHANNELS.KB_SYNC_STATUS, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.KB_SYNC_STATUS, listener)
    }
  },
```

并把现有 `getKbPath` 的返回类型断言改成 Interfaces 节的扩展形状。`index.d.ts` 同步补五个方法签名（`KbSyncStatus` 从 `../shared/kbSyncStatus` import type）。

- [ ] **Step 4: Typecheck + 全量测试**

Run: `bun run typecheck && cd apps/desktop && bun test src/`
Expected: 零错误、全绿（四处漏一处 typecheck 当场抓）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/preload/index.ts apps/desktop/src/preload/index.d.ts apps/desktop/src/main/ipc/register.ts
git commit -m "feat(kb-sync): IPC 四件套——KB_PATH_GET 扩状态、remote-set 写入即同步、engine-free 目录选择器、状态订阅"
```

---

### Task 8: 设置 UI「知识库」分区

**Files:**
- Create: `apps/desktop/src/renderer/src/components/settings/KnowledgeBaseSection.tsx`
- Modify: `apps/desktop/src/renderer/src/components/settings/SettingsView.tsx`（rail 加分类 + 分发分支；文件已 1236 行，新 section 独立成文件）
- Modify: `apps/desktop/src/renderer/src/i18n.ts`（zh/en 两处各加一组 key）

**Interfaces:**
- Consumes: Task 7 的 `window.chatApi.getKbPath/setKbRemote/kbSyncNow/pickKbRoot/onKbSyncStatus`；`KbSyncStatus`（`import type`）
- Produces: `function KnowledgeBaseSection(): React.JSX.Element`（默认导出不用，命名导出对齐邻居）

- [ ] **Step 1: i18n keys**（zh 区 `catConfiguration` 附近 + en 区对应位置）：

```ts
    // zh
    catKnowledgeBase: '知识库',
    kbSourceTitle: '知识库来源',
    kbSourceDesc: '「写方案」检索资料的出处。远程模式由服务器统一构建、自动同步到本机。',
    kbSourceLocal: '本地目录',
    kbSourceLocalDesc: '选择本机源目录，需在本机执行索引构建（依赖 markitdown / LibreOffice）',
    kbSourceRemote: '远程服务器',
    kbSourceRemoteDesc: '填入公司知识库服务器地址，如 http://10.0.0.5:8080',
    kbPickFolder: '选择目录…',
    kbRemoteUrl: '服务器地址',
    kbRemoteApply: '保存并同步',
    kbSyncNow: '立即同步',
    kbSyncing: '同步中…',
    kbLastSync: '上次同步',
    kbVersion: '知识库版本',
    kbSyncFailed: '同步失败',
    kbNeverSynced: '尚未同步',
    // en（对应键）
    catKnowledgeBase: 'Knowledge Base',
    kbSourceTitle: 'Knowledge base source',
    kbSourceDesc: 'Where proposal writing retrieves source material from. Remote mode is built on the server and auto-synced.',
    kbSourceLocal: 'Local folder',
    kbSourceLocalDesc: 'Pick a local source folder; the index must be built on this machine (requires markitdown / LibreOffice)',
    kbSourceRemote: 'Remote server',
    kbSourceRemoteDesc: 'Company KB server address, e.g. http://10.0.0.5:8080',
    kbPickFolder: 'Choose folder…',
    kbRemoteUrl: 'Server URL',
    kbRemoteApply: 'Save & sync',
    kbSyncNow: 'Sync now',
    kbSyncing: 'Syncing…',
    kbLastSync: 'Last synced',
    kbVersion: 'KB version',
    kbSyncFailed: 'Sync failed',
    kbNeverSynced: 'Never synced',
```

- [ ] **Step 2: SettingsView 接线**：`CategoryId` 联合与 `CATEGORY_IDS` 加 `'knowledgeBase'`；rail `categories` 数组在 `configuration` 之后插 `{ id: 'knowledgeBase', label: t('catKnowledgeBase'), icon: <BookIcon /> }`（`BookIcon` 在文件底部 icon 区加一个 16px 内联 SVG，风格对齐 `FolderTreeIcon` 等邻居——项目无图标库）；分发分支加 `activeCategory === 'knowledgeBase' ? <KnowledgeBaseSection /> :`。

- [ ] **Step 3: KnowledgeBaseSection 组件**。数据流对齐 `GeneralSection`（mount 时 `getKbPath()` 拉一次；操作后重拉；`onKbSyncStatus` 订阅推送、卸载时退订）：

```tsx
import React, { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import type { KbSyncStatus } from '../../../../shared/kbSyncStatus'
// Section / SettingRow 等布局原语从 SettingsView 既有实现导出复用（若未导出，
// 在 SettingsView 里把 Section 加 export——不复制粘贴一份）。

type KbPathState = Awaited<ReturnType<typeof window.chatApi.getKbPath>>

export function KnowledgeBaseSection(): React.JSX.Element {
  const t = useT()
  const [state, setState] = useState<KbPathState | null>(null)
  const [urlDraft, setUrlDraft] = useState('')
  const [sync, setSync] = useState<KbSyncStatus>({ state: 'idle' })

  const refresh = (): void => {
    void window.chatApi.getKbPath().then((s) => {
      setState(s)
      setUrlDraft(s.remote?.baseUrl ?? '')
    })
  }
  useEffect(() => {
    refresh()
    const off = window.chatApi.onKbSyncStatus((s) => {
      setSync(s)
      if (s.state === 'success') refresh() // 成功后 lastSync 变了，重拉一次
    })
    return off
  }, [])

  const mode: 'local' | 'remote' = state?.remote ? 'remote' : 'local'

  const applyRemote = async (): Promise<void> => {
    const baseUrl = urlDraft.trim()
    if (!baseUrl) return
    await window.chatApi.setKbRemote({ baseUrl, kbId: 'default' }) // kbId 口子：UI 本期不暴露
    refresh()
  }
  const switchToLocal = async (): Promise<void> => {
    await window.chatApi.setKbRemote(null)
    refresh()
  }
  const pickLocal = async (): Promise<void> => {
    const { path } = await window.chatApi.pickKbRoot()
    if (path) {
      await window.chatApi.setKbPath(path)
      refresh()
    }
  }

  // 渲染：单选两行（local/remote，含描述）；remote 选中时露出 URL 输入 + 保存并同步 +
  // 状态行（syncing→进度 done/total；error→kbSyncFailed+message；success/静息→
  // kbLastSync 时间 + kbVersion builtAtMs，均 toLocaleString()；无 lastSync→kbNeverSynced）；
  // local 选中时露出当前 kbRoot 路径（等宽字体）+ kbPickFolder 按钮 + kbSourceLocalDesc 说明。
  // 布局用 Section/SettingRow 原语与 space-y-8，对齐 GeneralSection 观感。
  return (/* 按上述结构实现 */)
}
```

（渲染 JSX 按注释结构写全——按钮/输入样式类名照抄 GeneralSection 里的现成按钮与 AppearanceSection 的输入控件。）

- [ ] **Step 4: Typecheck + GUI 冒烟**

Run: `bun run typecheck`，然后 `bun run dev`：
1. 设置 → 知识库：应显示「本地目录」选中、路径为真实资料库路径；
2. 起本地静态服务模拟服务器：`cd "$HOME/Library/Application Support/@claude-desktop/desktop/kb-index" && python3 -m http.server 8080 --bind 127.0.0.1` —— 注意 URL 布局是 `/kb/default/…`，所以再套一层：`mkdir -p /tmp/kbsrv/kb && ln -s "$HOME/Library/Application Support/@claude-desktop/desktop/kb-index" /tmp/kbsrv/kb/default && cd /tmp/kbsrv && python3 -m http.server 8080`（先跑过 Task 2 冒烟让 manifest.json 存在）；
3. 切「远程服务器」填 `http://127.0.0.1:8080` → 保存并同步 → 观察进度到 success（内容 sha1 全同，应秒级完成零下载或仅 index.json）；
4. 断掉 http.server 再点「立即同步」→ 显示同步失败 + 原因，「写方案」仍可用。

Expected: 四步全符合预期。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/settings/KnowledgeBaseSection.tsx apps/desktop/src/renderer/src/components/settings/SettingsView.tsx apps/desktop/src/renderer/src/i18n.ts
git commit -m "feat(kb-sync): 设置页知识库分区——本地/远程来源切换、同步状态与手动触发"
```

---

### Task 9: 服务器部署手册

**Files:**
- Create: `docs/kb-server-deploy.md`

**Interfaces:**
- Consumes: Task 2 的 CLI 用法
- Produces: 运维照抄可用的部署文档

- [ ] **Step 1: Write the doc**。章节与内容（每节给出完整可粘贴命令，按 Ubuntu 22.04 假设，标注 CentOS 差异点）：

1. **依赖安装**：`curl -fsSL https://bun.sh/install | bash`；`pipx install markitdown && pipx inject markitdown xlrd`（**xlrd 必须注入，否则 .xls 全军覆没**——附本机踩坑记录）；`apt install libreoffice --no-install-recommends`；
2. **目录约定**：`/srv/kb/source/`（源，SMB 共享）、`/srv/kb/publish/default/`（制品）、代码检出 `/srv/kb/app/`（本仓库，含 scripts/）；
3. **SMB 共享 source**（samba 配置片段，团队读写权限）；
4. **cron**（每小时；`flock` 防重入；构建失败不发布——`&&` 串联天然保证）：
   ```cron
   0 * * * * flock -n /tmp/kb-build.lock bash -c 'cd /srv/kb/app && bun scripts/build-kb-index.ts --kb /srv/kb/source --out /srv/kb/publish/default --now $(date +\%s)000 && bun scripts/publish-kb-manifest.ts --dir /srv/kb/publish/default --kb-id default --name "福鑫数科产品线资料库" --now $(date +\%s)000' >> /var/log/kb-build.log 2>&1
   ```
5. **nginx**（`location /kb/ { alias /srv/kb/publish/; }` + `charset utf-8;`，中文路径 percent-encoding 默认可用；说明为什么暂不需要 TLS/鉴权=内网明文起步，公网化时的口子在客户端 fetch 封装）；
6. **验收**：`curl -s http://<服务器>/kb/default/manifest.json | python3 -m json.tool | head`，再在任一客户端设置页填地址走一轮同步；
7. **多知识库预留**：加团队=复制一份 cron（新 `--kb-id`/发布目录），URL 自动成立——客户端侧待 P1。

- [ ] **Step 2: 自查**：文档里所有命令路径与 Task 2 实际 CLI 参数名逐一核对（`--dir/--kb-id/--name/--now`）。

- [ ] **Step 3: Commit**

```bash
git add docs/kb-server-deploy.md
git commit -m "docs(kb-sync): 服务器部署手册——依赖/SMB/cron flock/nginx/验收"
```

---

### Task 10: 终验

- [ ] **Step 1**: `bun run typecheck` → 零错误
- [ ] **Step 2**: `cd apps/desktop && bun test src/` → 全绿（含既有快照/契约测试）；`cd ../.. && bun test scripts/` → 全绿
- [ ] **Step 3**: 对照 spec「错误处理汇总」表逐行走查 kbSync.ts 实现与测试覆盖，缺一补一
- [ ] **Step 4**: Task 8 Step 4 的 GUI 冒烟未做则补做；全部通过后按 superpowers:verification-before-completion 汇报

## Self-Review 记录

- **Spec 覆盖**：①manifest/发布=Task 2；②配置模型=Task 3；③同步引擎九条规则=Task 5；④IPC=Task 6/7；⑤设置 UI=Task 8；⑥部署=Task 9；扩展口子=分散在 Task 1(kbId 字段)/3(remote.kbId)/8(UI 不暴露 kbId)/9(§7)；错误处理表=Task 5 测试 + Task 10 Step 3 走查。无缺口。
- **类型一致性**：`KbRemoteConfig` 定义于 Task 3、Task 6/7 复用；`KbSyncStatus` 定义于 Task 5 shared、Task 6/7/8 复用；`KbManifestFile.path` 全程 POSIX、平台转换只在 kbSync 落盘处经 `manifestPathToPlatform(p, sep)`。
- **占位符扫描**：Task 8 Step 3 的渲染 JSX 以结构注释给出而非整段抄写——布局类名指向了具体参照物（GeneralSection 按钮/AppearanceSection 输入件），执行者无需自行发明；其余任务代码完整。
