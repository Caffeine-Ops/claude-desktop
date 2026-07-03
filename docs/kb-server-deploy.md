# 知识库构建服务器部署手册

面向运维人员，讲的是「团队共享知识库」的**服务器侧**：一台内网机器定时把 SMB 共享盘里的源文件（docx/pptx/xlsx/xls/pdf/txt）构建成客户端可直接拉取的制品（Markdown 镜像 + `manifest.json`），客户端（写方案功能）通过 HTTP 增量同步这份制品到本机 `userData/kb-index/`。

本手册所有命令假设 **Ubuntu 22.04**，涉及包名/服务名差异的地方标注 **CentOS**（以 CentOS/RHEL 8+，`dnf` 为例）对应写法。命令块可直接复制粘贴执行。

架构一句话：`/srv/kb/source/`（源，SMB 共享）→ `build-kb-index.ts` → `/srv/kb/publish/default/`（制品，`index.json` + `manifest.json` + Markdown 镜像树）→ nginx 静态托管 → 客户端 `GET /kb/default/manifest.json` 增量同步。

---

## 1. 依赖安装

### 1.1 bun（跑 `scripts/*.ts` 需要）

```bash
curl -fsSL https://bun.sh/install | bash
# 安装脚本会把 bun 放进 ~/.bun/bin，加进当前 shell 的 PATH：
source ~/.bashrc   # 或重新登录一次 shell
bun --version
```

> cron 环境的 `PATH` 是精简过的默认值，**不包含** `~/.bun/bin`。第 4 节的 cron 配置里需要显式加一行 `PATH=`，否则任务会报 `bun: command not found` 而且不会有任何提示（cron 默认把 stdout/stderr 都发邮件或直接丢弃，取决于系统配置）。

### 1.2 markitdown（文档转 Markdown 的主力）

```bash
# Ubuntu 22.04：pipx 在官方仓库里
sudo apt update
sudo apt install -y pipx
pipx ensurepath
source ~/.bashrc

pipx install markitdown
```

**CentOS/RHEL（差异点）**：8 系默认仓库通常没有 pipx，需要先启用 EPEL（`sudo dnf install -y epel-release && sudo dnf install -y pipx`），或退而求其次用 `python3 -m pip install --user pipx`；装好后同样 `pipx ensurepath` + `pipx install markitdown`。

**必须额外注入 `xlrd`，否则 `.xls` 全军覆没**——这是本机真实踩过的坑，不是预防性提醒：

```bash
pipx inject markitdown xlrd
```

不注入的后果是每个 `.xls` 文件转换时抛出：

```
XlsConverter recognized the input as a potential .xls file, but the dependencies needed to read .xls files have not been installed
```

`build-kb-index.ts` 会把这个异常吞进三档降级链（见「已知问题」一节），最终这批 `.xls` 大概率掉进 `soffice` 纯文本兜底或直接标记 `ok:false`——不会让整次构建失败，但知识库里这些文件的内容质量会明显变差甚至整篇丢失，且不会有醒目报错提示你去修，务必在部署时就把 `xlrd` 装上。

### 1.3 LibreOffice（markitdown 两档都失败时的最后兜底，转成纯文本）

**Ubuntu 22.04：**

```bash
sudo apt install -y libreoffice --no-install-recommends
```

**CentOS/RHEL（差异点）：**

```bash
sudo dnf install -y libreoffice
# 部分精简源需要先启用 PowerTools/CRB 仓库才能装全 libreoffice 元包；
# 若只想要最小依赖，可只装 libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-headless
```

安装完确认命令行工具名是 `soffice`（脚本按此名调用，不是 `libreoffice`）：

```bash
soffice --version
```

---

## 2. 目录约定

三个目录各司其职，权限边界要分清：

| 目录 | 用途 | 谁写 |
|---|---|---|
| `/srv/kb/source/` | 源文件，团队通过 SMB 共享盘直接增删改 | 团队成员（SMB 用户组） |
| `/srv/kb/publish/default/` | 构建制品：`index.json`（构建索引）、`manifest.json`（发布给客户端的清单）、Markdown 镜像树、`assets/` 内嵌图 | 只有 cron 任务（build/publish 脚本）写，团队不直接碰 |
| `/srv/kb/app/` | 本仓库的代码检出（含 `scripts/`），cron 任务从这里跑脚本 | 只有部署/升级时 `git pull`，运行时只读 |

初始化：

```bash
sudo mkdir -p /srv/kb/source /srv/kb/publish/default
sudo git clone <本仓库地址> /srv/kb/app
sudo chown -R <部署账号> /srv/kb/app   # sudo clone 出来属主是 root，交还给部署账号，否则 bun install 写不进去
cd /srv/kb/app && bun install
```

`/srv/kb/publish/default/` 首次构建前留空即可——`build-kb-index.ts` 会在 `--out` 目录不存在 `index.json` 时按全量构建处理，`publish-kb-manifest.ts` 则要求 `index.json` 已存在（否则抛错，见第 4 节），这天然保证了「先 build 后 publish」的顺序不会被跑反。

---

## 3. SMB 共享 source

**Ubuntu 22.04：**

```bash
sudo apt install -y samba
```

**CentOS/RHEL（差异点，包名/服务名都不同）：**

```bash
sudo dnf install -y samba samba-client
```

创建团队用户组，`/srv/kb/source/` 归组读写：

```bash
sudo groupadd kb-team
sudo usermod -aG kb-team <团队成员账号>   # 每个团队成员执行一次
sudo chgrp -R kb-team /srv/kb/source
sudo chmod -R 2775 /srv/kb/source          # setgid：新建文件自动继承 kb-team 组
```

`/etc/samba/smb.conf` 追加共享片段：

```ini
[kb-source]
   path = /srv/kb/source
   valid users = @kb-team
   read only = no
   create mask = 0664
   directory mask = 2775
   force group = kb-team
```

为每个团队成员设置 samba 密码（Linux 账号本身不需要能登录 shell）：

```bash
sudo smbpasswd -a <团队成员账号>
```

重启服务并放行防火墙：

```bash
# Ubuntu：服务名 smbd/nmbd
sudo systemctl restart smbd nmbd
sudo ufw allow samba

# CentOS（差异点）：服务名 smb/nmb
sudo systemctl restart smb nmb
sudo firewall-cmd --permanent --add-service=samba
sudo firewall-cmd --reload
```

---

## 4. cron（每小时构建 + 发布）

用 `flock -n` 防止上一轮还没跑完时重叠触发；用 `&&` 串联 build 和 publish——**`publish-kb-manifest.ts` 要求 `<dir>/index.json` 已存在，构建失败/中止时 `&&` 自然短路，不会拿旧 `index.json` 发一份内容对不上的新 manifest**。cron 里的 `%` 是特殊字符（表示换行/命令分隔），拼时间戳必须转义成 `\%`。

编辑 crontab（推荐用专门的服务账号，而不是 root；示例用 `crontab -e` 假设当前登录用户即部署账号）：

```bash
crontab -e
```

加入以下两行（第一行把 bun 的安装路径补进 cron 的 PATH，避免 1.1 节提到的 `bun: command not found`）。注意 crontab 里的 `PATH=` 赋值是纯字面量，**不支持 `$HOME` / `~` 展开**，必须按实际部署账号手写绝对路径——把 `<部署账号>` 换成真实用户名：

```cron
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/<部署账号>/.bun/bin
0 * * * * flock -n /tmp/kb-build.lock bash -c 'cd /srv/kb/app && bun scripts/build-kb-index.ts --kb /srv/kb/source --out /srv/kb/publish/default --now $(date +\%s)000 && bun scripts/publish-kb-manifest.ts --dir /srv/kb/publish/default --kb-id default --name "福鑫数科产品线资料库" --now $(date +\%s)000' >> /var/log/kb-build.log 2>&1
```

参数核对（与脚本实际 CLI 一一对应，不是拍脑袋写的）：

- `build-kb-index.ts`：`--kb <源目录>` `--out <制品目录>` `--now <毫秒时间戳>`（`--now` 必填，脚本不会自己调 `Date.now()`，缺了直接抛 `缺少参数 --now`）；
- `publish-kb-manifest.ts`：`--dir <制品目录>` `--kb-id <id>` `--name <知识库展示名>` `--now <毫秒时间戳>`（同样必填；且要求 `<dir>/index.json` 已存在，否则抛 `${dir} 下没有 index.json——先跑 build-kb-index 再发布 manifest`）。

日志目录/文件需要 cron 执行用户有写权限：

```bash
sudo touch /var/log/kb-build.log
sudo chown <部署账号> /var/log/kb-build.log
```

（若不想用 `/var/log`，也可以把重定向目标改成 `/srv/kb/app/kb-build.log` 之类的自有目录，避免额外的权限申请。）

---

## 5. nginx

只做静态文件托管，把 URL 前缀 `/kb/` 映射到发布根目录 `/srv/kb/publish/`：

```nginx
server {
    listen 80;
    server_name kb.internal.example.com;   # 或直接用内网 IP

    location /kb/ {
        alias /srv/kb/publish/;
        charset utf-8;
        autoindex off;
    }
}
```

客户端拼 URL 的规则（`apps/desktop/src/shared/kbManifest.ts`）是：

- `<baseUrl>/kb/<kbId>/manifest.json`
- `<baseUrl>/kb/<kbId>/<相对路径>`，相对路径**逐段** `encodeURIComponent`（按 `/` 切开各自编码再拼回去，而不是整串编码——整串编码会把路径分隔符 `/` 也吃掉）。

因为路径里全是中文文件名，这一步的 percent-encoding 由客户端负责，服务端不需要做任何特殊配置——nginx 收到的请求路径本来就是标准的 URL-encoded 形式，会自动解码去匹配文件系统上的真实文件名，Ubuntu/CentOS 默认的 ext4/xfs 文件系统本身就是 UTF-8 字节透传，不需要额外挂载参数。`charset utf-8;` 是为了让 nginx 返回 `manifest.json` / Markdown 镜像时响应头带上正确字符集，避免个别客户端按 latin1 猜测编码。

**为什么现在不需要 TLS / 鉴权**：本期部署假设是纯内网访问，明文 HTTP 起步足够（内网边界本身是信任边界）。留的口子在客户端：kbSync 的所有 HTTP 请求都走同一个 fetch 封装（`apps/desktop/src/main/core/kbSync.ts`），未来要公网化或加团队 token 鉴权时，只需要改这一处发起请求的地方（加 `Authorization` 头 / 换成 `https://`），服务器侧对应加 nginx 的 TLS 终端和一个鉴权校验层即可，不影响目录结构和 URL 布局。

---

## 6. 验收

先验证 manifest 能正常拉到、内容合理：

```bash
curl -s http://<服务器>/kb/default/manifest.json | python3 -m json.tool | head
```

预期能看到 `schemaVersion`、`kbId: "default"`、`name`、`builtAtMs`、`files` 数组（每个元素含 `path`/`sha1`/`size`）。如果 `curl` 拿到 404，先检查 nginx `alias` 路径和 `/srv/kb/publish/default/manifest.json` 是否真的存在（可能是 cron 还没跑过第一轮，或者 build 失败导致 `&&` 短路没发布）。

再走一遍客户端真实同步：打开写方案功能的设置页 → 知识库分区 → 选「远程服务器」→ 填 `baseUrl`（`http://<服务器>`，不含 `/kb/` 后缀）→ 触发一次「立即同步」，观察同步进度条走完、显示「上次同步时间」且没有报错。首次全量同步文件较多（构建产物约 1.8GB 级别），耐心等待即可，中途断网/退出应用不影响下次续传（`.part` 残留由下次同步开头清扫）。

**排查：代理环境。** 上面这条验收命令（`curl`）和 `bun test`/`scripts/*.ts` 里直调的 `fetch` 走的是系统级网络栈，会尊重 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` 环境变量——内网服务器地址记得配进 `NO_PROXY`，否则请求会被错误地打到代理上而连不通。但**打包后的桌面应用不是这样**：客户端真正跑同步用的是 Electron main 进程里的 undici `fetch`（`kbSync.ts` 的 `fetchImpl` 缺省值），它**不读取任何代理环境变量**，永远尝试直连 `baseUrl`。这意味着如果某台机器的网络策略是「只能经代理访问内网/外网」，桌面应用当前**不支持**这种环境（即便命令行 `curl`/`bun test` 验证是通的，桌面客户端仍会连不上）。这是已知限制，P1 可以在 `kbSync.ts` 唯一的 fetch 封装点（`fetchWithTimeout`）接入显式代理配置，本期不做。

---

## 7. 多知识库预留（本期只用一个 `default`，但协议已经支持多个）

URL 布局天生带 `kbId`（`/kb/<kbId>/...`），manifest 里也自带 `kbId`/`name` 字段，所以给团队新增一个独立知识库不需要改协议，只需要在服务器侧复制一份构建流水线：

1. 新建一份源目录，例如 `/srv/kb/source-teamB/`（对应新建一个 SMB 共享，或复用 `kb-team` 组换个子目录）；
2. 新建对应的发布目录 `/srv/kb/publish/teamB/`；
3. 复制第 4 节的 cron 行，把 `--kb`/`--out` 换成新目录，`--kb-id` 换成 `teamB`，`--name` 换成新知识库的展示名；
4. nginx 配置不用改——`alias /srv/kb/publish/;` 已经覆盖了 `/srv/kb/publish/` 下的所有子目录，`/kb/teamB/manifest.json` 自动可访问。

客户端侧目前的设置 UI 只支持配置单个 `remote.kbId`，多知识库之间的切换器/并存策略是 P1 范围，本手册不涉及——服务器侧该做的准备已经就绪，等客户端功能跟上即可直接接。

---

## 已知问题（无需运维介入，仅供看日志时对照）

带图片美化过的 pptx，`markitdown --keep-data-uris` 有概率抛 `ValueError: no embedded image`（图片引用没有内嵌 blob）。`convertFile`（`scripts/kb-index/convert.ts`）内置了二档降级：自动改用不带 `--keep-data-uris` 的纯文本模式重试，正文内容一字不丢，只是这个文件的内嵌图丢失。这是设计内的自动降级，不是故障，日志里会看到一行：

```
[kb-index] <文件相对路径>: markitdown --keep-data-uris 失败，降级为纯文本重试（内嵌图全部丢失）：<原始错误>
```

在 `/var/log/kb-build.log` 里 `grep '\[kb-index\]'` 能看到所有发生过降级的文件，正常运维不需要处理；如果想恢复某个文件的内嵌图，只能手动整理该 pptx（把图片正确内嵌而非仅引用）后重新触发一次构建。
