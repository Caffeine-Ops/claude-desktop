# 发布回滚工作流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `.github/workflows/rollback.yml`，让开发者在 GitHub 网页手动触发，
把已发布的坏版本从两条更新分发线（自建 VPS 源 + GitHub Release 兜底源）里同时摘掉，
挡住「还没升级」的用户继续装到坏版本。

**Architecture:** 单个 `workflow_dispatch` 工作流，两个必填输入（`target_version`
回滚到哪个好版本、`bad_version` 下架哪个坏版本）。复用 `build.yml` 已有的
secrets（`RELEASE_REPO_TOKEN`、`SELFHOST_SSH_*`、`SELFHOST_DEPLOY_PATH`），新增
一个仓库 Variable（`SELF_HOSTED_UPDATE_URL`，公网地址本来就不是机密）用于回滚后
的验证步骤。核心机制：GitHub Release 天然保留每个历史版本当时的
`latest-mac.yml`/`latest.yml`，直接把 `target_version` 的这两个文件下载下来
覆盖到 VPS 当前目录，同时把 `bad_version` 标记为 GitHub prerelease。

**Tech Stack:** GitHub Actions（`workflow_dispatch`）、`gh` CLI、`rsync`、
`python3`（+ `pyyaml`，沿用 `build.yml` 里已有的按需安装写法）。

## Global Constraints

- 不强制拉回已经装上坏版本的用户——只挡住还没检查到更新的用户，`appUpdater.ts`
  本身不需要改动（不碰 `allowDowngrade`）。
- `target_version`/`bad_version` 必须由触发者手写填入，不做任何自动判定「谁是最新/
  谁是坏的」。
- 任何前置校验不通过 → 直接 `exit 1`，不执行后续任何写操作（VPS、GitHub Release
  均不改动）。
- 只覆盖 VPS 上的 `latest-mac.yml`/`latest.yml` 两个清单文件，不碰历史安装包
  （它们本来就因为 `build.yml` 的 rsync 不带 `--delete` 而保留着）。
- 新增文件不改动 `build.yml` 任何一行；两个工作流各自独立的 `workflow_dispatch`
  触发，互不干扰。
- 参照设计文档：`docs/superpowers/specs/2026-07-23-release-rollback-workflow-design.md`。

---

### Task 1: 工作流骨架 + 前置校验 step

**Files:**
- Create: `.github/workflows/rollback.yml`

**Interfaces:**
- Consumes：`secrets.RELEASE_REPO_TOKEN`（`gh` CLI 鉴权，对
  `Caffeine-Ops/claude-desktop-releases` 有读写权限，`build.yml` 已在用同一个）。
- Produces：`env.RELEASES_REPO` workflow 级环境变量（值
  `Caffeine-Ops/claude-desktop-releases`），后续所有 task 的 step 都用它，不要
  重新硬编码仓库名。

- [ ] **Step 1: 写入工作流骨架 + 前置校验 step**

创建 `.github/workflows/rollback.yml`：

```yaml
name: Rollback release

# 开发者应急手段：某个已发布版本有 bug，用它把「还没升级的用户」挡在坏版本外——
# 让自建源 VPS 的更新清单假装最新版还是上一个好版本，同时把坏版本在 GitHub
# Release 上标记为 prerelease（让 GitHub 那条兜底线的判定也跳过它）。
#
# 不处理「已经装上坏版本的用户」的强制降级——那需要提前在每个已发布版本里就打开
# autoUpdater.allowDowngrade，属于另一个决策，见
# docs/superpowers/specs/2026-07-23-release-rollback-workflow-design.md。
#
# 两个版本号都要手动填，不做自动判定「哪个是最新/哪个是坏的」——避免时序上的
# 误判（比如回滚当天又有新版本发布）。

on:
  workflow_dispatch:
    inputs:
      target_version:
        description: '回滚到这个版本号（例如 v0.0.37），必须是已经成功发布过的 tag'
        required: true
        type: string
      bad_version:
        description: '下架这个坏版本号（例如 v0.0.38），会被标记为 GitHub prerelease'
        required: true
        type: string

env:
  RELEASES_REPO: Caffeine-Ops/claude-desktop-releases

permissions:
  contents: read

jobs:
  rollback:
    name: Rollback to ${{ github.event.inputs.target_version }}
    runs-on: ubuntu-24.04
    env:
      GH_TOKEN: ${{ secrets.RELEASE_REPO_TOKEN }}
    steps:
      - name: Validate inputs
        shell: bash
        run: |
          set -euo pipefail
          TARGET="${{ inputs.target_version }}"
          BAD="${{ inputs.bad_version }}"

          echo "校验 target_version=${TARGET} 的 Release 是否存在且完整..."
          if ! gh release view "$TARGET" --repo "$RELEASES_REPO" --json assets,isPrerelease > target_release.json; then
            echo "::error::target_version ${TARGET} 对应的 Release 不存在"
            exit 1
          fi

          ASSET_NAMES=$(python3 -c "import json; d=json.load(open('target_release.json')); print(' '.join(a['name'] for a in d['assets']))")
          for f in latest-mac.yml latest.yml; do
            case " $ASSET_NAMES " in
              *" $f "*) ;;
              *) echo "::error::target_version ${TARGET} 的 Release 里缺少 $f，发布不完整，拒绝回滚"; exit 1 ;;
            esac
          done

          IS_PRERELEASE=$(python3 -c "import json; print(json.load(open('target_release.json'))['isPrerelease'])")
          if [ "$IS_PRERELEASE" = "True" ]; then
            echo "::error::target_version ${TARGET} 本身已经是 prerelease，回滚后 GitHub 线仍找不到最新稳定版，请确认版本号有没有填错"
            exit 1
          fi

          echo "校验 bad_version=${BAD} 的 Release 是否存在..."
          if ! gh release view "$BAD" --repo "$RELEASES_REPO" > /dev/null; then
            echo "::error::bad_version ${BAD} 对应的 Release 不存在"
            exit 1
          fi

          echo "前置校验通过：target_version=${TARGET}，bad_version=${BAD}"
```

- [ ] **Step 2: 校验 YAML 语法（actionlint）**

```bash
which actionlint || brew install actionlint
actionlint .github/workflows/rollback.yml
```

Expected: 无输出、退出码 0（actionlint 没发现问题）。

- [ ] **Step 3: 本地跑同款校验逻辑，验证「通过」与「拒绝」两种分支**

这一步只调用只读的 `gh release view`（不会修改任何东西），用真实存在的版本号
本地直接跑 Step 1 里那段 bash，不需要真的触发 workflow：

```bash
export RELEASES_REPO=Caffeine-Ops/claude-desktop-releases
export GH_TOKEN=$(gh auth token)

# 用真实存在的版本号验证「通过」分支：
TARGET=v0.0.37 BAD=v0.0.38 bash -c '
set -euo pipefail
gh release view "$TARGET" --repo "$RELEASES_REPO" --json assets,isPrerelease > /tmp/target_release.json
python3 -c "import json; d=json.load(open(\"/tmp/target_release.json\")); print(sorted(a[\"name\"] for a in d[\"assets\"]))"
python3 -c "import json; print(json.load(open(\"/tmp/target_release.json\"))[\"isPrerelease\"])"
gh release view "$BAD" --repo "$RELEASES_REPO" > /dev/null && echo BAD_EXISTS_OK
'
```

Expected：资产列表里能看到 `latest-mac.yml`/`latest.yml`；`isPrerelease` 输出
`False`；最后一行打印 `BAD_EXISTS_OK`。

```bash
# 用瞎编的版本号验证「拒绝」分支：
gh release view v9.9.9-does-not-exist --repo Caffeine-Ops/claude-desktop-releases
echo "exit code: $?"
```

Expected：`gh` 报错（`release not found`），退出码非 0——证明前置校验的
`if ! gh release view ...` 分支在真实场景下会正确触发 `exit 1`。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/rollback.yml
git commit -m "$(cat <<'EOF'
feat(ci): 新增发布回滚工作流骨架 + 前置校验

workflow_dispatch 手动触发，先做只读校验：target_version/bad_version
对应的 Release 是否存在、target_version 是否发布完整、是否误填成了
prerelease。校验不过直接 exit 1，不做任何写操作。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 下载 target_version 的历史清单 step

**Files:**
- Modify: `.github/workflows/rollback.yml`（在 `Validate inputs` 之后追加一个
  step）

**Interfaces:**
- Consumes：Task 1 产出的 `env.RELEASES_REPO`、job 级 `GH_TOKEN`。
- Produces：工作目录下的 `rollback-staging/latest-mac.yml` 与
  `rollback-staging/latest.yml`，Task 3 的 rsync step 直接读取这两个文件。

- [ ] **Step 1: 追加下载 step**

在 `jobs.rollback.steps` 的 `Validate inputs` 之后插入：

```yaml
      - name: Download target_version's manifest
        shell: bash
        run: |
          set -euo pipefail
          mkdir -p rollback-staging
          gh release download "${{ inputs.target_version }}" \
            --repo "$RELEASES_REPO" \
            --pattern "latest*.yml" \
            --dir rollback-staging \
            --clobber
          echo "=== 下载到的清单 ==="
          ls -la rollback-staging
```

- [ ] **Step 2: 校验 YAML 语法**

```bash
actionlint .github/workflows/rollback.yml
```

Expected: 退出码 0。

- [ ] **Step 3: 本地跑同款下载逻辑验证**

```bash
mkdir -p /tmp/rollback-staging-test
gh release download v0.0.37 \
  --repo Caffeine-Ops/claude-desktop-releases \
  --pattern "latest*.yml" \
  --dir /tmp/rollback-staging-test \
  --clobber
ls -la /tmp/rollback-staging-test
python3 -c "
import yaml
d = yaml.safe_load(open('/tmp/rollback-staging-test/latest-mac.yml'))
print('version:', d['version'])
"
```

（若报 `ModuleNotFoundError: No module named 'yaml'`，先
`python3 -m pip install --quiet pyyaml` 再重跑。）

Expected：`/tmp/rollback-staging-test` 下出现 `latest-mac.yml` 和
`latest.yml`；打印 `version: 0.0.37`（对应 v0.0.37 这个 tag，去掉了前缀 `v`）。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/rollback.yml
git commit -m "$(cat <<'EOF'
feat(ci): 回滚工作流新增「下载历史清单」step

从 target_version 对应的 GitHub Release 里把当时的 latest-mac.yml/
latest.yml 取出来，作为覆盖 VPS 当前清单的来源——GitHub Release 天然
保留历史版本产物，不需要额外的归档机制。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 覆盖 VPS 清单 step（rsync）

**Files:**
- Modify: `.github/workflows/rollback.yml`（在 `Download target_version's
  manifest` 之后追加一个 step）

**Interfaces:**
- Consumes：Task 2 产出的 `rollback-staging/latest-mac.yml` /
  `rollback-staging/latest.yml`；`secrets.SELFHOST_SSH_HOST` /
  `SELFHOST_SSH_USER` / `SELFHOST_SSH_KEY` / `SELFHOST_SSH_PORT` /
  `SELFHOST_DEPLOY_PATH`（与 `build.yml` 的「Sync to self-hosted update
  server」step 用的是同一套）。
- Produces：VPS 部署目录下的 `latest-mac.yml`/`latest.yml` 被覆盖成
  `target_version` 当时的内容。

- [ ] **Step 1: 追加 rsync step**

```yaml
      - name: Sync manifest to self-hosted update server
        shell: bash
        env:
          SSH_HOST: ${{ secrets.SELFHOST_SSH_HOST }}
          SSH_USER: ${{ secrets.SELFHOST_SSH_USER }}
          SSH_KEY: ${{ secrets.SELFHOST_SSH_KEY }}
          SSH_PORT: ${{ secrets.SELFHOST_SSH_PORT }}
          DEPLOY_PATH: ${{ secrets.SELFHOST_DEPLOY_PATH }}
        run: |
          set -euo pipefail
          if [ -z "${SSH_HOST}" ]; then
            echo "::error::SELFHOST_SSH_HOST 未配置，无法回滚自建源——本次回滚只完成了 GitHub 那一半，请检查 secrets 后重跑"
            exit 1
          fi
          mkdir -p ~/.ssh
          printf '%s\n' "${SSH_KEY}" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          PORT="${SSH_PORT:-22}"
          # 只覆盖这两个清单文件，不带 --delete、不动 VPS 上其余已保留的历史安装包。
          rsync -avz \
            -e "ssh -i ~/.ssh/deploy_key -p ${PORT} -o StrictHostKeyChecking=accept-new" \
            rollback-staging/latest-mac.yml rollback-staging/latest.yml \
            "${SSH_USER}@${SSH_HOST}:${DEPLOY_PATH}/"
          rm -f ~/.ssh/deploy_key
          echo "已将 latest-mac.yml / latest.yml 覆盖到 ${SSH_HOST}:${DEPLOY_PATH}/"
```

- [ ] **Step 2: 校验 YAML 语法**

```bash
actionlint .github/workflows/rollback.yml
```

Expected: 退出码 0。

- [ ] **Step 3: 人工核对（不在本地真的连 VPS 测试）**

这一步会真的覆盖生产环境 VPS 上的清单文件，本地没有 VPS 的 SSH 私钥、也不该在
「写计划/验证语法」阶段就去碰生产数据。核对方式改为**逐行对照**
`build.yml` 里已经在生产跑了很久、证明可靠的「Sync to self-hosted update
server」step（`.github/workflows/build.yml` 里搜 `Sync to self-hosted update
server`）：确认这里的 SSH 连接参数写法（`~/.ssh/deploy_key`、
`StrictHostKeyChecking=accept-new`、`PORT="${SSH_PORT:-22}"`）与它逐字一致，
只有 `rsync` 的源文件从 `release-out/`（整个目录）换成了这次的两个具名文件。
这一步的真正端到端验证放在 Task 6。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/rollback.yml
git commit -m "$(cat <<'EOF'
feat(ci): 回滚工作流新增「覆盖 VPS 清单」step

SSH 连接参数复用 build.yml「Sync to self-hosted update server」的写法，
只 rsync 两个清单文件、不带 --delete，不影响 VPS 上已保留的历史安装包。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 下架 bad_version step（标记 GitHub prerelease）

**Files:**
- Modify: `.github/workflows/rollback.yml`（在 `Sync manifest to self-hosted
  update server` 之后追加一个 step）

**Interfaces:**
- Consumes：job 级 `GH_TOKEN`、`env.RELEASES_REPO`。
- Produces：`bad_version` 在 `Caffeine-Ops/claude-desktop-releases` 上被标记为
  `prerelease`，`electron-updater` 的 GitHub provider（判定逻辑是「非
  prerelease 里版本号最高的」）不再会选中它。

- [ ] **Step 1: 追加下架 step**

```yaml
      - name: Mark bad_version as prerelease
        shell: bash
        run: |
          set -euo pipefail
          gh release edit "${{ inputs.bad_version }}" --repo "$RELEASES_REPO" --prerelease
          echo "${{ inputs.bad_version }} 已标记为 prerelease，GitHub 兜底线不再把它当最新稳定版。"
```

- [ ] **Step 2: 校验 YAML 语法**

```bash
actionlint .github/workflows/rollback.yml
```

Expected: 退出码 0。

- [ ] **Step 3: 本地只读核对 `gh release edit` 的参数写法**

```bash
gh release edit --help | grep -A2 -- '--prerelease'
```

Expected：确认 `--prerelease` 是 `gh release edit` 的合法 flag（不真的执行
edit——这一步会真的修改生产 Release 状态，留到 Task 6 端到端验证时才真正执行）。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/rollback.yml
git commit -m "$(cat <<'EOF'
feat(ci): 回滚工作流新增「下架坏版本」step

把 bad_version 标记为 GitHub prerelease，让 electron-updater 的 GitHub
provider（判定逻辑是「非 prerelease 里版本号最高的」）跳过它。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 新增仓库 Variable + 验证生效 step + Summary

**Files:**
- Modify: `.github/workflows/rollback.yml`（追加两个 step：验证 + summary）
- 手动操作：GitHub 网页 Settings → Secrets and variables → Actions →
  Variables 标签页，新增一个仓库 Variable

**Interfaces:**
- Consumes：`vars.SELF_HOSTED_UPDATE_URL`（新增的仓库 Variable，值就是
  `appUpdater.ts` 里 `SELF_HOSTED_FEED_URL` 对应的那个公网地址，例如
  `https://updates.你的域名.com/`）；Task 3 覆盖后的 VPS 状态。
- Produces：无（这是只读校验 + 收尾）。

**这个 Variable 为什么是新增的、之前设计里说「不新增密钥」是否矛盾**：这个 URL
本来就是公开地址——每个已装机的客户端都会用明文 HTTP 请求直接访问它，
不是机密信息，所以放进「Variable」（这类值在 Actions 日志里明文可见，
不会被当作 secret 打码）而不是「Secret」，跟设计文档「不新增密钥（secrets）」
的表述并不矛盾。之所以设计阶段没提前发现要加这个，是因为验证 VPS 是否真的
生效需要知道 VPS 对外的公网地址，而现有 `build.yml` 里所有 secrets 都是
「怎么连上 VPS 写文件」用的内部路径/主机名，没有一个是「客户端怎么从公网读」
的地址。

- [ ] **Step 1: 在 GitHub 网页新增仓库 Variable**

打开 `https://github.com/Caffeine-Ops/claude-desktop/settings/variables/actions`，
点 **New repository variable**：
- Name: `SELF_HOSTED_UPDATE_URL`
- Value: 与 `env.json` 里 `SELF_HOSTED_UPDATE_URL` 字段相同的那个公网地址
  （`appUpdater.ts:59` 读的就是这个 key；务必以 `/` 结尾，和该文件顶部注释里
  「务必以 `/` 结尾」的要求一致）

- [ ] **Step 2: 追加验证 step + summary step**

```yaml
      - name: Verify VPS manifest was actually updated
        shell: bash
        env:
          UPDATE_URL: ${{ vars.SELF_HOSTED_UPDATE_URL }}
        run: |
          set -euo pipefail
          if [ -z "$UPDATE_URL" ]; then
            echo "::error::仓库变量 SELF_HOSTED_UPDATE_URL 未配置，无法验证 VPS 清单是否生效"
            exit 1
          fi
          python3 -m pip install --quiet pyyaml
          curl -fsSL "${UPDATE_URL%/}/latest-mac.yml" -o verify-latest-mac.yml
          ACTUAL=$(python3 -c "import yaml; print(yaml.safe_load(open('verify-latest-mac.yml'))['version'])")
          EXPECTED="${{ inputs.target_version }}"
          EXPECTED="${EXPECTED#v}"
          if [ "$ACTUAL" != "$EXPECTED" ]; then
            echo "::error::验证失败：VPS 上 latest-mac.yml 的 version=${ACTUAL}，期望 ${EXPECTED}"
            exit 1
          fi
          echo "验证通过：VPS 清单 version=${ACTUAL}"

      - name: Summary
        shell: bash
        run: |
          echo "已回滚：VPS 清单 → ${{ inputs.target_version }}，GitHub ${{ inputs.bad_version }} → prerelease" >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 3: 校验 YAML 语法**

```bash
actionlint .github/workflows/rollback.yml
```

Expected: 退出码 0。

- [ ] **Step 4: 本地跑同款验证逻辑（针对当前真实生产状态，只读）**

```bash
# 把下面的 URL 换成你在 Step 1 里填的那个真实值：
UPDATE_URL="<你的 SELF_HOSTED_UPDATE_URL>"
curl -fsSL "${UPDATE_URL%/}/latest-mac.yml" -o /tmp/verify-latest-mac.yml
python3 -c "
import yaml
print(yaml.safe_load(open('/tmp/verify-latest-mac.yml'))['version'])
"
```

Expected：打印出当前生产环境真实的最新版本号（此刻应该是 `0.0.38`，因为还没有
真的触发过回滚）——证明这段 curl + 解析逻辑本身是通的。

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/rollback.yml
git commit -m "$(cat <<'EOF'
feat(ci): 回滚工作流新增验证生效 step + summary

回滚后重新读一次 VPS 上的 latest-mac.yml，断言 version 字段确实变成了
target_version，避免 rsync 表面成功但内容没生效时误报「回滚成功」。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 端到端真实验证（需要你手动确认后执行）

这一步会**真的**修改生产环境：覆盖 VPS 当前对外提供的更新清单、把一个真实
Release 标记成 prerelease。即使只是为了测试这个工作流本身，也会让当前所有用户
的更新检查结果发生变化，所以这个 Task 必须由你本人在 GitHub 网页上手动触发、
且看完结果后必须完成「复原」这一步——不能跳过、也不该由我自动执行。

**Files:** 无代码改动，纯验证。

- [ ] **Step 1: 推送分支、在网页上手动触发**

```bash
git push -u origin HEAD
```

打开 `https://github.com/Caffeine-Ops/claude-desktop/actions/workflows/rollback.yml`
（若分支未合并到默认分支，先在 Actions 页面顶部把 `Use workflow from` 切到你
这个分支），点 **Run workflow**，填：
- `target_version`: `v0.0.37`
- `bad_version`: `v0.0.38`

（用这两个真实存在的历史版本号做测试——**注意 v0.0.38 目前就是生产环境真实的
最新版本**，这次触发只是为了验证工作流本身能跑通，不代表 v0.0.38 真的有 bug。）

- [ ] **Step 2: 确认运行结果**

在 Actions 运行页面确认：
- 6 个 step 全部绿勾，无失败
- Summary 里显示「已回滚：VPS 清单 → v0.0.37，GitHub v0.0.38 → prerelease」

```bash
curl -fsSL "<你的 SELF_HOSTED_UPDATE_URL 去掉结尾斜杠>/latest-mac.yml" | python3 -c "import sys, yaml; print(yaml.safe_load(sys.stdin)['version'])"
```

Expected：打印 `0.0.37`。

```bash
gh release view v0.0.38 --repo Caffeine-Ops/claude-desktop-releases --json isPrerelease
```

Expected：`{"isPrerelease":true}`。

- [ ] **Step 3: 复原——把测试造成的状态改回真实情况**

这一步是本次测试专属的收尾，**真实回滚场景不需要这一步**（真实场景里
`bad_version` 就应该一直留在 prerelease、VPS 就应该一直指向 `target_version`，
直到修复版发布）。因为这次只是拿两个真实版本号验证机制能不能跑通，跑完必须把
生产状态复原，否则往后所有用户都会被卡在 v0.0.37、且 v0.0.38 会一直显示成
预发布：

```bash
# 1. 把 v0.0.38 改回正式版
gh release edit v0.0.38 --repo Caffeine-Ops/claude-desktop-releases --prerelease=false

# 2. 用同一个工作流「正向」跑一次，把 VPS 清单改回 v0.0.38：
#    Actions 页面再触发一次 Run workflow，
#    target_version=v0.0.38，bad_version 随便填一个更老的、不影响真实使用的
#    版本号（例如 v0.0.36）——这次触发的唯一目的是让 Sync 那个 step 把 VPS
#    清单覆盖回 v0.0.38，bad_version 那半的副作用（把 v0.0.36 也标成
#    prerelease）在 Step 3b 里一并复原。
```

```bash
# 3b. 把 Step 3 第 2 步顺带标记成 prerelease 的那个版本号也改回来：
gh release edit v0.0.36 --repo Caffeine-Ops/claude-desktop-releases --prerelease=false
```

```bash
# 4. 最终确认生产状态完全复原：
curl -fsSL "<你的 SELF_HOSTED_UPDATE_URL 去掉结尾斜杠>/latest-mac.yml" | python3 -c "import sys, yaml; print(yaml.safe_load(sys.stdin)['version'])"
gh release view v0.0.38 --repo Caffeine-Ops/claude-desktop-releases --json isPrerelease
gh release view v0.0.36 --repo Caffeine-Ops/claude-desktop-releases --json isPrerelease
gh release view v0.0.37 --repo Caffeine-Ops/claude-desktop-releases --json isPrerelease
```

Expected：VPS 清单 `version` 打印 `0.0.38`；v0.0.38 的 `isPrerelease` 为
`false`；v0.0.36 的 `isPrerelease` 为 `false`；v0.0.37（本来就不是 prerelease，
这次测试没碰它）的 `isPrerelease` 仍为 `false`。

- [ ] **Step 4: 合并分支**

确认端到端验证通过、生产状态已复原后，把这个分支合并到默认分支（走你们平时的
合并方式——直接 merge 还是开 PR 由你决定，我不会未经确认就推 main 或开 PR）。
