/**
 * 问题反馈提交。原先经 HMAC 签名转发给自建 Cloudflare Worker、由 Worker 建
 * GitHub Issue；现改为直接提交给 sub2api 的 `/api/v1/feedback`，走
 * {@link authedPost}（JWT 鉴权 + 401 自动续期重放一次），后端从 token 解出
 * 当前用户，admin 面板可直接查看提交人的用户名/邮箱。未登录时 authedPost
 * 会返回 `NOT_SIGNED_IN`，翻成「请先登录」而不是报网络错误。
 */

import { release } from 'node:os'
import { app } from 'electron'
import type { FeedbackSubmitPayload, FeedbackSubmitResult } from '../../shared/ipc-channels'
import { authedPost, translateError } from './authService'

interface FeedbackSubmitResponse {
  id: number
}

export async function submitFeedback(
  payload: FeedbackSubmitPayload
): Promise<FeedbackSubmitResult> {
  if (!payload.description?.trim()) {
    return { error: '反馈内容不能为空' }
  }

  const body = {
    kind: payload.kind,
    description: payload.description,
    app_version: app.getVersion(),
    platform: process.platform,
    os_version: release(),
    attachments: (payload.images ?? []).map((img) => ({
      filename: img.filename,
      content_type: img.contentType,
      data_base64: img.dataBase64
    }))
  }

  const result = await authedPost<FeedbackSubmitResponse>('/api/v1/feedback', body)
  if (!result.ok) {
    return { error: translateError(result.reason, result.message, '反馈提交失败，请稍后重试') }
  }
  return { ok: true }
}
