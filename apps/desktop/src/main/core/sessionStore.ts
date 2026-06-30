/**
 * Session store — a thin read-side wrapper over `@anthropic-ai/claude-agent-sdk`'s
 * session helpers. Fusion-code's CLI writes every turn to
 * `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`; here we let the
 * SDK do the reading and convert the result into shapes the renderer
 * already understands (`ThreadSummary` for the sidebar, `ThreadMessageLike`
 * for Thread view restoration).
 *
 * One narrow exception to "read-only": `renameSession` appends a single
 * `{"type":"custom-title", ...}` line to the existing jsonl. Fusion-code's
 * own `/rename` slash command writes the exact same line, and the SDK's
 * listSessions reader greps for `customTitle` regardless of who wrote it,
 * so this stays compatible with upstream behavior. Append-only means we
 * never race fusion-code's writes to the active turn.
 */
import { appendFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  getSessionMessages,
  listSessions as sdkListSessions,
  type SDKSessionInfo,
  type SessionMessage
} from '@anthropic-ai/claude-agent-sdk'
import type { ThreadMessageLike } from '@assistant-ui/react'

import type { ThreadSummary, WorkflowTask } from '../../shared/types'

const TAG = '[sessionStore]'

// Mirrors the SDK's project-dir name cap (sdk.mjs: `_J`). Names whose
// sanitized form exceeds this get truncated and suffixed with a hash —
// we handle that case with a prefix scan in `findSessionJsonl` below.
const PROJECT_NAME_MAX_LEN = 200

/**
 * List all sessions for a workspace, newest first. Wraps the SDK's
 * `listSessions({ dir })` and maps `SDKSessionInfo` → `ThreadSummary`.
 *
 * Returns an empty array on:
 *   - null workspaceDir (before the workspace gate has been passed)
 *   - no fusion-code transcripts under that workspace yet
 *   - SDK read error (logged; the sidebar should not crash on a bad file)
 */
export async function listSessions(
  workspaceDir: string | null
): Promise<ThreadSummary[]> {
  if (!workspaceDir) return []
  try {
    const infos = await sdkListSessions({
      dir: workspaceDir,
      // Stay single-branch: avoid surfacing every worktree's session as
      // a separate row when the user only wanted the current one.
      // Can flip true once we have a worktree selector.
      includeWorktrees: false
    })
    return infos
      .map(toThreadSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch (err) {
    console.warn(`${TAG} listSessions failed for ${workspaceDir}:`, err)
    return []
  }
}

/**
 * Load a single session's full message history, mapped into the
 * assistant-ui ThreadMessageLike shape the chat store already consumes.
 *
 * Returns `[]` on error or unknown session so the UI can fall back on a
 * blank thread rather than crash.
 */
export async function loadSession(
  sessionId: string,
  workspaceDir: string | null
): Promise<ThreadMessageLike[]> {
  if (!workspaceDir) return []
  try {
    const raws = await getSessionMessages(sessionId, {
      dir: workspaceDir
    })
    return convertSdkMessages(raws)
  } catch (err) {
    console.warn(`${TAG} loadSession ${sessionId} failed:`, err)
    return []
  }
}

/**
 * Rename a session by appending a `custom-title` line to its jsonl.
 *
 * The SDK's listSessions reads `customTitle` (and `aiTitle`) by grepping
 * the file text, with the LAST occurrence winning, so multiple renames
 * just keep working. Fusion-code's own `/rename` slash command writes
 * the exact same shape, so we stay compatible with the upstream format.
 *
 * Throws if the workspace is unset or the jsonl file can't be located.
 * The caller is expected to broadcast `sessionListChanged` after a
 * successful rename so the sidebar re-pulls the title.
 */
export async function renameSession(
  sessionId: string,
  customTitle: string,
  workspaceDir: string | null
): Promise<void> {
  if (!workspaceDir) throw new Error('Workspace not set')
  const filePath = await findSessionJsonl(workspaceDir, sessionId)
  if (!filePath) {
    throw new Error(`Session jsonl not found for ${sessionId}`)
  }
  const line =
    JSON.stringify({ type: 'custom-title', customTitle, sessionId }) + '\n'
  await appendFile(filePath, line, 'utf8')
}

/**
 * Locate the on-disk jsonl for a sessionId under a given workspace.
 *
 * The SDK derives the project dir name by replacing every non-alnum
 * char with `-`. For names ≤ 200 chars that's the whole story; longer
 * names get truncated to 200 and suffixed with a hash, so for those we
 * fall back to a prefix scan of `~/.claude/projects`.
 *
 * Returns `null` when no matching file exists (caller decides how loud
 * that is — rename treats it as an error, future "delete session" might
 * treat it as a no-op).
 */
async function findSessionJsonl(
  workspaceDir: string,
  sessionId: string
): Promise<string | null> {
  const projectsDir = join(homedir(), '.claude', 'projects')
  const sanitized = workspaceDir.replace(/[^a-zA-Z0-9]/g, '-')

  if (sanitized.length <= PROJECT_NAME_MAX_LEN) {
    const direct = join(projectsDir, sanitized, `${sessionId}.jsonl`)
    if (await fileExists(direct)) return direct
    // Fall through — workspace might have been opened under a sibling
    // worktree that hashes to a different prefix. Cheap to try the scan.
  }

  const prefix = sanitized.slice(0, PROJECT_NAME_MAX_LEN)
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory()) continue
      // Either an exact short-name match or a "<prefix>-<hash>" long-name match.
      if (e.name !== sanitized && !e.name.startsWith(`${prefix}-`)) continue
      const candidate = join(projectsDir, e.name, `${sessionId}.jsonl`)
      if (await fileExists(candidate)) return candidate
    }
  } catch (err) {
    console.warn(`${TAG} findSessionJsonl scan failed:`, err)
  }
  return null
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isFile()
  } catch {
    return false
  }
}

/* ─────────────────── Mapping helpers ─────────────────── */

function toThreadSummary(info: SDKSessionInfo): ThreadSummary {
  return {
    id: info.sessionId,
    title: info.customTitle ?? info.summary ?? info.firstPrompt ?? 'New chat',
    updatedAt: info.lastModified,
    firstPrompt: info.firstPrompt,
    turnCount: 0
  }
}

/**
 * Convert a raw SDK SessionMessage[] stream (read verbatim from the
 * JSONL transcript) into the assistant-ui ThreadMessageLike[] shape the
 * chat store stores.
 *
 * Key mapping rules (kept in sync with renderer's chat.ts content-part
 * definitions):
 *
 *   Anthropic ContentBlock   →  assistant-ui ContentPart
 *   ──────────────────────────────────────────────────────────
 *   { type: 'text' }              { type: 'text', text }
 *   { type: 'image' }             { type: 'image', image: dataUrl }
 *   { type: 'tool_use' }          { type: 'tool-call', toolCallId, toolName, args, argsComplete }
 *   { type: 'tool_result' }       merged into the matching tool-call's `result` field
 *
 * tool_use / tool_result appear on DIFFERENT jsonl entries:
 *   - tool_use lives on an assistant message's content
 *   - tool_result lives on the FOLLOWING user message's content (the
 *     CLI auto-generates that user entry when the tool finishes running)
 *
 * That means a single-pass conversion can't populate `result` because the
 * tool_result hasn't been seen yet when we hit the tool_use. So we scan
 * twice:
 *
 *   Pass 1: walk every user message's content blocks, collect all
 *           tool_result blocks into a Map<toolUseId, result>.
 *   Pass 2: walk every message in order. For user messages, emit a
 *           ThreadMessageLike only when the content has at least one
 *           text / image part (a pure-tool_result user turn is an
 *           implementation detail, not something to show to the user).
 *           For assistant messages, map content blocks and fill in
 *           tool_result from the map built in pass 1.
 */
export function convertSdkMessages(
  raws: readonly SessionMessage[]
): ThreadMessageLike[] {
  const resultByToolUseId = new Map<string, unknown>()
  // Workflow/Task completion records, keyed by the spawning Workflow
  // tool-call's id. On a live run these subtasks arrive as `task_update`
  // events and the renderer merges them onto the card; on history replay
  // there are no such events, so we reconstruct them here from the
  // `<task-notification>` user message the workflow injected at
  // completion — otherwise the deliverable vanishes after a reload.
  const tasksByToolUseId = new Map<string, WorkflowTask[]>()

  for (const raw of raws) {
    if (raw.type !== 'user') continue
    const blocks = extractContentBlocks(raw.message)
    if (blocks) {
      for (const block of blocks) {
        if (!isRecord(block)) continue
        if (block.type !== 'tool_result') continue
        const toolUseId = block.tool_use_id
        if (typeof toolUseId !== 'string') continue
        resultByToolUseId.set(
          toolUseId,
          normalizeToolResultContent(block.content)
        )
      }
    }
    // The completion notification is a plain-text user message, not a
    // block array, so it isn't in `blocks` above — pull it off the raw
    // string content separately.
    collectTaskNotification(raw.message, tasksByToolUseId)
  }

  const out: ThreadMessageLike[] = []

  for (const raw of raws) {
    if (raw.type === 'system') continue

    if (raw.type === 'user') {
      const parts = convertUserContent(raw.message)
      if (parts.length === 0) continue
      out.push({
        id: raw.uuid,
        role: 'user',
        content: parts as unknown as ThreadMessageLike['content']
      })
      continue
    }

    if (raw.type === 'assistant') {
      const parts = convertAssistantContent(
        raw.message,
        resultByToolUseId,
        tasksByToolUseId
      )
      if (parts.length === 0) continue
      out.push({
        id: raw.uuid,
        role: 'assistant',
        content: parts as unknown as ThreadMessageLike['content']
      })
    }
  }

  return out
}

/**
 * If `message` is a workflow's `<task-notification>` completion record,
 * parse it into a `WorkflowTask` and stash it under its spawning
 * tool-use id. Mirrors engine.ts `parseTaskNotification` so live and
 * replayed cards look identical. No-op for anything else.
 */
function collectTaskNotification(
  message: unknown,
  into: Map<string, WorkflowTask[]>
): void {
  const content = isRecord(message) ? message.content : undefined
  if (typeof content !== 'string') return
  if (!content.includes('<task-notification>')) return

  const tag = (name: string): string | undefined => {
    const m = content.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
    return m ? m[1].trim() : undefined
  }
  const taskId = tag('task-id')
  const toolUseId = tag('tool-use-id')
  if (!taskId || !toolUseId) return

  const rawStatus = tag('status')
  const status: WorkflowTask['status'] =
    rawStatus === 'completed'
      ? 'completed'
      : rawStatus === 'stopped'
        ? 'stopped'
        : 'failed'

  const rawResult = tag('result')
  let result = rawResult
  if (rawResult) {
    try {
      const parsed = JSON.parse(rawResult)
      if (isRecord(parsed) && typeof parsed.summary === 'string') {
        result = parsed.summary
      }
    } catch {
      // keep raw
    }
  }

  const task: WorkflowTask = {
    taskId,
    status,
    summary: tag('summary'),
    result,
    outputFile: tag('output-file')
  }
  const list = into.get(toolUseId) ?? []
  list.push(task)
  into.set(toolUseId, list)
}

/* ─────────────────── content mapping ─────────────────── */

type ContentPart = { type: string; [key: string]: unknown }

/**
 * True for `user` messages that are fusion-code housekeeping injections
 * rather than human input — currently the `<task-notification>` block a
 * backgrounded task/workflow posts on completion. These belong on the
 * spawning tool card, not in the transcript as a user bubble. Matched on
 * the leading tag (trimmed) so we don't accidentally hide a real message
 * that merely mentions the word elsewhere.
 */
function isInjectedAgentMessage(text: string): boolean {
  return text.trimStart().startsWith('<task-notification>')
}

/**
 * Slash-command turns are stored in the JSONL with an XML skeleton, not as
 * the friendly text the human typed. The CLI writes three flavours:
 *
 *   1. The invocation itself —
 *        <command-message>name</command-message>
 *        <command-name>/name</command-name>
 *        <command-args>the actual user input</command-args>
 *      (`<command-message>` and `<command-args>` are optional). Without
 *      cleanup the renderer paints the raw tags into a user bubble, which
 *      is exactly the "format looks wrong" report. We rebuild the human
 *      intent as `/name args` so the bubble reads like what was typed.
 *
 *   2. Local-command bookkeeping — a `<local-command-caveat>` preamble and
 *      a `<local-command-stdout>` result (e.g. the line `/clear` prints).
 *      Neither is human input; collapse the whole message to empty so the
 *      caller drops the turn entirely.
 *
 * Anything without these tags is returned unchanged. We deliberately do
 * the matching here (main side, on replay) rather than in the renderer so
 * the chat store never holds the raw skeleton.
 */
function cleanUserCommandText(text: string): string {
  const trimmed = text.trimStart()

  // Pure CLI bookkeeping — not something the human said. Drop it.
  if (
    trimmed.startsWith('<local-command-stdout>') ||
    trimmed.startsWith('<local-command-caveat>')
  ) {
    return ''
  }

  // Not a slash-command skeleton → leave it exactly as-is.
  if (!trimmed.startsWith('<command-')) return text

  const tag = (name: string): string | undefined => {
    const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
    return m ? m[1].trim() : undefined
  }

  // `<command-name>` already includes the leading slash (and any plugin
  // prefix like `claude-desktop:ppt-master`). Fall back to the bare
  // `<command-message>` label if the name tag is somehow missing.
  const name = tag('command-name') ?? tag('command-message')
  if (!name) return text

  const args = tag('command-args')
  return args ? `${name} ${args}` : name
}

function convertUserContent(message: unknown): ContentPart[] {
  const parts: ContentPart[] = []

  // User "content" can be either a bare string (text-only turn) or an
  // array of content blocks (mixed text/image/tool_result).
  const raw = isRecord(message) ? message.content : undefined
  if (typeof raw === 'string') {
    // A backgrounded task/workflow's completion is injected into the
    // agent loop as a `user` message whose content is a
    // `<task-notification>…</task-notification>` block — it is NOT
    // something the human typed. The live path routes it into the
    // spawning tool card (engine `tryEmitTaskUpdate`); on history replay
    // we must drop it here too, otherwise the raw XML resurfaces as a
    // blue user bubble. Returning no parts makes the caller skip it.
    if (isInjectedAgentMessage(raw)) return parts
    // Rewrite slash-command XML skeletons into `/name args` (and drop pure
    // local-command bookkeeping) before they reach the bubble.
    const cleaned = cleanUserCommandText(raw)
    if (cleaned.length > 0) parts.push({ type: 'text', text: cleaned })
    return parts
  }
  if (!Array.isArray(raw)) return parts

  for (const block of raw) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      if (isInjectedAgentMessage(block.text)) continue
      const cleaned = cleanUserCommandText(block.text)
      if (cleaned.length > 0) parts.push({ type: 'text', text: cleaned })
      continue
    }
    if (block.type === 'image') {
      const dataUrl = toImageDataUrl(block.source)
      if (dataUrl) parts.push({ type: 'image', image: dataUrl })
      continue
    }
    // tool_result blocks stay out of the user message — they get
    // merged into the prior assistant's tool-call in pass 2.
  }

  return parts
}

function convertAssistantContent(
  message: unknown,
  resultByToolUseId: Map<string, unknown>,
  tasksByToolUseId: Map<string, WorkflowTask[]>
): ContentPart[] {
  const parts: ContentPart[] = []
  const raw = isRecord(message) ? message.content : undefined
  if (typeof raw === 'string') {
    if (raw.length > 0) parts.push({ type: 'text', text: raw })
    return parts
  }
  if (!Array.isArray(raw)) return parts

  for (const block of raw) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'tool_use') {
      const id = typeof block.id === 'string' ? block.id : ''
      const name = typeof block.name === 'string' ? block.name : 'tool'
      if (!id) continue
      const part: ContentPart = {
        type: 'tool-call',
        toolCallId: id,
        toolName: name,
        args: block.input ?? {},
        argsComplete: true
      }
      const result = resultByToolUseId.get(id)
      if (result !== undefined) part.result = result
      // Re-attach any workflow subtasks reconstructed from completion
      // notifications so the replayed card shows them just like live.
      const tasks = tasksByToolUseId.get(id)
      if (tasks && tasks.length > 0) part.tasks = tasks
      parts.push(part)
      continue
    }
    if (block.type === 'image') {
      const dataUrl = toImageDataUrl(block.source)
      if (dataUrl) parts.push({ type: 'image', image: dataUrl })
    }
  }

  return parts
}

/**
 * Pull the `content` array off an SDK message, handling both the plain
 * Anthropic shape (`{ role, content }`) and the SDK's occasional
 * `{ message: { role, content } }` nesting.
 */
function extractContentBlocks(message: unknown): readonly unknown[] | null {
  if (!isRecord(message)) return null
  const content = message.content ?? (isRecord(message.message) ? message.message.content : undefined)
  if (Array.isArray(content)) return content
  return null
}

/**
 * tool_result.content can be a plain string, a ContentBlock array (with
 * text / image parts), or occasionally a single object. Normalize to a
 * stringifiable value the renderer's ToolCallCard can show.
 */
function normalizeToolResultContent(content: unknown): unknown {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    // Join text parts; drop images (the card renders text-only results).
    const texts: string[] = []
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text)
      }
    }
    if (texts.length > 0) return texts.join('\n')
    return content
  }
  return content
}

/**
 * Convert an Anthropic image source (`{ type: 'base64', media_type, data }`)
 * to a `data:` URL the renderer uses verbatim. Returns null on any shape
 * mismatch so the caller can simply drop the block.
 */
function toImageDataUrl(source: unknown): string | null {
  if (!isRecord(source)) return null
  if (source.type !== 'base64') return null
  const mediaType = source.media_type
  const data = source.data
  if (typeof mediaType !== 'string' || typeof data !== 'string') return null
  return `data:${mediaType};base64,${data}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
