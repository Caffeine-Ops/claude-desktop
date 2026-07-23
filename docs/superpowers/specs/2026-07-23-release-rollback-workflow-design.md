# 发布回滚：GitHub Actions 一键回滚坏版本 — 设计

日期：2026-07-23

## 问题

自动更新（`electron/main/services/appUpdater.ts`）目前只有「往前走」的能力：发现新版本
就静默下载、提示重启安装。一旦某个已发布版本带 bug，开发者没有任何手段让「还没升级
的用户」停止收到这个坏版本——只能干等下一个修复版发出去，期间坏版本持续扩散。

这不是给终端用户用的「撤销更新」按钮，而是开发者自己的应急手段：新版本出了问题，
能立刻让更新检查「假装最新版还是上一个好版本」，把坏版本从更新分发链路里摘掉。

## 现状盘点（决定了方案不需要多复杂）

更新有两个源，`appUpdater.ts` 按顺序 fallback：
- **自建源**（VPS，generic provider）：主源，`checkAllFeeds()` 先查它。
- **GitHub Release**（`Caffeine-Ops/claude-desktop-releases`）：自建源连不上时的兜底。

CI（`.github/workflows/build.yml` 的 `publish` job）每次发布：
1. 用 `softprops/action-gh-release` 把安装包 + 合并后的 `latest-mac.yml`/`latest.yml`
   传到 GitHub Release（`draft: false, prerelease: false`，每个 tag 独立一条记录，
   **从不自动删除历史版本**）。
2. `rsync` 同一批文件到 VPS，**不带 `--delete`**（`build.yml:732` 注释已经写明「VPS
   上累积保留历史版本安装包（可回滚」）——安装包本身天然留着历史版本。

真正「只保留最新」的只有清单文件本身在 VPS 上的当前状态：`latest-mac.yml`/
`latest.yml` 是 electron-updater 判断「当前最新版本是什么」的唯一依据，每次发布
被直接覆盖，VPS 上没有历史清单的存档。

**关键发现**：不需要为此改动发布流程去额外归档清单文件——GitHub Release 的每条历史
记录本身就完整保留了当时的 `latest-mac.yml`/`latest.yml`（连同当时的安装包），是
现成的「历史清单」来源。回滚只需要把目标旧版本 Release 里的清单文件取出来，覆盖回
VPS 当前目录即可。

GitHub 那条兜底线的「最新版本」判定逻辑不一样：electron-updater 的 GitHub provider
是「仓库里所有非 prerelease 版本中版本号最高的」，不看清单文件。要让 GitHub 线也回滚，
需要把坏版本的 Release 标记为 `prerelease`。

## 范围（本次明确排除的部分）

- **不强制拉回已经装上坏版本的用户**——只挡住「还没检查到这次更新」的用户继续装到
  坏版本。已装上坏版本的用户不受影响，需要等下一个修复版走正常更新流程送达。这意味着
  不需要碰 `autoUpdater.allowDowngrade`（默认 `false`），`appUpdater.ts` 本身不用改。
- 不做自动判定「哪个是坏版本」——两个版本号（回滚到哪个、下架哪个）都由开发者手动
  在触发时填写，避免自动推断在时序上出错（比如回滚当天又有新版本发布，「最新的就是
  坏的」这类假设会踩坑）。

## 方案：新增 `.github/workflows/rollback.yml`

`workflow_dispatch` 手动触发（网页 Actions 页面点按钮 + 填参数），复用 `build.yml`
已有的 secrets（`SELFHOST_SSH_HOST/USER/KEY/PORT`、`SELFHOST_DEPLOY_PATH`、
`RELEASE_REPO_TOKEN`），不新增任何密钥。

### 输入参数

- `target_version`（必填）：要回滚到的版本号，例如 `v0.0.37`。
- `bad_version`（必填）：要下架的坏版本号，例如 `v0.0.38`。

### 执行步骤

1. **前置校验**（任一不满足直接 `exit 1`，不做任何写操作）：
   - `target_version` 对应的 GitHub Release 存在，且包含预期资产
     （`latest-mac.yml`、`latest.yml` 都能下载到——用这个代替逐个校验 3 个安装包，
     因为清单文件缺失本身就说明这次发布不完整）。
   - `bad_version` 对应的 Release 存在。
   - `target_version` 本身当前不是 `prerelease`（如果是，回滚后 GitHub 线仍然找不到
     「最新非预发布版」，需要提前报错提醒开发者，而不是静默留下一个更混乱的状态）。

2. **下载 `target_version` 的历史清单**：
   `gh release download target_version --repo Caffeine-Ops/claude-desktop-releases
   --pattern "latest*.yml" --dir rollback-staging`。

3. **覆盖 VPS 当前清单**：
   `rsync` `rollback-staging/latest-mac.yml` `rollback-staging/latest.yml` 到
   `${SELFHOST_SSH_USER}@${SELFHOST_SSH_HOST}:${SELFHOST_DEPLOY_PATH}/`，SSH 参数与
   `build.yml` 的「Sync to self-hosted update server」step 一致。**只覆盖这两个
   文件**，不动安装包（安装包本来就还在 VPS 上，因为发布时 rsync 没加 `--delete`）。

4. **下架 GitHub 上的坏版本**：
   `gh release edit bad_version --repo Caffeine-Ops/claude-desktop-releases
   --prerelease`。

5. **验证生效**：
   `curl` VPS 上 `latest-mac.yml`（走 `SELF_HOSTED_FEED_URL` 同一个公网地址），解析
   其中 `version` 字段，断言等于 `target_version` 去掉前缀 `v` 后的值；不等则
   `exit 1`（rsync 表面成功但内容不对时不能假装回滚成功）。

6. **打印总结**：在 Actions 运行日志里输出
   「已回滚：VPS 清单 → target_version，GitHub bad_version → prerelease」，
   连同两个版本号——回滚记录本身就是这次运行的日志，不需要额外落盘。

### 与现有 `build.yml` 的关系

纯新增文件，不改动 `build.yml` 任何一行；两者共享 secrets 但互不触发对方（`build.yml`
挂在 `push tag` + 自己的 `workflow_dispatch`，`rollback.yml` 只有自己的
`workflow_dispatch`）。

## 不在本次范围

- 不处理「已装上坏版本的用户」的强制降级（`allowDowngrade`）——留作后续，若要做需要
  提前在**每个已发布版本**里就打开这个开关（装好的旧二进制的逻辑没法事后修改），
  属于另一个决策，不在本次讨论范围内。
- 不做自建源清单文件的额外归档机制——GitHub Release 已经是天然归档源，本次不重复
  造轮子。
- 不做「回滚后自动通知」（比如群里发消息告知回滚发生）——Actions 运行记录本身可查，
  需要的话后续单独加。

## 验收标准

- 网页 Actions → Rollback release → Run workflow，填两个版本号后触发，几十秒到
  一两分钟内跑完。
- 跑完后用浏览器直接访问 `${SELF_HOSTED_UPDATE_URL}latest-mac.yml`，内容里的
  `version` 字段确实是 `target_version`。
- `gh release view bad_version --repo Caffeine-Ops/claude-desktop-releases` 显示
  该版本已是 `prerelease`。
- 故意填一个不存在的版本号触发，工作流在「前置校验」step 就失败退出，不产生任何
  副作用（VPS 清单、GitHub Release 状态均未被改动）。
