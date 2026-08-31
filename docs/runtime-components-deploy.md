# 运行时组件（CLI 二进制 / python-runtime）发布运维

CLI 二进制与 python-runtime 不随安装包发布，改由客户端首次启动时按需下载。
本文记录发布流程与踩过的坑。代码入口见 `apps/studio/electron/main/services/componentInstaller.ts`。

## 服务器落点

| 项 | 值 |
|---|---|
| 主机 | ningbo-cowork（114.66.17.142） |
| 目录 | `/var/www/downloads/components/` |
| URL | `https://coworkapi.lizhiyun.net/downloads/components/` |
| 清单 | `components.json` |
| 权限 | 目录 755 / 文件 644（**744 会 403**） |

**刻意复用已有的 `location /downloads/`，不新增 nginx location。** 那台机器同域还跑着
付费的 sub2api 网关（`location /`，SSE 靠它的 `proxy_buffering off` + 3600s 超时），
改 nginx 是这台机器上唯一有风险的操作。实测数据支持这个选择：

| 请求 | 实际响应 | 说明 |
|---|---|---|
| `/downloads/components/x`（不存在） | **404** | 被 `location /downloads/` 正确兜住 ✅ |
| `/runtimes/x`（顶层，不存在） | **200 + text/html** | 顶层新增路径配错就被 SPA 兜底吃掉 ⚠️ |

即：**同域漏配的路径不会 404，会被 sub2api 的 SPA 兜底吃成 200 + text/html**。
排查这条链路时**看 `content-type`，别只看状态码**。客户端对此有两道防御：
拉清单时断言不是 `text/html`，下载时同样断言 —— 没有它们会把一个网页 chmod +x
然后得到毫不相关的 `spawn Exec format error`。

## 发布流程

### 常态：本机执行（推荐）

跨境链路实测：**服务器从 GitHub 拉只有 16KB/s**，而**本机上传有 4.8~6.4MB/s**。
所以 CI 只产 artifact，实际上传在国内开发机做。

```bash
# 1. 备齐三平台的源文件
#    CLI（official）：https://downloads.claude.ai/claude-code-releases/<ver>/<platform>/claude
#    CLI（fusion）  ：gh release download <ver> --repo Caffeine-Ops/fusion-code-install
#    python        ：https://github.com/astral-sh/python-build-standalone/releases/download/<tag>/...
#    ⚠️ 这些站点在境外，本机务必绕开代理（env -u HTTP_PROXY ... --noproxy '*'），
#       走代理实测只有 4KB/s，直连 4.5MB/s。

# 2. 逐平台打包（会跑结构走查 + 架构断言 + gzip）
bun scripts/publish-components.ts --platform darwin-arm64 --out out-components \
  --cli <bin> --cli-version 2.1.212 --cli-source official \
  --python <tar.gz> --python-version 3.12.13 --python-unpacked <bytes>
#    ...对 darwin-x64 / win32-x64 各来一次

# 3. 合并 + 自校验（会断言必需组件三平台齐全、平台字段与文件名相符）
bun scripts/publish-components.ts --merge out-components --published-at "$(date +%s)000"

# 4. 上传：先传产物，最后单独传清单
#    —— 保证不会出现「清单已更新但产物还没到」的窗口
rsync -a --partial --append-verify --chmod=D755,F644 \
  --temp-dir=/var/www/downloads/components/.tmp \
  --exclude 'components*.json' out-components/ \
  ningbo-cowork:/var/www/downloads/components/
rsync -a --chmod=F644 out-components/components.json \
  ningbo-cowork:/var/www/downloads/components/
```

`--python-unpacked` 用这个算（**别用 `tar -tzv | awk '{s+=$3}'`**：GNU tar 与 bsdtar
的列位不同，换个平台会静默算出 0，而 0 会让客户端的磁盘预检形同虚设）：

```bash
python3 -c "import tarfile; print(sum(m.size for m in tarfile.open('x.tar.gz')))"
```

### CI：`.github/workflows/publish-components.yml`

`workflow_dispatch` 手动触发，默认 `publish=false` 只产 artifact（14 天保留），
取回后本机上传。哪天实测 runner→服务器够快，把 `publish` 打开即可。

`CLI_SOURCE` 决定发 fusion 版还是官方版：手选 > repo variable > 兜底 official。
**当前 repo variable 是 `official`。**（注意 build.yml 里的代码默认值是 `fusion`，
以 variable 为准。）

## 发布后必须跑的两条验收

```bash
# ① 清单必须是 JSON 而不是被 SPA 兜底的网页
curl -sI https://coworkapi.lizhiyun.net/downloads/components/components.json | head -6
#   期望：200 + Content-Type: application/json

# ② Range 必须真生效，否则断点续传是纸面功能
curl -sI -H 'Range: bytes=0-1023' \
  https://coworkapi.lizhiyun.net/downloads/components/cli-<ver>-darwin-arm64.gz | head -8
#   期望：206 Partial Content + ETag
#   拿到 200 = 被兜底 / 中间层在重编码 → 续传失效，先修这个
```

## 版本升级

改一次版本 = 重跑一遍发布流程，**不需要发 app 版本**。客户端靠 `components.json`
里的 version 发现更新。注意客户端的升级判据：只有**已经是下载来的那一份**
（本地有安装记账）才会升级；随包/dev 来源的一律视为就绪、不下载 —— 这是
「包里还带着二进制的中间态不打扰任何人」的保证。

换分发源更省事：`RUNTIME_COMPONENTS_BASE_URL` 走三层来源
（硬编码兜底 → env.json → **sub2api client-config 远端下发**），最后一层意味着
换 CDN / 迁服务器**改后台一处即可，不用发版**。这也是这条链路唯一近乎零成本的
止血杠杆（限制：登录后才生效，且 sub2api 与它同机——能救「路径配错」，
救不了「VPS 宕机」）。

## 带宽现实（实测）

自建源出口约 **1.1MB/s，且所有用户共享**：

| 并发用户 | 人均 | 下 66MB 的 CLI |
|---|---|---|
| 1 | 1.1 MB/s | ~60 秒 |
| 10 | 110 KB/s | ~10 分钟 |

所以**压缩不是优化而是可行性前提**（CLI 233MB → 66.5MB，压缩率 28.5%）。
用户多起来之后应当考虑给这条 location 加 `limit_rate` + `limit_conn`
（防单用户饿死其他人），或者上 CDN。

## 踩过的坑

1. **平台相关字段必须挂在 artifact 上，不能挂在 entry 上**。`binName` 与
   `readyProbe` 最初放在 entry 层，合并三平台分片时后一个平台的值被前一个覆盖，
   产出的清单里 Windows 用着 mac 的文件名 —— 装完落盘没有 `.exe`（cliDetect 找不到），
   python 判据永远不满足（每次启动重下一遍）。两个症状都离真因极远，而且
   **只在 Windows 出现，mac 上开发永远测不到**。现在 merge 阶段有断言挡住这类错误。
2. **代理**。本机 shell 常驻 `HTTP_PROXY`，对境外源（downloads.claude.ai / GitHub）
   走代理 4KB/s、直连 4.5MB/s；对国内的 coworkapi.lizhiyun.net 走代理 14KB/s、直连 1.1MB/s。
   两个方向都要绕开。这坑在本仓库已经踩过 8 次。
3. **python 有 9 个符号链接**（`bin/python3 → python3.12`）。必须用 tar 保留，
   换成 zip 走 adm-zip 会写成内容是路径字符串的普通文件，解出来是个跑不动的 runtime。
4. **执行位不在 sha256 里**。下载后必须 `chmod 0o755` 并断言 —— 同仓库的
   pptSkillWorker 就因为 adm-zip 丢 mode 位，解出来的 `ensure-python.sh` 是 644
   （它靠 `source` 调用才侥幸没炸，对 Mach-O 这么干就是 `spawn EACCES`）。

## 已验证的事实（2026-07-29 实测）

- 下载来的 CLI 落盘后**直接可执行**（`2.1.212 (Claude Code)`），解压后 sha256
  与官方 manifest 逐字节一致
- 程序化下载**不产生 `com.apple.quarantine`**（只有 `com.apple.provenance`），
  因此**不需要 `xattr -d`，也不需要 ad-hoc 重签**（后者还会破坏 sha256 复验能力）
- 下载来的 python `import ssl, ctypes, sqlite3` 全部成功 —— 这三个是 macOS
  library validation 最典型的 dlopen 失败点
- 断点续传精确：造一个 20MB 的半截 `.part` 后重跑，服务器日志显示只请求了
  5179883 字节（= 剩余 4131307 + 1MB 防撕裂回退），拼接后 sha256 校验通过
