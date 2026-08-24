/**
 * 断点续传的决策逻辑（纯计算，无 IO）。
 *
 * **为什么单独成文件**：download worker 是 utilityProcess 的子进程脚本——顶层
 * 就开跑，import 它等于执行它，没法在测试里安全加载。于是 workers/ 目录长期
 * 零测试覆盖。而这几段恰恰是最不该没测的：它们算错了不会抛异常，只会**静默
 * 产出一个损坏的 49MB 文件**，然后在 sha256 那步以「校验失败」的面目出现——
 * 真因被完全掩盖，用户得到的是「重下一遍还是失败」。抽出来才测得到。
 */

/** 退避阶梯。第 N 次重试等 BACKOFF_MS[N-1] 毫秒。 */
export const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const

/**
 * 续传前回退多少字节重下。
 *
 * 被杀掉的写流可能在 .part 末尾留下半个 chunk。直接从 `statSync` 的长度接着
 * 请求，会悄悄拼出一个损坏文件——而且**只有 sha256 能发现**，代价是整包白下
 * 一遍。回退 1MB 重下那一段来覆盖可能的撕裂尾巴，在 1.1MB/s 的线路上成本约
 * 一秒，比赌一把便宜太多。
 */
export const REWIND_BYTES = 1024 * 1024

export type ResumePlan =
  /** 从 0 开始下；调用方应删掉现有 .part。 */
  | { action: 'restart' }
  /** 字节已齐，跳过下载直接进校验（上次多半是在校验/解压阶段挂的）。 */
  | { action: 'complete' }
  /** 从 offset 续；调用方应先把 .part 截断到 offset。 */
  | { action: 'resume'; offset: number }

/**
 * 看着已有的 .part 大小，决定这一轮该从哪儿开始。
 *
 * @param existingBytes 磁盘上 .part 的当前字节数（没有则传 0）
 * @param expectedSize  清单声明的目标字节数；**0 表示未知**
 */
export function planResume(existingBytes: number, expectedSize: number): ResumePlan {
  // 目标大小未知就不冒险续传：没有 total 就无法校验服务器返回的分片是不是
  // 我们要的那段（见 checkContentRange），续传等于闭眼拼接。
  if (!Number.isFinite(expectedSize) || expectedSize <= 0) return { action: 'restart' }
  if (!Number.isFinite(existingBytes) || existingBytes <= 0) return { action: 'restart' }

  // 比目标还长只可能是异常（远端换了产物 / 上次写坏了）——续传只会拼出垃圾。
  if (existingBytes > expectedSize) return { action: 'restart' }
  if (existingBytes === expectedSize) return { action: 'complete' }

  const offset = existingBytes - Math.min(existingBytes, REWIND_BYTES)
  // 回退后归零就没有「续」可言了，退化成从头下，省掉一次没有意义的 Range 请求。
  return offset > 0 ? { action: 'resume', offset } : { action: 'restart' }
}

export interface ContentRangeCheck {
  ok: boolean
  /** ok=false 时的中文说明，可直接进错误文案。 */
  reason?: string
}

/**
 * 核对服务器返回的 206 分片确实是我们请求的那一段。
 *
 * 不能因为状态码是 206 就信：有些中间层（CDN / 网关）会返回 206 却给了另一段，
 * 或者在我们不知情时换了产物。拼错一段的后果同样是「sha256 校验失败」这种
 * 完全指不到真因的错误。
 *
 * @param header   响应的 Content-Range 头（缺失传 null）
 * @param offset   我们请求的起始字节
 * @param total    清单声明的文件总字节数
 */
export function checkContentRange(
  header: string | null | undefined,
  offset: number,
  total: number
): ContentRangeCheck {
  if (!header) return { ok: false, reason: 'Content-Range 缺失' }
  // HTTP 头大小写不敏感，空格数量也不保证——容错解析，别因为格式挑剔误杀。
  const m = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(header)
  if (!m) return { ok: false, reason: `Content-Range 无法解析：${header}` }

  const start = Number(m[1])
  const size = Number(m[3])
  if (start !== offset) {
    return { ok: false, reason: `服务器返回的分片起点是 ${start}，我们要的是 ${offset}` }
  }
  if (size !== total) {
    return { ok: false, reason: `远端文件大小是 ${size}，清单声明 ${total}——清单已过期` }
  }
  return { ok: true }
}

/** 第 attempt 次重试该等多久。超出档位数就停在最后一档，不越界。 */
export function backoffDelay(attempt: number): number {
  const i = Math.min(Math.max(1, attempt) - 1, BACKOFF_MS.length - 1)
  return BACKOFF_MS[i]!
}
