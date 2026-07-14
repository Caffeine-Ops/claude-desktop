/**
 * 问题反馈提交。渲染层不持有任何密钥——main 读 env.json 里的
 * FEEDBACK_WORKER_URL + FEEDBACK_HMAC_SECRET，给请求体签名后转发给反馈代理
 * Worker（apps/feedback-worker）。Worker 自己持有 GitHub Token，把截图传
 * R2、在目标仓库建 Issue，返回 issueUrl。
 *
 * 签名协议必须和 Worker 的 verifySignature 保持一致（见
 * apps/feedback-worker/src/index.ts）：
 *   HMAC-SHA256(secret, `${timestamp}:${nonce}:${rawBody}`) 十六进制。
 * 这不是强认证——密钥打包进客户端本质可被逆向提取，只挡住随手直连 Worker 的
 * 脚本；真正的滥用防线是 Worker 侧的 rate_limit binding（详见反馈调研的
 * 威胁模型结论）。
 */

import { createHmac, randomUUID } from 'node:crypto'
import { release } from 'node:os'
import { app } from 'electron'
import type { FeedbackSubmitPayload, FeedbackSubmitResult } from '../../shared/ipc-channels'

function sign(secret: string, timestamp: string, nonce: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}:${nonce}:${rawBody}`).digest('hex')
}

export async function submitFeedback(
  payload: FeedbackSubmitPayload
): Promise<FeedbackSubmitResult> {
  const workerUrl = process.env.FEEDBACK_WORKER_URL
  const hmacSecret = process.env.FEEDBACK_HMAC_SECRET
  if (!workerUrl || !hmacSecret) {
    return { error: '反馈功能未配置（缺 FEEDBACK_WORKER_URL / FEEDBACK_HMAC_SECRET）' }
  }
  if (!payload.description?.trim()) {
    return { error: '反馈内容不能为空' }
  }

  const body = {
    description: payload.description,
    appVersion: app.getVersion(),
    platform: process.platform,
    osVersion: release(),
    images: payload.images ?? []
  }
  const rawBody = JSON.stringify(body)
  const timestamp = String(Date.now())
  const nonce = randomUUID()
  const signature = sign(hmacSecret, timestamp, nonce, rawBody)

  try {
    const res = await fetch(`${workerUrl.replace(/\/+$/, '')}/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-feedback-timestamp': timestamp,
        'x-feedback-nonce': nonce,
        'x-feedback-signature': signature
      },
      body: rawBody
    })
    const json = (await res.json()) as { issueUrl?: string; error?: string }
    if (!res.ok || !json.issueUrl) {
      return { error: json.error ?? `反馈提交失败（${res.status}）` }
    }
    return { issueUrl: json.issueUrl }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
