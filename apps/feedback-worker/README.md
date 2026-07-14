# claude-desktop-feedback-worker

问题反馈提交的代理服务。客户端（Electron 主进程）签名后把 `{ description, images[] }`
POST 到这里；本 Worker 校验签名、按 IP 限流，把截图传 R2 拿公开 URL，再调用
GitHub REST API 在 `Caffeine-Ops/claude-desktop-feedback`（需另建）创建 Issue，
把截图链接内嵌进 Issue 正文。

客户端全程不持有 GitHub Token——Token 只存在于这个 Worker 的 secret 里。

## 威胁模型（部署前必读）

HMAC 请求签名不是强认证：密钥打包进桌面客户端本质上可以被逆向提取，只挡得住
随手直接 curl 这个 Worker 的脚本，挡不住有心逆向的人。真正的防滥用防线是
`ratelimits` binding（按 `CF-Connecting-IP` 每分钟 5 次）。这个反馈入口本来
就不是高价值攻击面，这个级别的防护是刻意的取舍，不是疏漏。

## 部署前置步骤

### 1. 建反馈仓库

在 GitHub 建 `Caffeine-Ops/claude-desktop-feedback`（公开或私有均可，只要
下面的 GitHub Token 对它有写权限）。

### 2. 建 R2 桶 + 开公开访问

```bash
bunx wrangler r2 bucket create claude-desktop-feedback-assets
```

去 Cloudflare Dashboard → R2 → 这个桶 → Settings → Public access，启用
`r2.dev` 子域名（默认关闭，必须手动开）。把拿到的 `https://pub-xxxx.r2.dev`
填进 `wrangler.jsonc` 的 `vars.R2_PUBLIC_BASE_URL`（替换掉占位符），然后
重跑一次 `bun run types` 让生成类型里的字面量同步。

### 3. 建 GitHub Token

Classic PAT（**不是** fine-grained ——fine-grained 不支持部分场景，这里虽然
只用 Issues API 不用 Gist 了，但 classic 更简单可靠），scope 勾 `repo`
（若仓库公开可只勾 `public_repo`）。只给这一个反馈仓库的权限范围能勾就勾。

### 4. 设置 secrets

```bash
cd apps/feedback-worker
bunx wrangler secret put GITHUB_TOKEN
bunx wrangler secret put HMAC_SECRET   # 随便生成一串高熵随机串，例如 `openssl rand -hex 32`
```

`HMAC_SECRET` 必须和客户端侧 `env.json` 里的 `FEEDBACK_HMAC_SECRET` 完全一致
——两边算的是同一个 HMAC。

### 5. 本地开发用的 `.dev.vars`

`wrangler dev` 不会读生产 secret，要在 `apps/feedback-worker/.dev.vars`
（已 gitignore，不会被提交）里放：

```
GITHUB_TOKEN=ghp_xxxx
HMAC_SECRET=同一串随机串
```

## 部署

```bash
cd apps/feedback-worker
bun run deploy
```

部署后把 Worker 的 URL（`https://claude-desktop-feedback.<your-subdomain>.workers.dev`
或自定义域名）填进桌面客户端仓库根目录的 `env.json`：

```json
{
  "env": {
    "FEEDBACK_WORKER_URL": "https://claude-desktop-feedback.xxx.workers.dev",
    "FEEDBACK_HMAC_SECRET": "同一串随机串"
  }
}
```

`env.json` 不在 workspaces 里、不会打进安装包源码，是发版前手工/CI 环境变量
注入的配置文件（见 `apps/studio/electron/main/bootstrap/loadEnv.ts`）。
没配置这两项时，设置页「关于」区不会渲染反馈按钮（`window.chatApi.submitFeedback`
在 main 侧直接返回 error，UI 判空隐藏入口）。

## 已踩过的坑：残留代理环境变量卡死 wrangler

`bun run typecheck`（内部先跑 `wrangler types` 再 `tsc`）如果 shell 里有
常驻 `HTTP_PROXY`/`HTTPS_PROXY` 且代理不通或被墙，`wrangler` 命令会打印出
看起来成功的输出后挂起不退出（怀疑是遥测上报的 fire-and-forget 请求卡住,
使得 Node 进程迟迟不结束）。这不是本项目独有，历次踩坑记录都指向同一个
根因（见 Obsidian errors/ 目录下多条 `HTTP_PROXY` 相关记录）。

排查signal：`ps aux | grep wrangler` 发现调用早就该退出的 `wrangler ... types`
进程仍然存活。修复：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY NO_PROXY='*' bun run typecheck
```

或者直接在 shell 里 `unset HTTP_PROXY HTTPS_PROXY` 后再跑。
