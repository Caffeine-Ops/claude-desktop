# shellcheck shell=bash
# ppt-master Python bootstrap — macOS / Linux.
#
# 必须用 `source` 调用（不是直接执行）：脚本通过 `export PPT_PY=...` 把就绪的
# 解释器路径回灌给调用方的 shell。直接 `bash ensure-python.sh` 只会在子 shell
# 里 export，父进程拿不到 PPT_PY。SKILL.md 顶部约定也是 `source`。
#
# 干的事：
#   1. 把 venv 落在 ~/.ppt-master/venv（用户可写目录，与 config.py 的
#      USER_CONFIG_DIR 约定一致）。打包后的 skill 目录在 Electron resources 下
#      是只读的，venv 绝不能建在 skill 目录里。
#   2. 选解释器建 venv：优先 app 自带的 python-runtime（路径由主进程经
#      PPT_MASTER_PYTHON_HOME 注入，钉死 3.12，避开本机可能是 py3.14 → 原生
#      扩展无 cp314 wheel 退化源码编译卡死的坑）；没注入则回退系统 python3.12
#      / python3.11 / python3，并对 3.14+ 提前告警。
#   3. 首次 pip install -r requirements.txt（用户机器联网拉 wheel，几分钟）；
#      之后用一个 .deps-ok 哨兵文件标记完成，命中就秒过。
#   4. export PPT_PY 指向 venv 里的解释器，供文档里所有 `python3 ...` 命令替换。
#
# 失败时打印明确原因并 return 1（不 exit，避免把调用方 shell 一起带走）。

PPT_MASTER_VENV_DIR="${PPT_MASTER_VENV_DIR:-$HOME/.ppt-master/venv}"
__ppt_req="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/requirements.txt"

# ── 1. 已就绪：venv 存在 + 依赖装好哨兵在 → 直接导出，秒过 ──────────────
__ppt_py="$PPT_MASTER_VENV_DIR/bin/python"
if [ -x "$__ppt_py" ] && [ -f "$PPT_MASTER_VENV_DIR/.deps-ok" ]; then
  export PPT_PY="$__ppt_py"
  echo "[ppt-master] Python 就绪：$PPT_PY"
  unset __ppt_py __ppt_req
  return 0 2>/dev/null || exit 0
fi

# ── 2. 选 base 解释器 ─────────────────────────────────────────────────
# app 自带 runtime 优先（PPT_MASTER_PYTHON_HOME 由主进程注入，见 cliDetect
# resolveBundledPythonHome / engine openSession）。
__ppt_base=""
if [ -n "$PPT_MASTER_PYTHON_HOME" ]; then
  for __c in "$PPT_MASTER_PYTHON_HOME/bin/python3" "$PPT_MASTER_PYTHON_HOME/bin/python" "$PPT_MASTER_PYTHON_HOME/python3"; do
    if [ -x "$__c" ]; then __ppt_base="$__c"; break; fi
  done
  [ -z "$__ppt_base" ] && echo "[ppt-master] 警告：PPT_MASTER_PYTHON_HOME=$PPT_MASTER_PYTHON_HOME 下没找到解释器，回退系统 python"
fi
# 回退系统：偏好有成熟 cp31x wheel 的 3.12 / 3.11，最后才裸 python3。
if [ -z "$__ppt_base" ]; then
  for __c in python3.12 python3.11 python3; do
    if command -v "$__c" >/dev/null 2>&1; then __ppt_base="$(command -v "$__c")"; break; fi
  done
fi
if [ -z "$__ppt_base" ]; then
  echo "[ppt-master] 错误：没有可用的 Python 解释器。请安装 Python 3.12（推荐）或确保 app 自带 runtime 完整。"
  unset __ppt_py __ppt_req __ppt_base __c
  return 1 2>/dev/null || exit 1
fi

# py3.14+ 用裸 python3 命中时告警：PyMuPDF/Pillow/numpy 可能无 cp314 wheel，
# pip 退化源码编译会极慢甚至失败（历史教训）。app 自带 runtime 钉 3.12 不踩。
__ppt_ver="$("$__ppt_base" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null)"
case "$__ppt_ver" in
  3.14|3.15|3.16|3.17|3.18|3.19)
    echo "[ppt-master] 警告：base 解释器是 Python $__ppt_ver，部分依赖可能无预编译 wheel，pip 会退化源码编译（慢/可能失败）。建议改用 Python 3.12。"
    ;;
esac

# ── 3. 建 venv（缺则建）+ pip install ─────────────────────────────────
if [ ! -x "$__ppt_py" ]; then
  echo "[ppt-master] 用 $__ppt_base (Python $__ppt_ver) 建 venv → $PPT_MASTER_VENV_DIR"
  if ! "$__ppt_base" -m venv "$PPT_MASTER_VENV_DIR"; then
    echo "[ppt-master] 错误：创建 venv 失败。"
    unset __ppt_py __ppt_req __ppt_base __c __ppt_ver
    return 1 2>/dev/null || exit 1
  fi
fi

echo "[ppt-master] 安装依赖（首次约几分钟，之后秒过）…"
"$__ppt_py" -m pip install --upgrade pip >/dev/null 2>&1
if "$__ppt_py" -m pip install -r "$__ppt_req"; then
  : > "$PPT_MASTER_VENV_DIR/.deps-ok"
  export PPT_PY="$__ppt_py"
  echo "[ppt-master] Python 就绪：$PPT_PY"
  unset __ppt_py __ppt_req __ppt_base __c __ppt_ver
  return 0 2>/dev/null || exit 0
fi

echo "[ppt-master] 错误：pip install 失败。检查网络后重跑本脚本（venv 已建，只补依赖）。"
unset __ppt_py __ppt_req __ppt_base __c __ppt_ver
return 1 2>/dev/null || exit 1
