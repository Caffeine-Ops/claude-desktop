# shellcheck shell=bash
# spreadsheets skill Python bootstrap — macOS / Linux.
#
# 必须用 `source` 调用（不是直接执行）：脚本通过 `export SHEETS_PY=...` 把就绪的
# 解释器路径回灌给调用方的 shell。直接 `bash ensure-python.sh` 只会在子 shell
# 里 export，父进程拿不到 SHEETS_PY。SKILL.md 顶部约定也是 `source`。
#
# 干的事（照抄 ppt-master/bin/ensure-python.sh 的已验证模式）：
#   1. venv 落在 ~/.spreadsheets-skill/venv（用户可写目录）。打包后的 skill 目录
#      在 Electron resources 下是只读的，venv 绝不能建在 skill 目录里。
#   2. 选解释器建 venv：优先 app 自带的 python-runtime——路径由主进程经
#      PPT_MASTER_PYTHON_HOME 注入（名字带 ppt-master 是历史原因：engine 只注入
#      这一个 python home 变量，所有 Python skill 共用它，钉死 3.12 避开
#      py3.14 无预编译 wheel 退化源码编译的坑）；没注入则回退系统 python3.12
#      / python3.11 / python3。
#   3. 首次 pip install -r requirements.txt（联网拉 wheel，不到一分钟——依赖只有
#      openpyxl/Pillow/pandas）；之后用 .deps-ok 哨兵文件标记完成，命中就秒过。
#   4. export SHEETS_PY 指向 venv 里的解释器，供文档里所有 python 命令替换。
#
# 失败时打印明确原因并 return 1（不 exit，避免把调用方 shell 一起带走）。

SHEETS_VENV_DIR="${SHEETS_VENV_DIR:-$HOME/.spreadsheets-skill/venv}"
__sh_req="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/requirements.txt"

# ── 1. 已就绪：venv 存在 + 依赖装好哨兵在 → 直接导出，秒过 ──────────────
__sh_py="$SHEETS_VENV_DIR/bin/python"
if [ -x "$__sh_py" ] && [ -f "$SHEETS_VENV_DIR/.deps-ok" ]; then
  export SHEETS_PY="$__sh_py"
  echo "[spreadsheets] Python 就绪：$SHEETS_PY"
  unset __sh_py __sh_req
  return 0 2>/dev/null || exit 0
fi

# ── 2. 选 base 解释器 ─────────────────────────────────────────────────
# app 自带 runtime 优先（PPT_MASTER_PYTHON_HOME 由主进程注入，见 engine
# openSession；变量名的 ppt-master 前缀是历史遗留，指的就是 app 打包的 3.12）。
__sh_base=""
if [ -n "$PPT_MASTER_PYTHON_HOME" ]; then
  for __c in "$PPT_MASTER_PYTHON_HOME/bin/python3" "$PPT_MASTER_PYTHON_HOME/bin/python" "$PPT_MASTER_PYTHON_HOME/python3"; do
    if [ -x "$__c" ]; then __sh_base="$__c"; break; fi
  done
  [ -z "$__sh_base" ] && echo "[spreadsheets] 警告：PPT_MASTER_PYTHON_HOME=$PPT_MASTER_PYTHON_HOME 下没找到解释器，回退系统 python"
fi
# 回退系统：偏好有成熟 cp31x wheel 的 3.12 / 3.11，最后才裸 python3。
if [ -z "$__sh_base" ]; then
  for __c in python3.12 python3.11 python3; do
    if command -v "$__c" >/dev/null 2>&1; then __sh_base="$(command -v "$__c")"; break; fi
  done
fi
if [ -z "$__sh_base" ]; then
  echo "[spreadsheets] 错误：没有可用的 Python 解释器。请安装 Python 3.12（推荐）或确保 app 自带 runtime 完整。"
  unset __sh_py __sh_req __sh_base __c
  return 1 2>/dev/null || exit 1
fi

# py3.14+ 用裸 python3 命中时告警：Pillow/pandas 可能无 cp314 wheel，
# pip 退化源码编译会极慢甚至失败。app 自带 runtime 钉 3.12 不踩。
__sh_ver="$("$__sh_base" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null)"
case "$__sh_ver" in
  3.14|3.15|3.16|3.17|3.18|3.19)
    echo "[spreadsheets] 警告：base 解释器是 Python $__sh_ver，部分依赖可能无预编译 wheel，pip 会退化源码编译（慢/可能失败）。建议改用 Python 3.12。"
    ;;
esac

# ── 3. 建 venv（缺则建）+ pip install ─────────────────────────────────
if [ ! -x "$__sh_py" ]; then
  echo "[spreadsheets] 用 $__sh_base (Python $__sh_ver) 建 venv → $SHEETS_VENV_DIR"
  if ! "$__sh_base" -m venv "$SHEETS_VENV_DIR"; then
    echo "[spreadsheets] 错误：创建 venv 失败。"
    unset __sh_py __sh_req __sh_base __c __sh_ver
    return 1 2>/dev/null || exit 1
  fi
fi

echo "[spreadsheets] 安装依赖（首次不到一分钟，之后秒过）…"
"$__sh_py" -m pip install --upgrade pip >/dev/null 2>&1
if "$__sh_py" -m pip install -r "$__sh_req"; then
  : > "$SHEETS_VENV_DIR/.deps-ok"
  export SHEETS_PY="$__sh_py"
  echo "[spreadsheets] Python 就绪：$SHEETS_PY"
  unset __sh_py __sh_req __sh_base __c __sh_ver
  return 0 2>/dev/null || exit 0
fi

echo "[spreadsheets] 错误：pip install 失败。检查网络后重跑本脚本（venv 已建，只补依赖）。"
unset __sh_py __sh_req __sh_base __c __sh_ver
return 1 2>/dev/null || exit 1
