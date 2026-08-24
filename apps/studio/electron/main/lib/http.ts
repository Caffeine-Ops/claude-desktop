/**
 * 带死线的 fetch —— 主进程网络调用的统一入口。
 *
 * ## 为什么需要它
 *
 * 没有超时的网络调用不是「慢」，是「永久泄漏一个挂起状态」：用户端表现为
 * 转圈不停、没有错误也没有重试入口，我们这端表现为一个永不 settle 的
 * Promise。首启拉运行时组件清单那处踩得最狠——ComponentGate 那道全屏门
 * 就吊在它上面，卡住等于整个应用打不开。
 *
 * ## 为什么死线要盖到 body 读完，而不是只盖到响应头
 *
 * `core/kbSync.ts` 里有一个同名的私有实现（**刻意不合并**，见文末），它在
 * 拿到 Response 后就 clearTimeout 了。那套语义对流式下载是对的，但对
 * 「拉一个 JSON」是漏的：
 *
 *     const res = await fetch(url)          // 只有这行被看管
 *     const data = await res.json()         // 服务器发完 headers 就装死 → 照样永久挂起
 *
 * 「发了响应头然后不吐 body」在弱网/半开连接下是真实场景，而调用方几乎总要
 * 再 await 一次读 body。所以这里**成功后不清定时器**，让 signal 一直守到
 * body 读完；代价是进程里多一个 pending timer，用 `unref()` 抵消——unref 过的
 * 定时器不会阻止 Node 事件循环退出，所以不会拖慢应用关闭。
 *
 * ## 为什么不带重试
 *
 * 因为调用方已经有自己的重试策略，且各不相同：`imageGenService` 是「重试 N 次
 * 再降级到下一个模型」，`workers/componentWorker` 是「无字节间隔超时 + 断点续传
 * + 五档退避」。在这里再套一层通用重试会与它们**叠乘**（3 × 3 = 9 次请求），
 * 把用户的等待时间翻几倍。超时是补缺陷，重试是改策略，两件事分开做。
 *
 * ## 什么时候【不要】用它
 *
 * - **流式代理**（`services/appProtocol.ts` 的反向代理）：转发的是持续吐字节的
 *   长连接，总时长死线会在传输中途把它掐断，制造出比原问题更糟的 bug。
 * - **大文件下载**（`workers/pptSkillWorker` 的 49MB 技能包）：出口带宽 1MB/s 时
 *   一次合法下载本就要一两分钟，总时长根本区分不了「慢」和「死」。那里要的是
 *   「无字节间隔超时」——照 `workers/componentWorker.ts` 的成熟做法，不是这个。
 */

/** 探测类：打本地回环（daemon / dev server），不通就是不通，不用等。 */
export const PROBE_TIMEOUT_MS = 3_000

/** 常规 API：拉清单、登录、取模型列表、生图接口。 */
export const API_TIMEOUT_MS = 15_000

/**
 * LLM 类：语音转写这种本来就慢的调用。
 * 给到 5 分钟是因为转写支持多分钟录音（见 ipc/register.ts 的 maxOutputTokens 注释），
 * 按 API 档位掐会误杀正常功能——死线的作用是兜住「永远不回」，不是催快。
 */
export const LLM_TIMEOUT_MS = 300_000

/**
 * 超时专用错误。
 *
 * 单独立一个类，是为了让上层能 `instanceof` 区分「对方没响应」和「对方明确拒绝」
 * ——这两者该给用户的提示完全不同。message 直接写成中文，因为它会一路冒泡到
 * UI；原生 abort 抛出来的 "The operation was aborted" 对用户毫无意义。
 */
export class HttpTimeoutError extends Error {
  readonly url: string
  readonly timeoutMs: number

  constructor(url: string, timeoutMs: number) {
    super(`网络请求超时（${Math.round(timeoutMs / 1000)} 秒内无响应）：${url}`)
    this.name = 'HttpTimeoutError'
    this.url = url
    this.timeoutMs = timeoutMs
  }
}

/**
 * 只要求「吃一个 string URL + init，还一个 Response」——本函数用到的全部。
 *
 * 刻意不写成 `typeof fetch`：Electron 的 `net.fetch` 不接受 `URL` 对象，
 * 用全局 fetch 的完整签名去要求它会类型不兼容。而我们第一参本来就只收
 * string，多要的那部分能力一次也用不上——**依赖的接口只该要求自己真正
 * 用到的部分**，多要一分就少一个能传进来的实现。
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface FetchWithTimeoutOptions {
  /** 死线，毫秒。默认 {@link API_TIMEOUT_MS}。 */
  timeoutMs?: number
  /**
   * 用哪个 fetch 实现。默认全局 fetch（Node/undici）。
   *
   * **刻意做成可注入而不是在这里替调用方选**：主进程里同时存在两种 fetch——
   * `ipc/register.ts` 用 Electron 的 `net.fetch`（走 Chromium 网络栈，因此吃系统
   * 代理设置），其余用 Node 全局 fetch。替调用方改掉用哪个，等于在「加超时」的
   * 名义下悄悄改了代理行为。顺带也让测试能塞假实现进来。
   */
  fetchImpl?: FetchLike
}

/**
 * 发一个带死线的请求。签名与原生 `fetch` 对齐，只多一个可选的第三参，
 * 所以改造调用点时把 `fetch(` 换成 `fetchWithTimeout(` 即可，其余一字不动。
 *
 * 到点后抛 {@link HttpTimeoutError}；调用方自己传的 `init.signal` 依然有效，
 * 且**由它触发的取消不会被误报成超时**（用户主动取消和服务器没响应是两回事）。
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  opts?: FetchWithTimeoutOptions
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? API_TIMEOUT_MS
  const impl: FetchLike = opts?.fetchImpl ?? fetch

  const timeoutCtrl = new AbortController()
  const timer = setTimeout(() => {
    // abort(reason) 会让 signal.reason 变成这个错误，fetch 与后续的 body 读取
    // 都以它 reject —— 于是「人话错误」在两个阶段都成立，无需各写一遍。
    timeoutCtrl.abort(new HttpTimeoutError(url, timeoutMs))
  }, timeoutMs)
  // 不阻止进程退出：定时器故意活到超时点（要守 body 读取），但它不该成为
  // 应用关不掉的原因。Node 的 unref 定时器在事件循环没有别的活儿时不算数。
  timer.unref?.()

  // 调用方也传了 signal 就合并成一个：任一方 abort 都生效。
  const caller = init?.signal
  const signal = caller ? AbortSignal.any([timeoutCtrl.signal, caller]) : timeoutCtrl.signal

  try {
    return await impl(url, { ...init, signal })
  } catch (err) {
    clearTimeout(timer) // 失败即终局，没有 body 要守了
    // 是谁掐的？超时抛人话错误，调用方主动取消则原样上抛——把用户点的
    // 「取消」翻译成「超时」会让日志和 UI 一起说谎。
    if (timeoutCtrl.signal.aborted) throw timeoutCtrl.signal.reason
    throw err
  }
  // 成功路径**刻意不 clearTimeout**：见文件头注释，死线要继续守着 body 读取。
}
