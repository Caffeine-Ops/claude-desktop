#!/usr/bin/env bash
# PostToolUse hook：Edit/Write 改到 .ts/.tsx 后跑增量 typecheck。
# 借 composite 工程的 tsc --build 增量能力，绝大多数情况下毫秒级返回。
# 类型错误通过 exit 2 + stderr 回灌给 Claude，让它当场修，而不是攒到 CI。

# hook 的 JSON 从 stdin 进来；用 node 稳健解析 file_path（sed 在中文 locale 下会乱码）。
input="$(cat)"
file_path="$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_input&&j.tool_input.file_path)||"")}catch(e){}})' 2>/dev/null)"

# 非 .ts/.tsx 改动直接放行（改 css/json/md 不触发类型检查）。
case "$file_path" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# 切到项目根（hook 的 cwd 不保证）。
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

# 跑和 CI 完全一样的命令（package.json 的 typecheck = node -p + web -p）。
# 不用 tsc --build：composite + 全局 d.ts 增强在 --build 模式下有假阳性，
# 会和 CI 的 -p 行为撕裂（hook 报错但 CI 绿）。一致性 > 增量速度。
if ! out="$(bun run typecheck 2>&1)"; then
  {
    echo "TypeScript 类型检查未通过（改动文件：${file_path}）："
    echo ""
    echo "$out"
    echo ""
    echo "请修复上述类型错误后再继续。"
  } >&2
  exit 2
fi

exit 0
