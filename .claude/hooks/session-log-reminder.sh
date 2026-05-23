#!/usr/bin/env bash
# Stop hook：会话结束时，若本次有实质性改动（git working tree 非空），
# 提醒把关键上下文写进 Obsidian vault 的 sessions/ 日志（遵循全局 CLAUDE.md 规范）。
# 用 systemMessage 软提醒，不阻断 —— 纯问答/无改动的会话不打扰。
set -euo pipefail

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || cd "$(dirname "$0")/../.." || exit 0

# 没有改动就静默退出，不提醒。
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  exit 0
fi

vault="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian Vault/my_claude/sessions"
today="$(date +%Y-%m-%d)"
logfile="$vault/${today}-claude-desktop.md"

if [ -f "$logfile" ]; then
  msg="本次 claude-desktop 会话有未提交改动。今日已有会话日志 ${today}-claude-desktop.md —— 若做了实质性工作，记得追加一条摘要（重点写「为什么」和未完成 TODO），别新建重复文件。"
else
  msg="本次 claude-desktop 会话有未提交改动。若做了实质性工作，记得在 sessions/${today}-claude-desktop.md 写一条会话日志（20 行内，重点写「为什么」和未完成 TODO），修了 bug 还要写 errors/ 并加双链。"
fi

printf '{"systemMessage": %s}\n' "$(printf '%s' "$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
exit 0
