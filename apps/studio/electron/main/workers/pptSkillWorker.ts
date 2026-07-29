import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import AdmZip from 'adm-zip'

/**
 * ppt-creator skill 的下载/校验/解压 worker（utilityProcess 子进程）。
 *
 * **为什么必须是子进程**：这个包压缩后 49MB、解压出 12167 个文件。sha256
 * 计算与解压都是 CPU 密集，12167 次写盘更是长时间占用事件循环——放 main
 * 里做会把所有 tab 的 engine 连同整个 UI 一起冻住（同 embedWorker/
 * kbBuildWorker 的既有教训：main 单线程，任何秒级同步工作都是全 app 卡顿）。
 * adm-zip 的 `extractAllToAsync` 名字里有 async，实现却是同步循环+回调，
 * 一样冻主线程，不能拿来当免死金牌。
 *
 * argv: [manifestUrl, installRoot, skillId, expectedSha256, expectedSize]
 * 消息协议（发给 main）：
 *   { type:'progress', phase:'downloading'|'extracting', done, total }
 *   { type:'done', ok:true, version }
 *   { type:'done', ok:false, error }
 */

const [manifestUrl, installRoot, skillId, expectedSha256, expectedSizeRaw] = process.argv.slice(2)

interface OutMsg {
  type: 'progress' | 'done'
  phase?: 'downloading' | 'extracting'
  done?: number
  total?: number
  ok?: boolean
  error?: string
}
const send = (msg: OutMsg): void => {
  process.parentPort?.postMessage(msg)
}

/** 进度节流：49MB 下载会产生成千上万个 chunk，每个都发一条消息只会把 IPC
 *  打爆、反过来拖慢 main。100ms 一条足够画平滑进度条。 */
const PROGRESS_THROTTLE_MS = 100

async function run(): Promise<void> {
  if (!manifestUrl || !installRoot || !skillId || !expectedSha256) {
    send({ type: 'done', ok: false, error: 'pptSkillWorker 参数不完整' })
    return
  }
  const expectedSize = Number(expectedSizeRaw) || 0

  // ── 下载（边下边算 sha256，避免把 49MB 再读一遍）────────────────────
  const res = await fetch(manifestUrl)
  if (!res.ok || !res.body) {
    send({ type: 'done', ok: false, error: `下载失败：HTTP ${res.status}` })
    return
  }
  // Content-Length 可能缺失（分块传输）——那时用清单里的 size 当分母，
  // 两者都没有则发 total:0，UI 退化成不确定进度条而不是显示 NaN%。
  const total = Number(res.headers.get('content-length')) || expectedSize
  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  let received = 0
  let lastTick = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const buf = Buffer.from(value)
    chunks.push(buf)
    hash.update(buf)
    received += buf.byteLength
    const now = Date.now()
    if (now - lastTick >= PROGRESS_THROTTLE_MS) {
      lastTick = now
      send({ type: 'progress', phase: 'downloading', done: received, total })
    }
  }
  send({ type: 'progress', phase: 'downloading', done: received, total: total || received })

  const actualSha = hash.digest('hex')
  if (actualSha !== expectedSha256) {
    // 校验不过绝不落盘：宁可没装，也不能把一个被篡改/截断的包解到用户机器上
    // 再交给 CLI 执行（这个包里全是会被跑起来的 Python 脚本）。
    send({
      type: 'done',
      ok: false,
      error: `校验失败：sha256 不匹配（期望 ${expectedSha256.slice(0, 12)}…，实际 ${actualSha.slice(0, 12)}…）`
    })
    return
  }

  // ── 解压到临时目录，再原子换名 ──────────────────────────────────────
  // 直接解到目标目录的话，中途失败会留下一个「装了一半」的 skill——CLI 照样
  // 会加载它，然后在缺文件的地方以千奇百怪的方式失败。同 daemon 安装器的
  // staging→rename 策略。
  const targetDir = join(installRoot, skillId)
  let staging: string | null = null
  try {
    mkdirSync(installRoot, { recursive: true })
    staging = mkdtempSync(join(tmpdir(), 'ppt-skill-'))
    const zip = new AdmZip(Buffer.concat(chunks))
    const entries = zip.getEntries()
    let extracted = 0
    lastTick = 0
    for (const entry of entries) {
      if (entry.isDirectory) continue
      // 路径穿越防御：zip 里的 entryName 是外部数据，`../` 能写到安装根之外。
      const dest = join(staging, entry.entryName)
      if (!dest.startsWith(staging + '/') && !dest.startsWith(staging + '\\')) {
        throw new Error(`zip 内路径越界：${entry.entryName}`)
      }
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, entry.getData())
      extracted += 1
      const now = Date.now()
      if (now - lastTick >= PROGRESS_THROTTLE_MS) {
        lastTick = now
        send({ type: 'progress', phase: 'extracting', done: extracted, total: entries.length })
      }
    }
    send({ type: 'progress', phase: 'extracting', done: extracted, total: entries.length })

    // fusion-code 认的插件清单——由安装器写而不是打进 zip：它是安装形态的
    // 一部分，不是 skill 内容（与 daemon 市场安装器的 pluginManifestContent
    // 保持逐字一致，两处产出必须同形，否则同一个包经两条路装出来行为不同）。
    const manifestDir = join(staging, '.claude-plugin')
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(
      join(manifestDir, 'plugin.json'),
      `${JSON.stringify(
        {
          name: 'cowork',
          version: '0.0.1',
          description:
            'Cowork skills market install root, exposed to the fusion-code agent as plugin skills (namespaced cowork:<skill>).',
          skills: './skills/'
        },
        null,
        2
      )}\n`
    )

    // 旧版本先挪走再换名，失败可回滚；成功后才删——避免「删了旧的、新的没上位」
    const trash = `${targetDir}.old-${process.pid}`
    const hadOld = existsSync(targetDir)
    if (hadOld) renameSync(targetDir, trash)
    try {
      renameSync(staging, targetDir)
    } catch (err) {
      if (hadOld) {
        try {
          renameSync(trash, targetDir)
        } catch {
          /* 回滚也失败——原样把首个错误抛出去，别用回滚错误盖掉真因 */
        }
      }
      throw err
    }
    staging = null
    if (hadOld) rmSync(trash, { recursive: true, force: true })
    send({ type: 'done', ok: true })
  } catch (err) {
    if (staging) rmSync(staging, { recursive: true, force: true })
    send({ type: 'done', ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

void run().catch((err: unknown) => {
  send({ type: 'done', ok: false, error: err instanceof Error ? err.message : String(err) })
})
