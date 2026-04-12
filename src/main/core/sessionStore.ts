/**
 * Session store — a thin read-side wrapper over `@anthropic-ai/claude-agent-sdk`'s
 * session helpers. Fusion-code's CLI writes every turn to
 * `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`; here we let the
 * SDK do the reading and convert the result into shapes the renderer
 * already understands (`ThreadSummary` for the sidebar, `ThreadMessageLike`
 * for Thread view restoration).
 *
 * We deliberately do NOT write any session state ourselves. The jsonl
 * files are the single source of truth and fusion-code is the single
 * writer. All the main process does is read + map.
 */
import {
  getSessionMessages,
  listSessions as sdkListSessions,
  type SDKSessionInfo,
  type SessionMessage
} from '@anthropic-ai/claude-agent-sdk'
import type { ThreadMessageLike } from '@assistant-ui/react'

import type { ThreadSummary } from '../../shared/types'

const TAG = '[sessionStore]'

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

  for (const raw of raws) {
    if (raw.type !== 'user') continue
    const blocks = extractContentBlocks(raw.message)
    if (!blocks) continue
    for (const block of blocks) {
      if (!isRecord(block)) continue
      if (block.type !== 'tool_result') continue
      const toolUseId = block.tool_use_id
      if (typeof toolUseId !== 'string') continue
      resultByToolUseId.set(toolUseId, normalizeToolResultContent(block.content))
    }
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
      const parts = convertAssistantContent(raw.message, resultByToolUseId)
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

/* ─────────────────── content mapping ─────────────────── */

type ContentPart = { type: string; [key: string]: unknown }

function convertUserContent(message: unknown): ContentPart[] {
  const parts: ContentPart[] = []

  // User "content" can be either a bare string (text-only turn) or an
  // array of content blocks (mixed text/image/tool_result).
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
  resultByToolUseId: Map<string, unknown>
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
