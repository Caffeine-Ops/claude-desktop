/**
 * 「运行时组件」——不随安装包发布、首次启动时按需下载的大件二进制。
 * main ↔ renderer 共享的纯数据契约（无 electron/node 依赖，可 bun test 直测）。
 *
 * 背景：CLI 二进制 233MB/平台 + python-runtime 70MB/平台，两者占安装包体积的
 * 绝大部分，且都是**与 app 版本节奏不同**的外部产物（CLI 一个月变一次、app 一周
 * 几次）。搬出去之后安装包大幅缩水，且换 CLI 版本不必发 app 版本。
 *
 * 与 pptSkillStatus.ts 的关系：形态相似，**刻意不合并**，三条理由——
 *   ① PptSkillStatus 是单组件扁平结构；这里要在 N 个组件上做聚合判定
 *      （只看 required 的那些），扁平结构表达不了。
 *   ② `preparing-python` 那个 phase 是 ppt 专属的第三段，硬塞进来会让两边的
 *      phase 联合都变成对方的垃圾。
 *   ③ pptSkill 是 2026-07-29 刚上线、服务器侧已跑通的路径。「先接下载、后拆桥」
 *      的纪律同样适用于代码：不为了消除重复去动一个正在工作的子系统。
 * 将来收敛时，ppt-creator 直接变成第三个 ComponentEntry（kind:'zip'）即可。
 */

// ── 名册契约（服务端清单的形状）────────────────────────────────────────

/**
 * 组件 id。用字面量联合而不是 string：新增组件必须同步改这个类型，漏改的地方
 * typecheck 当场抓（同 IPC_CHANNELS 的纪律）。
 *
 * 为什么 CLI 那个叫 'cli' 而不是 'fusion-code-cli'：它到底装的是 fusion 版还是
 * 官方版由发布期的 CLI_SOURCE 决定（见 ComponentArtifact.source），id 里钉死
 * 某一个来源会立刻变成谎言。
 */
export type ComponentId = 'cli' | 'python-runtime'

/** 落地形态：决定 worker 拿到字节之后怎么处理。 */
export type ComponentKind =
  | 'executable' // 单个可执行文件 → <root>/<id>/<binName>，非 win 补 chmod 0o755
  | 'tar.gz' // 归档 → 解到 <root>/<id>/，可 stripComponents

/**
 * 传输层压缩，**与 kind 正交**。
 *   'none' —— 服务器上就是原始字节
 *   'gzip' —— 服务器上是 <file>.gz，客户端边读边 createGunzip()
 *
 * 注意 kind='tar.gz' 自带 gzip，那时 encoding 恒为 'none'，别套两层。
 *
 * 为什么不用 HTTP 的 `Content-Encoding: gzip` 而是发布一个字面名为 .gz 的静态
 * 文件：断点续传。一旦响应体在传输层被重新编码，Range 的字节偏移就不再对应
 * 客户端 .part 里的偏移，续传会拼出一个 sha256 死活对不上的文件。静态 .gz
 * 让 Range 是「对文件字节的、精确的」。
 */
export type ComponentEncoding = 'none' | 'gzip'

/**
 * `${process.platform}-${process.arch}` 的受限子集（CI 本就只打这三个）。
 * 用复合串而不是拆两个字段：客户端一次相等比较即可，发布侧也只有一个 key，
 * 少一个「两字段其一漏填」的失配面。
 */
export type ComponentPlatform = 'darwin-arm64' | 'darwin-x64' | 'win32-x64'

/**
 * CLI 二进制的来源。**这是 CLI_SOURCE 在客户端侧的投影**：发布期由
 * publish-components 决定发哪一个上服务器，客户端只管照清单下载，但把来源记下来
 * 供追溯——两者的签名状态完全不同，出问题时这是第一个要问的问题：
 *
 *   'official' —— downloads.claude.ai 的官方 claude，带 Anthropic 的 Developer ID
 *                 签名 + hardened runtime + 已公证
 *   'fusion'   —— Caffeine-Ops/fusion-code-install 的 bun --compile 产物，
 *                 adhoc / linker-signed，无 Team ID、无 hardened runtime
 *
 * 两态都能正常 spawn（exec 出的是独立进程，不受父进程 library validation 约束），
 * 但**理由不同**，所以不能假设「下载来的都有 Developer ID」。
 * python-runtime 用不上这个字段。
 */
export type ComponentSource = 'fusion' | 'official'

export interface ComponentArtifact {
  /**
   * 版本串放在 **artifact 上而不是 entry 上**：三个平台的版本现实中就是不同的
   * （build.yml 的矩阵里 darwin-x64 是 v2.1.91，arm64/win 还停在 v2.1.90，因为
   * v2.1.91 只补了 darwin-x64 一个资产）。在 entry 上放一个「全局版本」等于说谎，
   * 客户端还得再猜自己拿到的是哪个。
   */
  version: string
  /** 仅 CLI 有：这份产物是 fusion 版还是官方版。 */
  source?: ComponentSource
  /** 下载文件名。客户端拼 `<base>/<file>`（同 pptSkill 的同目录约定）。 */
  file: string
  /** 绝对地址；清单与产物异地托管时由发布方写死，缺省回落同目录拼接。 */
  url?: string
  /**
   * **传输层字节**（即 file 本身，压缩后的那份）的 sha256。
   *
   * 为什么校验压缩态而不是解压态：断点续传要能对着 .part 增量推进，只有
   * 「落盘的就是被校验的那串字节」才做得到。解压态的 hash 必须等全部解完才算
   * 得出来，续传时无法复用已下的部分。
   */
  sha256: string
  /** file 的字节数：进度条分母 + 磁盘预检 + Range 续传的终点判据。 */
  size: number
  encoding: ComponentEncoding
  /** 解压/落盘后的字节数，磁盘空间预检用（gzip 会严重低估实际占用）。 */
  unpackedSize: number
  /**
   * 仅 kind='executable'：**解压后**那个可执行文件的 sha256，第二道闸。
   *
   * encoding='gzip' 时上面那个 sha256 只能证明 .gz 完整，证明不了 gunzip 出来的
   * 东西对（解压器 bug / 写盘时的坏页）。encoding='none' 时它与 sha256 相等，
   * 客户端照样校一遍，代码里不需要分支。
   */
  contentSha256?: string
  /**
   * kind='executable' 时的落盘文件名。
   *
   * **必须按平台分**：Windows 是 `fusion-code-cli.exe`，mac 是无扩展名的
   * `fusion-code-cli`——而 cliDetect 正是按这个名字找二进制的。曾经把它放在
   * entry 层，合并三平台分片时后面平台的值会被前一个覆盖掉，于是 Windows 清单
   * 里写着 mac 的名字：装完落盘没有 .exe，cliDetect 找不到 → **装了也用不了**，
   * 而且报错现场（「CLI 未找到」）离真因（清单字段被合并逻辑吃了）十万八千里。
   */
  binName?: string
  /**
   * 就绪判据：安装根下必须存在的相对路径。同样**必须按平台分** —— python 的
   * 解释器在 mac 是 `bin/python3`、在 Windows 是 `python.exe`。放 entry 层会让
   * Windows 永远判定「没装好」，于是每次启动都重下一遍，且永远好不了。
   */
  readyProbe: string
}

export interface ComponentEntry {
  id: ComponentId
  kind: ComponentKind
  /**
   * true = 缺了应用完全不能用 → 启动全屏 gate 挡在这里，且不可关闭。
   * false = 缺了只降级 → 后台装，不挡任何 UI。
   *
   * **放在服务端清单里而不是客户端硬编码**：万一将来默认后端换成系统 claude，
   * 改一行后台配置即可，不用发版。
   */
  required: boolean
  /** 归档类：剥掉的顶层目录层数（python-build-standalone 有一层 `python/`）。 */
  stripComponents?: number
  /**
   * 每平台一份产物。读不到自己那把 key = 该平台不发这个组件：
   * required 就报错、非 required 就静默跳过（与「CI 本就只打三个平台」一致）。
   */
  artifacts: Partial<Record<ComponentPlatform, ComponentArtifact>>
}

export interface ComponentsManifest {
  /**
   * 客户端只认识 1。见到 2（未来格式）且自己是老版本 → 走离线降级
   * （本地已装就放行），而不是把用户焊死在「清单格式不正确」上。
   */
  schemaVersion: 1
  publishedAt: number
  components: ComponentEntry[]
}

// ── 运行时状态（main 单一写手，前台整块镜像；范式对齐 updaterState）──────

export type ComponentPhase =
  | 'idle'
  | 'checking'
  | 'downloading' // done/total = 传输字节
  | 'verifying' // done/total = 重读 .part 的字节，见 worker 里的三段式说明
  | 'installing' // gunzip / 解 tar + 原子落位
  | 'ready'
  | 'error'

export interface ComponentStatus {
  id: ComponentId
  phase: ComponentPhase
  required: boolean
  done: number
  total: number
  installedVersion: string | null
  targetVersion: string | null
  /** phase='error' 时的中文文案，可直接展示。 */
  error: string | null
  /** 一句大白话，如「正在校验…」「第 2 次重试（15 秒后）」。 */
  detail: string
  /**
   * 瞬时速率（B/s，EMA 平滑）。0 = 未知。
   *
   * 为什么这是刚需不是锦上添花：自建源出口带宽约 1.1MB/s 且是**所有用户共享**的，
   * 一次首装动辄一两分钟。用户最需要的信息是「还要多久」，没有速率就算不出。
   */
  bytesPerSecond: number
  /** 已重试次数。UI 显示出来，让用户看出不是卡死。 */
  attempt: number
}

/** 整张组件状态表 + 聚合结论。 */
export interface RuntimeComponentsState {
  components: ComponentStatus[]
  /** 所有 required 组件是否都可用。**门只看这一个字段**。 */
  requiredReady: boolean
  /**
   * 是否曾成功拉到清单。false 且 requiredReady 也 false → 网络问题，
   * UI 该说「检查网络」而不是「下载失败」。
   */
  manifestOk: boolean
}

export const initialRuntimeComponentsState: RuntimeComponentsState = {
  components: [],
  requiredReady: false,
  manifestOk: false
}

// ── 纯函数 ────────────────────────────────────────────────────────────

/** 当前进程的平台 key；不在受支持三平台内返回 null（调用方据此不注册组件）。 */
export function currentComponentPlatform(
  platform: string = process.platform,
  arch: string = process.arch
): ComponentPlatform | null {
  const key = `${platform}-${arch}`
  return key === 'darwin-arm64' || key === 'darwin-x64' || key === 'win32-x64' ? key : null
}

/** 取当前平台的产物；该平台没发这个组件则 undefined。 */
export function pickArtifact(
  entry: ComponentEntry,
  platform: ComponentPlatform | null
): ComponentArtifact | undefined {
  return platform ? entry.artifacts[platform] : undefined
}

/** 下载地址：优先清单里写死的绝对 url，否则同目录拼接。 */
export function artifactUrl(base: string, artifact: ComponentArtifact): string {
  if (artifact.url && artifact.url.trim()) return artifact.url.trim()
  return `${base.replace(/\/+$/, '')}/${artifact.file}`
}

/** id → 给普通用户看的中文名。文案直白优先，不出现 fusion/CLI 这类内部词。 */
export function describeComponent(id: ComponentId): string {
  switch (id) {
    case 'cli':
      return 'AI 引擎'
    case 'python-runtime':
      return 'Python 运行环境'
  }
}

/**
 * 剩余字节 + 速率 → 「约 48 秒」/「约 3 分钟」。速率为 0 或负剩余返回 ''
 * （宁可不显示，也不要显示一个跳动的假数字）。
 */
export function formatEta(remaining: number, bytesPerSecond: number): string {
  if (bytesPerSecond <= 0 || remaining <= 0) return ''
  const seconds = Math.ceil(remaining / bytesPerSecond)
  if (seconds < 60) return `约 ${seconds} 秒`
  return `约 ${Math.ceil(seconds / 60)} 分钟`
}

/** 字节数 → 「84.6 MB」。进度文案用。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

export function isRuntimeComponentsBusy(s: RuntimeComponentsState): boolean {
  return s.components.some(
    (c) => c.phase === 'checking' || c.phase === 'downloading' || c.phase === 'verifying' || c.phase === 'installing'
  )
}

export function initialComponentStatus(id: ComponentId, required: boolean): ComponentStatus {
  return {
    id,
    phase: 'idle',
    required,
    done: 0,
    total: 0,
    installedVersion: null,
    targetVersion: null,
    error: null,
    detail: '',
    bytesPerSecond: 0,
    attempt: 0
  }
}

/**
 * 解析并强校验远端清单。**任何一处不合形状就整份判废返回 null**，让调用方走
 * 离线降级（本地已装就放行），而不是拿半份清单去下载。
 *
 * 为什么校验得这么严：自建源同域挂着 sub2api 网关，**漏配路径不会 404，会被
 * 它的 SPA 兜底吃成 200 + text/html**（已实测）。若不校验，客户端会把一个网页
 * 当清单解析，然后以千奇百怪的方式失败在下游。sha256 的 64 位 hex 断言是这里
 * 最有价值的一条——它让「拿到的根本不是清单」在第一时间就暴露。
 */
export function parseComponentsManifest(raw: unknown): ComponentsManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (m.schemaVersion !== 1) return null
  if (!Array.isArray(m.components) || m.components.length === 0) return null

  const components: ComponentEntry[] = []
  for (const c of m.components) {
    const entry = parseEntry(c)
    if (!entry) return null
    components.push(entry)
  }
  return {
    schemaVersion: 1,
    publishedAt: typeof m.publishedAt === 'number' ? m.publishedAt : 0,
    components
  }
}

function parseEntry(raw: unknown): ComponentEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (e.id !== 'cli' && e.id !== 'python-runtime') return null
  if (e.kind !== 'executable' && e.kind !== 'tar.gz') return null
  if (typeof e.required !== 'boolean') return null
  if (!e.artifacts || typeof e.artifacts !== 'object') return null

  const artifacts: Partial<Record<ComponentPlatform, ComponentArtifact>> = {}
  for (const [key, value] of Object.entries(e.artifacts as Record<string, unknown>)) {
    if (key !== 'darwin-arm64' && key !== 'darwin-x64' && key !== 'win32-x64') return null
    const artifact = parseArtifact(value)
    if (!artifact) return null
    // executable 必须带落盘文件名——没有它 worker 不知道该写成什么名字，
    // 而 cliDetect 正是按那个名字找二进制的。
    if (e.kind === 'executable' && !artifact.binName) return null
    artifacts[key] = artifact
  }
  if (Object.keys(artifacts).length === 0) return null

  return {
    id: e.id,
    kind: e.kind,
    required: e.required,
    ...(typeof e.stripComponents === 'number' ? { stripComponents: e.stripComponents } : {}),
    artifacts
  }
}

function parseArtifact(raw: unknown): ComponentArtifact | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (typeof a.version !== 'string' || a.version.length === 0) return null
  if (typeof a.file !== 'string' || a.file.length === 0) return null
  // 文件名只允许安全字符：它会被拼进 URL 与本地路径，放行 `/` 或 `..` 等于
  // 把远端清单变成一个任意写盘的原语。
  if (!/^[\w.+-]+$/.test(a.file)) return null
  if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) return null
  if (typeof a.size !== 'number' || !Number.isFinite(a.size) || a.size <= 0) return null
  if (typeof a.unpackedSize !== 'number' || !Number.isFinite(a.unpackedSize) || a.unpackedSize <= 0) return null
  if (a.encoding !== 'none' && a.encoding !== 'gzip') return null
  if (a.contentSha256 !== undefined && (typeof a.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.contentSha256)))
    return null
  if (a.source !== undefined && a.source !== 'fusion' && a.source !== 'official') return null
  if (a.url !== undefined && (typeof a.url !== 'string' || !/^https:\/\//.test(a.url))) return null
  if (typeof a.readyProbe !== 'string' || a.readyProbe.length === 0) return null
  // readyProbe / binName 都会被拼进本地路径，不能含跳出安装目录的成分。
  if (a.readyProbe.includes('..') || a.readyProbe.startsWith('/')) return null
  if (a.binName !== undefined && (typeof a.binName !== 'string' || !/^[\w.+-]+$/.test(a.binName))) return null

  return {
    version: a.version,
    file: a.file,
    sha256: a.sha256,
    size: a.size,
    unpackedSize: a.unpackedSize,
    encoding: a.encoding,
    readyProbe: a.readyProbe,
    ...(typeof a.binName === 'string' ? { binName: a.binName } : {}),
    ...(typeof a.source === 'string' ? { source: a.source as ComponentSource } : {}),
    ...(typeof a.url === 'string' ? { url: a.url } : {}),
    ...(typeof a.contentSha256 === 'string' ? { contentSha256: a.contentSha256 } : {})
  }
}
