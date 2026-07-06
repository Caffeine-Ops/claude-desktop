/**
 * 方案草稿持久层（main 侧）。每会话一个 JSON 文件存在 userData/proposal-drafts/，
 * 与会话 JSONL（transcript）解耦：transcript 兜底 AI 正文，本层额外保住用户手改
 * （逐节编辑/重排/删节/产品 chip）。LRU 只留 mtime 最新的 MAX_DRAFTS 份。
 *
 * 路径惰性求值（draftsDir 内才调 app.getPath），避免模块加载期触发 "app not ready"
 * （范式同 kbIndexStore.ts）。所有读写防御式 try/catch——持久化失败绝不冒泡阻塞调用方。
 */
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile, unlink, readdir, stat } from 'node:fs/promises'
import type { ProposalDraftRecord } from '../../shared/ipc-channels'

const TAG = '[proposalDraftStore]'
/** 磁盘上最多保留的草稿份数（LRU 上限）。超出按 mtime 淘汰最旧。 */
const MAX_DRAFTS = 10

const draftsDir = (): string => join(app.getPath('userData'), 'proposal-drafts')
const draftPath = (sessionId: string): string => join(draftsDir(), `${sessionId}.json`)

function ensureDir(): void {
  const dir = draftsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** 写入一份草稿后跑 LRU 淘汰。调用方已校验 record 基本合法。 */
export async function saveProposalDraft(record: ProposalDraftRecord): Promise<void> {
  ensureDir()
  await writeFile(draftPath(record.sessionId), JSON.stringify(record), 'utf8')
  await evictOldDrafts()
}

/** 读出某会话草稿。文件不存在 / 解析失败 / 版本或 id 不匹配 → null。 */
export async function loadProposalDraft(
  sessionId: string
): Promise<ProposalDraftRecord | null> {
  const p = draftPath(sessionId)
  if (!existsSync(p)) return null
  try {
    const rec = JSON.parse(await readFile(p, 'utf8')) as ProposalDraftRecord
    if (rec?.version !== 1 || rec.sessionId !== sessionId) return null
    return rec
  } catch (err) {
    console.warn(`${TAG} loadProposalDraft ${sessionId} failed:`, err)
    return null
  }
}

/** 删除某会话草稿文件（「清空草稿」用）。不存在或删除失败均静默。 */
export async function deleteProposalDraft(sessionId: string): Promise<void> {
  const p = draftPath(sessionId)
  try {
    if (existsSync(p)) await unlink(p)
  } catch (err) {
    console.warn(`${TAG} deleteProposalDraft ${sessionId} failed:`, err)
  }
}

/** LRU：保留 mtime 最新的 MAX_DRAFTS 个 .json，其余删除。当前刚写那份 mtime 最新、永不自删。 */
async function evictOldDrafts(): Promise<void> {
  const dir = draftsDir()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const files = names.filter((n) => n.endsWith('.json'))
  if (files.length <= MAX_DRAFTS) return
  const withMtime = await Promise.all(
    files.map(async (n) => {
      try {
        const s = await stat(join(dir, n))
        return { name: n, mtime: s.mtimeMs }
      } catch {
        return { name: n, mtime: 0 }
      }
    })
  )
  withMtime.sort((a, b) => b.mtime - a.mtime) // 新 → 旧
  for (const f of withMtime.slice(MAX_DRAFTS)) {
    try {
      await unlink(join(dir, f.name))
    } catch (err) {
      console.warn(`${TAG} evict ${f.name} failed:`, err)
    }
  }
}
