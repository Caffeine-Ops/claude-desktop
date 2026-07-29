# ppt-creator 升级方案

> 面向维护者。发新版的完整流程、客户端如何发现更新、以及升级路径上那些**只在
> 升级时才会暴露**的坑。首次部署与架构背景见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 发新版：三步

```bash
# 1. 打包（版本号必填，仓库根跑）
bun scripts/publish-ppt-skill.ts --out /tmp/ppt-dist --version 1.1.0

# 2. 上传（清单和包放同一目录）
scp /tmp/ppt-dist/ppt-creator-1.1.0.zip /tmp/ppt-dist/ppt-creator.json \
    ningbo-cowork:/var/www/downloads/skills/

# 3. 修权限（scp 新文件不继承目录权限）
ssh ningbo-cowork 'chmod 644 /var/www/downloads/skills/*'
```

客户端在下次 `ensurePptSkill()` 时（登录 / 冷启动 / 点 PPT 入口）读到新清单，
发现 `version` 与本地记账不同，自动下载更新。**用户无需任何操作**。

旧版 zip 可以留在目录里不删——清单指向哪个就用哪个，留着还能手工回滚。

## 版本号规则

`version` 是**纯字符串比对，不做语义化解析**：客户端只判断「与本地记账相同吗」，
不同就更新。所以：

- 版本号不必单调递增，改回旧值同样会触发一次「更新」（这正是回滚的原理）
- 但**不能重复使用同一个版本号发不同内容**——已装用户会因为版本相同而跳过，
  永远停在旧包上

## 客户端的更新判定

```
读远端清单 ─┬─ 拉不到（离线/服务器挂）
            │   ├─ 本地已装 → 直接放行，不挡功能
            │   └─ 本地没装 → 报错，进度层给重试
            └─ 拉到了
                ├─ version == 本地记账 → 跳过下载，仍过一遍 venv 预热（秒过）
                └─ version != 本地记账 → 下载 → 校验 → 原子换名 → 回收 runtime → 预热
```

本地记账在 `~/.cowork/plugins/ppt-creator/.ppt-skill.json`。记账在但 `SKILL.md`
不在（用户手删过），视为未安装重新下载。

## 升级路径上的三个坑

### 1. 改了 requirements.txt，老用户的依赖不会自动更新（已自动处理）

`bin/ensure-python.sh` 的短路条件是「venv 在 **且** `.deps-ok` 哨兵在」，命中就
直接返回。于是新版加了包，老用户升级后哨兵还在 → **pip 压根不会跑** → skill 运行时
`ModuleNotFoundError`，而错误现场在 Python 里，离「你升级了但依赖没跟上」这个
真因十万八千里。

**已在安装器里处理**：每次装完新版本会删掉 `.deps-ok`，强制重跑 pip。代价很小——
pip 对已装好的包是 `Requirement already satisfied` 秒过，只有真正新增/变更的包
才下载。

改 `requirements.txt` 时无需额外操作，但**要预期用户升级时会多等一会儿**。

### 2. 已 spawn 的 CLI 子进程看不到新装的插件（已自动处理）

plugin 列表在 fusion-code 子进程 spawn 那一刻就烤死了。升级发生在用户已经用了
一阵之后，runtime 早就热着——不回收的话新版代码根本没被加载。

**已在安装器里处理**：装完调 `recycleAllEnginesRuntimes()`，它会跳过 in-flight
的回合、保留 sessions 与磁盘 transcript、置 `pendingResume`，下次 send 带
`--resume` 冷启动，历史一条不丢。

### 3. 打包必须可重现，否则无法自证

`adm-zip` 默认把「当前时间」写进每个 zip 条目头，同样的源码每打一次就换一个
sha256。那样你**没法通过重新打包来验证服务器上那个包确实来自这份源码**。

打包脚本已把所有条目时间戳钉死在 1980-01-01（zip 纪元起点）。验证方式：

```bash
bun scripts/publish-ppt-skill.ts --out /tmp/a --version 1.0.0
bun scripts/publish-ppt-skill.ts --out /tmp/b --version 1.0.0
diff <(shasum -a 256 /tmp/a/*.zip | cut -c1-64) <(shasum -a 256 /tmp/b/*.zip | cut -c1-64)
# 无输出 = 可重现
```

## 回滚

清单指哪打哪，所以回滚就是**把清单改回旧版本**：

```bash
# 服务器上直接改清单的 version 与 file 指回旧包（旧 zip 没删的话）
ssh ningbo-cowork 'cd /var/www/downloads/skills && ls'   # 确认旧 zip 还在
# 用旧版本重新生成清单再上传，或手工改这两个字段
```

⚠️ **手工改清单时 `sha256` 必须与所指 zip 匹配**，否则客户端校验失败、拒绝落盘
（这是刻意的：包里全是会被执行的 Python 脚本，宁可装不上也不能装一个对不上的）。
稳妥做法是用旧源码重跑一次打包脚本——因为打包可重现，产出的 sha256 与当初完全一致。

回滚后客户端因为 `version` 与本地不同，会自动降级下载。

## 本地验证（改动后从零跑一遍）

```bash
# 清空安装态
rm -rf ~/.cowork/plugins/ppt-creator ~/.ppt-master/venv

# 完整重启 dev（main 进程内存里的状态是 ready，不重启 gate 会误放行）
bun run dev
```

预期依次看到：下载（含 MB 进度）→ 安装（`X / 12167 个文件`）→ 准备运行环境
（逐行显示「正在获取 numpy…」等，可展开原始日志）→ 自动关闭。

**关键验证点**：进度层关闭后**不重开 app** 直接发消息，不应出现
`Unknown command: /cowork:ppt-creator`。

只想测下载与解压、不想等 venv 重建的话，保留 `~/.ppt-master/venv` 只删前者即可
（哨兵还在，预热会秒过）。

## 开发时免打包

改 skill 源码想立刻生效，挂个软链即可（一次性）：

```bash
rm -rf ~/.cowork/plugins/ppt-creator/skills/ppt-creator
ln -s <repo>/skills-src/ppt-creator ~/.cowork/plugins/ppt-creator/skills/ppt-creator
```

⚠️ 挂了软链之后**就不再是真实用户的路径了**，验证发布流程前记得删掉软链、走一遍
真实下载。
