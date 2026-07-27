# shellcheck shell=bash
# writing skill Python bootstrap — macOS / Linux.
#
# 故意与 ppt-master 平行维护，不抽公共依赖：技能必须自包含——用户可能只装
# writing 不装 ppt-master，两者也可能被分开打包发布。本文件与
# skills/ppt-master/bin/ensure-python.sh 结构逐行对应，改一处记得对照另一处
# 是否也该改（但不要合并成共享文件）。
#
# 必须用 `source` 调用（不是直接执行）：脚本通过 `export WRITING_PY=...` 把就绪的
# 解释器路径回灌给调用方的 shell。直接 `bash ensure-python.sh` 只会在子 shell
# 里 export，父进程拿不到 WRITING_PY。SKILL.md 顶部约定也是 `source`。
#
# 干的事：
#   1. 把 venv 落在 ~/.writing-skill/venv（用户可写目录，与打包后 skill 目录
#      只读的约束一致）。打包后的 skill 目录在 Electron resources 下是只读
#      的，venv 绝不能建在 skill 目录里。
#   2. 选解释器建 venv：优先 app 自带的 python-runtime（路径由主进程经
#      WRITING_PYTHON_HOME 注入，钉死 3.12，避开本机可能是 py3.14 → 原生
#      扩展无 cp314 wheel 退化源码编译卡死的坑）；没注入则回退系统 python3.12
#      / python3.11 / python3，并对 3.14+ 提前告警。
#   3. 首次 pip install -r requirements.txt（用户机器联网拉 wheel，几分钟）；
#      之后用一个 .deps-ok 哨兵文件标记完成，命中就秒过。依次尝试清华 → 阿里
#      → 官方 PyPI 三个源（国内直连官方源常被墙握手中断/卡死，见历史教训
#      2026-05-14），每源加超时，卡住就换下一个而不是无限等。
#   4. export WRITING_PY 指向 venv 里的解释器，供文档里所有 `python3 ...` 命令替换。
#
# 失败时打印明确原因并 return 1（不 exit，避免把调用方 shell 一起带走）。

WRITING_VENV_DIR="${WRITING_VENV_DIR:-$HOME/.writing-skill/venv}"
__writing_req="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/requirements.txt"

# ── 1. 已就绪：venv 存在 + 依赖装好哨兵在 → 直接导出，秒过 ──────────────
__writing_py="$WRITING_VENV_DIR/bin/python"
if [ -x "$__writing_py" ] && [ -f "$WRITING_VENV_DIR/.deps-ok" ]; then
  export WRITING_PY="$__writing_py"
  echo "[writing] Python 就绪：$WRITING_PY"
  unset __writing_py __writing_req
  return 0 2>/dev/null || exit 0
fi

# ── 2. 选 base 解释器 ─────────────────────────────────────────────────
# app 自带 runtime 优先（WRITING_PYTHON_HOME 由主进程注入，见 cliDetect
# resolveBundledPythonHome / engine openSession）。
__writing_base=""
if [ -n "$WRITING_PYTHON_HOME" ]; then
  for __c in "$WRITING_PYTHON_HOME/bin/python3" "$WRITING_PYTHON_HOME/bin/python" "$WRITING_PYTHON_HOME/python3"; do
    if [ -x "$__c" ]; then __writing_base="$__c"; break; fi
  done
  [ -z "$__writing_base" ] && echo "[writing] 警告：WRITING_PYTHON_HOME=$WRITING_PYTHON_HOME 下没找到解释器，回退系统 python"
fi
# 回退系统：偏好有成熟 cp31x wheel 的 3.12 / 3.11，最后才裸 python3。
if [ -z "$__writing_base" ]; then
  for __c in python3.12 python3.11 python3; do
    if command -v "$__c" >/dev/null 2>&1; then __writing_base="$(command -v "$__c")"; break; fi
  done
fi
if [ -z "$__writing_base" ]; then
  echo "[writing] 错误：没有可用的 Python 解释器。请安装 Python 3.12（推荐）或确保 app 自带 runtime 完整。"
  unset __writing_py __writing_req __writing_base __c
  return 1 2>/dev/null || exit 1
fi

# py3.14+ 用裸 python3 命中时告警：PyMuPDF/Pillow/numpy 可能无 cp314 wheel，
# pip 退化源码编译会极慢甚至失败（历史教训）。app 自带 runtime 钉 3.12 不踩。
__writing_ver="$("$__writing_base" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null)"
case "$__writing_ver" in
  3.14|3.15|3.16|3.17|3.18|3.19)
    echo "[writing] 警告：base 解释器是 Python $__writing_ver，部分依赖可能无预编译 wheel，pip 会退化源码编译（慢/可能失败）。建议改用 Python 3.12。"
    ;;
esac

# ── 3. 建 venv（缺则建）+ pip install ─────────────────────────────────
if [ ! -x "$__writing_py" ]; then
  echo "[writing] 用 $__writing_base (Python $__writing_ver) 建 venv → $WRITING_VENV_DIR"
  if ! "$__writing_base" -m venv "$WRITING_VENV_DIR"; then
    echo "[writing] 错误：创建 venv 失败。"
    unset __writing_py __writing_req __writing_base __c __writing_ver
    return 1 2>/dev/null || exit 1
  fi
fi

echo "[writing] 安装依赖（首次约几分钟，之后秒过）…"
"$__writing_py" -m pip install --upgrade pip >/dev/null 2>&1

# 依次尝试清华 → 阿里 → 官方 PyPI；单源卡住/中断（国内直连官方源常见）就换
# 下一个，而不是无限等（历史教训：远程代理下 pip 曾卡死 20+ 分钟无输出）。
__writing_mirrors=(
  "https://pypi.tuna.tsinghua.edu.cn/simple"
  "https://mirrors.aliyun.com/pypi/simple"
  ""
)
__writing_ok=0
for __writing_idx in "${__writing_mirrors[@]}"; do
  if [ -n "$__writing_idx" ]; then
    echo "[writing] 尝试镜像源：$__writing_idx"
    __writing_host="$(echo "$__writing_idx" | sed -E 's#https?://([^/]+).*#\1#')"
    if "$__writing_py" -m pip install -r "$__writing_req" -i "$__writing_idx" --trusted-host "$__writing_host" --timeout 30; then
      __writing_ok=1
      break
    fi
  else
    echo "[writing] 尝试官方源：pypi.org"
    if "$__writing_py" -m pip install -r "$__writing_req" --timeout 30; then
      __writing_ok=1
      break
    fi
  fi
  echo "[writing] 该源失败/超时，换下一个…"
done

if [ "$__writing_ok" = 1 ]; then
  : > "$WRITING_VENV_DIR/.deps-ok"
  export WRITING_PY="$__writing_py"
  echo "[writing] Python 就绪：$WRITING_PY"
  unset __writing_py __writing_req __writing_base __c __writing_ver __writing_mirrors __writing_idx __writing_host __writing_ok
  return 0 2>/dev/null || exit 0
fi

echo "[writing] 错误：清华/阿里/官方三个源均安装失败。检查网络后重跑本脚本（venv 已建，只补依赖）。"
unset __writing_py __writing_req __writing_base __c __writing_ver __writing_mirrors __writing_idx __writing_host __writing_ok
return 1 2>/dev/null || exit 1
