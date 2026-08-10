# shellcheck shell=bash
# tender-review skill Python bootstrap — macOS / Linux.
#
# 故意与 writing / ppt-master 平行维护，不抽公共依赖：技能必须自包含——用户
# 可能只装其中一个，它们也可能被分开打包发布。本文件与
# skills/writing/bin/ensure-python.sh 结构逐行对应（由它机械替换前缀生成），
# 改一处记得对照另一处是否也该改（但不要合并成共享文件）。
#
# 必须用 `source` 调用（不是直接执行）：脚本通过 `export TENDER_PY=...` 把就绪的
# 解释器路径回灌给调用方的 shell。直接 `bash ensure-python.sh` 只会在子 shell
# 里 export，父进程拿不到 TENDER_PY。SKILL.md 顶部约定也是 `source`。
#
# 为什么这个技能需要它：上游的 §-1 check_env.py 是「检测缺什么、然后告诉用户
# 自己去敲 pip install」——命令行里这是对的设计，桌面产品里不是。本脚本把那一步
# 变成用户零操作。
#
# 干的事：
#   1. 把 venv 落在 ~/.tender-review-skill/venv（用户可写目录）。打包后的 skill
#      目录在 Electron resources 下是只读的，venv 绝不能建在 skill 目录里。
#   2. 选解释器建 venv：优先 app 自带的 python-runtime（路径由主进程经
#      TENDER_PYTHON_HOME 注入，钉死 3.12，避开本机可能是 py3.14 → 原生扩展无
#      cp314 wheel 退化源码编译卡死的坑）；没注入则回退系统 python3.12 /
#      python3.11 / python3，并对 3.14+ 提前告警。
#   3. 首次 pip install -r requirements.txt（python-docx / pypdf / openpyxl）；
#      之后用一个 .deps-ok 哨兵文件标记完成，命中就秒过。依次尝试清华 → 阿里
#      → 官方 PyPI 三个源（国内直连官方源常被墙握手中断/卡死，见历史教训
#      2026-05-14），每源加超时，卡住就换下一个而不是无限等。
#   4. export TENDER_PY 指向 venv 里的解释器，供文档里所有 `python ...` 命令替换。
#
# 失败时打印明确原因并 return 1（不 exit，避免把调用方 shell 一起带走）。

TENDER_VENV_DIR="${TENDER_VENV_DIR:-$HOME/.tender-review-skill/venv}"
__tender_req="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/requirements.txt"

# ── 1. 已就绪：venv 存在 + 依赖装好哨兵在 → 直接导出，秒过 ──────────────
__tender_py="$TENDER_VENV_DIR/bin/python"
if [ -x "$__tender_py" ] && [ -f "$TENDER_VENV_DIR/.deps-ok" ]; then
  export TENDER_PY="$__tender_py"
  echo "[tender] Python 就绪：$TENDER_PY"
  unset __tender_py __tender_req
  return 0 2>/dev/null || exit 0
fi

# ── 2. 选 base 解释器 ─────────────────────────────────────────────────
# app 自带 runtime 优先（TENDER_PYTHON_HOME 由主进程注入，见 cliDetect
# resolveBundledPythonHome / engine openSession）。
__tender_base=""
if [ -n "$TENDER_PYTHON_HOME" ]; then
  for __c in "$TENDER_PYTHON_HOME/bin/python3" "$TENDER_PYTHON_HOME/bin/python" "$TENDER_PYTHON_HOME/python3"; do
    if [ -x "$__c" ]; then __tender_base="$__c"; break; fi
  done
  [ -z "$__tender_base" ] && echo "[tender] 警告：TENDER_PYTHON_HOME=$TENDER_PYTHON_HOME 下没找到解释器，回退系统 python"
fi
# 回退系统：偏好有成熟 cp31x wheel 的 3.12 / 3.11，最后才裸 python3。
if [ -z "$__tender_base" ]; then
  for __c in python3.12 python3.11 python3; do
    if command -v "$__c" >/dev/null 2>&1; then __tender_base="$(command -v "$__c")"; break; fi
  done
fi
if [ -z "$__tender_base" ]; then
  echo "[tender] 错误：没有可用的 Python 解释器。请安装 Python 3.12（推荐）或确保 app 自带 runtime 完整。"
  unset __tender_py __tender_req __tender_base __c
  return 1 2>/dev/null || exit 1
fi

# py3.14+ 用裸 python3 命中时告警：PyMuPDF/Pillow/numpy 可能无 cp314 wheel，
# pip 退化源码编译会极慢甚至失败（历史教训）。app 自带 runtime 钉 3.12 不踩。
__tender_ver="$("$__tender_base" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null)"
case "$__tender_ver" in
  3.14|3.15|3.16|3.17|3.18|3.19)
    echo "[tender] 警告：base 解释器是 Python $__tender_ver，部分依赖可能无预编译 wheel，pip 会退化源码编译（慢/可能失败）。建议改用 Python 3.12。"
    ;;
esac

# ── 3. 建 venv（缺则建）+ pip install ─────────────────────────────────
if [ ! -x "$__tender_py" ]; then
  echo "[tender] 用 $__tender_base (Python $__tender_ver) 建 venv → $TENDER_VENV_DIR"
  if ! "$__tender_base" -m venv "$TENDER_VENV_DIR"; then
    echo "[tender] 错误：创建 venv 失败。"
    unset __tender_py __tender_req __tender_base __c __tender_ver
    return 1 2>/dev/null || exit 1
  fi
fi

echo "[tender] 安装依赖（首次约几分钟，之后秒过）…"
"$__tender_py" -m pip install --upgrade pip >/dev/null 2>&1

# 依次尝试清华 → 阿里 → 官方 PyPI；单源卡住/中断（国内直连官方源常见）就换
# 下一个，而不是无限等（历史教训：远程代理下 pip 曾卡死 20+ 分钟无输出）。
__tender_mirrors=(
  "https://pypi.tuna.tsinghua.edu.cn/simple"
  "https://mirrors.aliyun.com/pypi/simple"
  ""
)
__tender_ok=0
for __tender_idx in "${__tender_mirrors[@]}"; do
  if [ -n "$__tender_idx" ]; then
    echo "[tender] 尝试镜像源：$__tender_idx"
    __tender_host="$(echo "$__tender_idx" | sed -E 's#https?://([^/]+).*#\1#')"
    if "$__tender_py" -m pip install -r "$__tender_req" -i "$__tender_idx" --trusted-host "$__tender_host" --timeout 30; then
      __tender_ok=1
      break
    fi
  else
    echo "[tender] 尝试官方源：pypi.org"
    if "$__tender_py" -m pip install -r "$__tender_req" --timeout 30; then
      __tender_ok=1
      break
    fi
  fi
  echo "[tender] 该源失败/超时，换下一个…"
done

if [ "$__tender_ok" = 1 ]; then
  : > "$TENDER_VENV_DIR/.deps-ok"
  export TENDER_PY="$__tender_py"
  echo "[tender] Python 就绪：$TENDER_PY"
  unset __tender_py __tender_req __tender_base __c __tender_ver __tender_mirrors __tender_idx __tender_host __tender_ok
  return 0 2>/dev/null || exit 0
fi

echo "[tender] 错误：清华/阿里/官方三个源均安装失败。检查网络后重跑本脚本（venv 已建，只补依赖）。"
unset __tender_py __tender_req __tender_base __c __tender_ver __tender_mirrors __tender_idx __tender_host __tender_ok
return 1 2>/dev/null || exit 1
