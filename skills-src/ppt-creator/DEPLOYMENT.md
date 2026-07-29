# ppt-creator 线上部署方案

> 面向维护者。讲清这个 skill **为什么**不随安装包发布、部署在哪、怎么首次上线、
> 以及排查时该看什么。日常发新版看 [UPGRADE.md](./UPGRADE.md)。

## 为什么按需下载而不是打进安装包

| 指标 | 数值 |
|---|---|
| 未压缩体积 | 99 MB |
| 文件数 | 12167（其中 `templates/icons/` 一家占 11633） |
| 压缩后 | 49 MB |

它是安装包里最大的一块，而**只有做 PPT 的用户才需要它**。改为首次使用时下载后，
安装包瘦身约 99MB。

一并排除的还有两条看似可行、实测不行的路：

- **走技能市场的逐文件下载**：市场下载器并发 3、每文件一次 HTTP，12167 个文件
  就是 4000 多轮 RTT，装一次十几分钟。所以这里用整包 zip，一次请求。
- **托管在 Gitee 仓库**：[官方文档](https://help.gitee.com/repository/file-operate/raw)
  写明公开仓库 raw 文件**超过 10MB 就要求认证**，49MB 的包客户端匿名下载必然 403。
  （Release 附件可以放，客户端也支持异地 URL，见下文「换托管方式」。）

## 部署位置

```
服务器   ningbo-cowork  114.66.17.142
目录     /var/www/downloads/skills/
URL      https://cowork.cntcn.com/downloads/skills/
文件     ppt-creator.json          ← 清单，客户端先读它
         ppt-creator-<版本>.zip    ← 包体
```

### 刻意没有新增 nginx location

`cowork.cntcn.com` 同域挂着四样东西，其中 **`location /` 是付费的 sub2api 网关**
（SSE 长连接依赖它的 `proxy_buffering off` + 3600s 超时，别碰）。

本方案复用**已存在的** `location /downloads/`（`alias /var/www/downloads/`），
把文件放进它的 `skills/` 子目录——`alias` 天然支持子目录，于是：

- 不需要改 nginx 配置
- 不需要 `nginx -t` / reload
- 对现有业务零风险

改动 nginx 是这条链路上唯一有风险的操作，能不做就不做。

## 首次部署步骤

```bash
# 1. 打包（在仓库根跑）
bun scripts/publish-ppt-skill.ts --out /tmp/ppt-dist --version 1.0.0

# 2. 建目录并上传
ssh ningbo-cowork 'mkdir -p /var/www/downloads/skills'
scp /tmp/ppt-dist/ppt-creator-1.0.0.zip /tmp/ppt-dist/ppt-creator.json \
    ningbo-cowork:/var/www/downloads/skills/

# 3. 修权限（务必，见下方「踩过的坑」）
ssh ningbo-cowork 'chmod 755 /var/www/downloads/skills && chmod 644 /var/www/downloads/skills/*'
```

## 验证：看 content-type，不要只看状态码

```bash
curl -sS -o /dev/null -w "%{http_code} %{content_type}\n" \
  https://cowork.cntcn.com/downloads/skills/ppt-creator.json
# 期望：200 application/json
```

**为什么强调这条**：这个域名下 `location /` 是 sub2api 的 SPA 兜底。路径配错时
**不会返回 404**，而是回 `200` + `text/html`（一份 index.html）。只看状态码会以为
一切正常，实际客户端拿到的是 HTML，`JSON.parse` 失败后报「清单格式不正确」，
排查方向立刻跑偏。

完整校验（确认包没在传输中损坏）：

```bash
curl -sS -o /tmp/p.zip https://cowork.cntcn.com/downloads/skills/ppt-creator-1.0.0.zip
shasum -a 256 /tmp/p.zip   # 应与清单里的 sha256 一致
```

## 客户端配置

`PPT_SKILL_BASE_URL` 三层来源，**后者覆盖前者**：

| 层 | 位置 | 用途 |
|---|---|---|
| 1 | `pptSkillInstaller.ts` 的 `DEFAULT_BASE_URL` | 兜底，防 env 漏配导致功能整个不可用 |
| 2 | `apps/studio/env.json` | 随安装包分发的正式配置 |
| 3 | sub2api 后台「客户端环境变量附加项」 | **换 CDN / 迁服务器不用发版** |

第 3 层是这个变量走 env 而非硬编码的主要价值：运维改一处，所有客户端下次登录即生效。

## 客户端侧发生了什么

```
① 下载 49MB zip          utilityProcess 子进程，边下边算 sha256
② 校验 sha256            不匹配绝不落盘（包里全是会被执行的 Python 脚本）
③ 解压 12167 个文件      同一子进程；放 main 会冻住整个 UI 几十秒
④ 原子换名上位          旧版先挪走，失败可回滚
⑤ 写 .claude-plugin/     name=cowork → 命令即 /cowork:ppt-creator
⑥ 回收 runtime           否则已 spawn 的 CLI 子进程看不到新插件
⑦ 预热 Python venv       建 venv + pip 装 18 个依赖，首次几分钟
```

安装落点：`~/.cowork/plugins/ppt-creator/`，布局要求见
`electron/main/core/skillsDir.ts` 的 `resolveCoworkPluginEntries`。

## 踩过的坑

**目录权限 744 会 403。** 新建目录的默认权限可能是 744，nginx worker（`www-data`）
属于 other，没有 `x` 位就进不去目录。必须 755，文件 644。

**plugin 列表在子进程 spawn 时就烤死了。** app 启动的后台预热会在下载完成前把
fusion-code runtime 起起来，那一刻磁盘上还没有这个 skill。所以装完必须调
`recycleAllEnginesRuntimes()`，否则用户等完进度条发第一条消息，CLI 回的是
`Unknown command: /cowork:ppt-creator`，重开 app 才好。

**源码住在 `skills-src/` 而不是 `skills/`。** `skills/` 是打进安装包的内置插件根
（`.claude-plugin/plugin.json` 把每个子目录暴露成 `claude-desktop:<name>`）。这个
skill 若留在那儿，dev 环境会凭空多出一个 `/claude-desktop:ppt-creator`，与下载装的
`/cowork:ppt-creator` 并存，于是**永远测不出真实用户「尚未安装」时的样子**。
换个目录，就让「不打包」从一条容易失效的过滤规则变成目录位置本身的属性。

## 换托管方式

清单支持可选的 `url` 字段（绝对地址）。清单与包**不在同一处**时用它：

```json
{ "file": "ppt-creator-1.0.0.zip",
  "url": "https://gitee.com/<user>/<repo>/attach_files/<ID>/download/ppt-creator-1.0.0.zip" }
```

典型场景是 Gitee：清单几百字节可以走 raw，49MB 的包只能挂 Release 附件
（单附件上限 100MB），而附件地址里带一个上传后才分配的 ID，没法由 base 拼出来。
打包时加 `--url <地址>` 即可写入。缺省则回落 `<base>/<file>` 的同目录拼接。
