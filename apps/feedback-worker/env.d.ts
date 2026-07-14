/**
 * `wrangler types` 只能从 wrangler.jsonc 的 vars/bindings 生成 Env（见
 * worker-configuration.d.ts），生成不出 `wrangler secret put` 设置的密钥——
 * 那些密钥不落在任何配置文件里。这里手动做 interface 声明合并补上两个字段，
 * 值本身在本地开发时来自 .dev.vars（见 README.md），生产环境来自
 * `wrangler secret put`。
 */
interface Env {
  /** classic PAT，需要 `repo` scope（创建 Issue）。 */
  GITHUB_TOKEN: string;
  /** 客户端与 Worker 共享的 HMAC 密钥，见 src/index.ts 的 verifySignature。 */
  HMAC_SECRET: string;
}
