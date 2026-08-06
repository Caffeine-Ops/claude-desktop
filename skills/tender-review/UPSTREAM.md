# 上游来源与本地改动

本技能不是本仓自研，是 vendor 进来的开源技能。

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/matongAI-lab/tender-review-kit |
| 上游 commit | `06d0409d4221ae366f25b88fdfe5ad5388b6b37b` |
| 上游提交日期 | 2026-06-21 |
| 拷入本仓日期 | 2026-08-06 |
| 上游许可 | MIT |

## 为什么是 vendor 拷贝，不是 submodule / subtree

拷入时上游已 1.5 个月无更新，迭代不频繁；而 `skills/` 整体要被 electron-builder
的 extraResources 打进安装包，submodule 会给打包链平添一个「有没有 init」的失败面。
直接拷贝 + 这张改动清单，同步成本更低且可 diff。

## 本地改动清单（同步上游时逐条对照）

| # | 位置 | 改了什么 | 为什么 |
|---|---|---|---|
| 1 | `SKILL.md` frontmatter | `name: tender-review-skill` → `tender-review` | 本仓约定 skill 目录名即命令名，不一致会对不上 |
| 2 | `SKILL.md` 顶部 | 新增「在 Claude Desktop 里运行」一段 | 上游 §-1 让用户自己敲 pip install，桌面产品里不能这样 |
| 3 | `bin/ensure-python.sh` / `.cmd` | 新增（上游没有 `bin/`） | 自动建 venv 装依赖，用户零操作 |
| 4 | `.gitignore`（2026-08-06 恢复） | 曾被拷贝步骤误删又恢复，内容与上游逐字一致，仅顶部追加一段本仓视角说明 | 它不是构建产物忽略文件，是隐私护栏——忽略 `workspace/`（扫描产物）、`*.pdf`/`*.docx`/`*.doc`（用户标书）、`*.xlsx`（核对清单）等。删掉后根 `.gitignore` 盖不住这些（只有 `skills/**/__pycache__/` 一条），真机走查已实证：跑完一次审标后 `workspace/` 变成未跟踪目录，`git add .` 会把用户标书内容提交进仓库 |

**删除的上游文件**：`.git/`、`.github/`、`.gitattributes`。`.gitignore` 曾被一并删除，已于 2026-08-06 恢复，见上表第 4 条。

## 同步上游的做法

1. 拉上游新 commit，与 `06d0409` 做 diff
2. 逐条比对上表三处本地改动是否受影响
3. 合并后更新本文件的 commit 与日期
