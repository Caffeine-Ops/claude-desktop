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

# Monorepo 化后只检「改动文件所属的 workspace」，而不是全 workspace。
# 原因：open-design 的 apps/web、packages/* 是 vendored 进来的，带一批拷入时
# 就存在的预存类型错误（React 18/19 @types 串味、子包 tsconfig 缺 node types
# 等），它们不在本仓的质量门职责内、且其源码受「不改 vendored 源码」约束。
# 跑全 workspace 会被这些基线错误持续误伤，挡住对 apps/desktop（本仓自有代码）
# 的正常编辑。所以按路径前缀路由到对应包的 typecheck —— 与 CI / goal 验证命令
# (`bun run --cwd apps/desktop typecheck`) 语义一致。
case "$file_path" in
  */apps/desktop/*|apps/desktop/*)
    cmd=(bun run --cwd apps/desktop typecheck) ;;
  */apps/web/*|apps/web/*)
    cmd=(bun run --cwd apps/web typecheck) ;;
  */apps/daemon/*|apps/daemon/*)
    cmd=(bun run --cwd apps/daemon typecheck) ;;
  */packages/*|packages/*|*/tools/*|tools/*)
    # vendored 子包：本仓不为其预存错误把门，放行。
    exit 0 ;;
  *)
    # 落在仓库根/其它处的 .ts（脚本等）：检 desktop 作为最常见的本仓代码门。
    cmd=(bun run --cwd apps/desktop typecheck) ;;
esac

if ! out="$("${cmd[@]}" 2>&1)"; then
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
