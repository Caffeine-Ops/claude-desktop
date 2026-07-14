/**
 * claude-desktop 问题反馈代理服务。
 *
 * 客户端（Electron 主进程）→ 本 Worker → GitHub。
 * 客户端不持有 GITHUB_TOKEN；本 Worker 用 HMAC 请求签名确认调用方是合法客户端，
 * 而非任意脚本直接 curl（详见 README.md 的威胁模型说明——这不是强认证，只挡随手调用）。
 *
 * 流程：校验签名 → 按 IP 限流 → 图片逐张 PUT 进 R2 拿公开 URL → 拼 Markdown → 创建 GitHub Issue。
 */

interface FeedbackImage {
  filename: string;
  contentType: string;
  dataBase64: string;
}

interface FeedbackPayload {
  description: string;
  appVersion: string;
  platform: string;
  osVersion: string;
  images?: FeedbackImage[];
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // base64 前的估算上限，压缩已在客户端做过
const MAX_DESCRIPTION_LENGTH = 8000;
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000; // 时间戳容忍窗口，防重放
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

// Env 类型来自 worker-configuration.d.ts（`wrangler types` 生成，勿手写）
// + env.d.ts（补充 GITHUB_TOKEN/HMAC_SECRET 两个密钥字段）。

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function verifySignature(
  env: Env,
  rawBody: string,
  timestamp: string,
  nonce: string,
  signatureHex: string,
): Promise<boolean> {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIGNATURE_WINDOW_MS) {
    return false;
  }

  const expectedBytes = hexToBytes(signatureHex);
  if (!expectedBytes) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.HMAC_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}:${nonce}:${rawBody}`),
  );

  // timingSafeEqual 要求等长；长度不等直接判失败（不影响时序安全性，长度本身不是秘密）。
  const actual = new Uint8Array(signature);
  if (actual.byteLength !== expectedBytes.byteLength) return false;
  return crypto.subtle.timingSafeEqual(actual, expectedBytes);
}

function validatePayload(body: unknown): FeedbackPayload | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  if (typeof b.description !== "string" || b.description.trim().length === 0) return null;
  if (b.description.length > MAX_DESCRIPTION_LENGTH) return null;
  if (typeof b.appVersion !== "string" || typeof b.platform !== "string" || typeof b.osVersion !== "string") {
    return null;
  }

  let images: FeedbackImage[] = [];
  if (b.images !== undefined) {
    if (!Array.isArray(b.images) || b.images.length > MAX_IMAGES) return null;
    for (const img of b.images) {
      if (typeof img !== "object" || img === null) return null;
      const i = img as Record<string, unknown>;
      if (typeof i.filename !== "string" || typeof i.contentType !== "string" || typeof i.dataBase64 !== "string") {
        return null;
      }
      if (!ALLOWED_IMAGE_TYPES.has(i.contentType)) return null;
      // base64 长度粗估字节数，挡掉明显超限的请求（真实大小在解码后再核实一次）。
      if (i.dataBase64.length > (MAX_IMAGE_BYTES * 4) / 3) return null;
      images.push({ filename: i.filename, contentType: i.contentType, dataBase64: i.dataBase64 });
    }
  }

  return {
    description: b.description,
    appVersion: b.appVersion,
    platform: b.platform,
    osVersion: b.osVersion,
    images,
  };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function extensionFor(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

async function uploadImages(env: Env, images: FeedbackImage[], submissionId: string): Promise<string[]> {
  const urls: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const image = images[i]!;
    const bytes = base64ToBytes(image.dataBase64);
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`image ${i} exceeds size limit after decoding`);
    }
    const key = `feedback/${submissionId}-${i}.${extensionFor(image.contentType)}`;
    await env.FEEDBACK_ASSETS.put(key, bytes, {
      httpMetadata: { contentType: image.contentType },
    });
    urls.push(`${env.R2_PUBLIC_BASE_URL}/${key}`);
  }
  return urls;
}

function buildIssueBody(payload: FeedbackPayload, imageUrls: string[]): string {
  const lines: string[] = [
    payload.description.trim(),
    "",
    "---",
    `**App 版本**: ${payload.appVersion}`,
    `**平台**: ${payload.platform} (${payload.osVersion})`,
  ];
  if (imageUrls.length > 0) {
    lines.push("", "**截图**:");
    for (const [i, url] of imageUrls.entries()) {
      lines.push(`![screenshot-${i + 1}](${url})`);
    }
  }
  return lines.join("\n");
}

function buildIssueTitle(description: string): string {
  const firstLine = description.trim().split("\n")[0] ?? "";
  const truncated = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  return truncated || "用户反馈";
}

async function createGithubIssue(env: Env, title: string, body: string): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "claude-desktop-feedback-worker",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ title, body }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub issue creation failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const json = (await response.json()) as { html_url: string };
  return json.html_url;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }

    const url = new URL(request.url);
    if (url.pathname !== "/submit") {
      return jsonResponse({ error: "not found" }, 404);
    }

    const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
    const rateLimitOutcome = await env.FEEDBACK_RATE_LIMITER.limit({ key: clientIp });
    if (!rateLimitOutcome.success) {
      return jsonResponse({ error: "too many requests" }, 429);
    }

    const timestamp = request.headers.get("x-feedback-timestamp");
    const nonce = request.headers.get("x-feedback-nonce");
    const signature = request.headers.get("x-feedback-signature");
    if (!timestamp || !nonce || !signature) {
      return jsonResponse({ error: "missing signature headers" }, 401);
    }

    const rawBody = await request.text();
    const verified = await verifySignature(env, rawBody, timestamp, nonce, signature);
    if (!verified) {
      return jsonResponse({ error: "invalid signature" }, 401);
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "invalid json" }, 400);
    }

    const payload = validatePayload(parsedBody);
    if (!payload) {
      return jsonResponse({ error: "invalid payload" }, 400);
    }

    try {
      const submissionId = `${Date.now()}-${crypto.randomUUID()}`;
      const imageUrls = await uploadImages(env, payload.images ?? [], submissionId);
      const issueUrl = await createGithubIssue(
        env,
        buildIssueTitle(payload.description),
        buildIssueBody(payload, imageUrls),
      );
      return jsonResponse({ issueUrl }, 200);
    } catch (error) {
      console.error("feedback submission failed", error);
      return jsonResponse({ error: "internal error" }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
