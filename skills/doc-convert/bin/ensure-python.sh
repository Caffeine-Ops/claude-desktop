# shellcheck shell=bash
# doc-convert skill Python bootstrap — macOS / Linux.
#
# 故意与 tender-review / writing / ppt-master 平行维护，不抽公共依赖：技能必须
# 自包含——用户可能只装其中一个，它们也可能被分开打包发布。本文件与
# skills/tender-review/bin/ensure-python.sh 结构逐行对应（由它机械替换前缀生成），
# 改一处记得对照另一处是否也该改（但不要合并成共享文件）。
#
# 必须用 `source` 调用（不是直接执行）：脚本通过 `export DOC_CONVERT_PY=...` 把
# 就绪的解释器路径回灌给调用方的 shell。直接 `bash ensure-python.sh` 只会在子
# shell 里 export，父进程拿不到 DOC_CONVERT_PY。SKILL.md 顶部约定也是 `source`。
#
# 干的事：
#   1. venv 落 ~/.doc-convert-skill/venv（用户可写目录）。打包后的 skill 目录在
#      Electron resources 下是只读的，venv 绝不能建在 skill 目录里。
#   2. 选解释器建 venv：优先 app 自带 python-runtime（路径由主进程经
#      DOC_CONVERT_PYTHON_HOME 注入，钉死 3.12，避开本机可能是 py3.14 → 原生
#      扩展无 cp314 wheel 退化源码编译卡死的坑）；没注入则回退系统 python3.12 /
#      python3.11 / python3，并对 3.14+ 提前告警。
#   3. 首次 pip install -r requirements.txt；之后用 .deps-ok 哨兵秒过。依次尝试
#      清华 → 阿里 → 官方 PyPI，每源加超时，卡住就换下一个而不是无限等。
#   4. export DOC_CONVERT_PY 指向 venv 解释器，供文档里所有 python 命令替换。
#
# 失败时打印明确原因并 return 1（不 exit，避免把调用方 shell 一起带走）。

DOC_CONVERT_VENV_DIR="${DOC_CONVERT_VENV_DIR:-$HOME/.doc-convert-skill/venv}"
__dc_req="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/requirements.txt"

# ── 1. 已就绪：venv 存在 + 哨兵内容与当前 requirements.txt 一致 → 秒过 ──
# 哨兵存的是 requirements.txt 的一份副本，不是空文件。理由：空文件只能回答
# 「以前装过吗」，回答不了「装的是不是现在这份清单」。PR 2 加 pdfplumber 时
# 踩到过——老用户 venv 里躺着 PR 1 留下的空哨兵，脚本秒过、新依赖永远装不上，
# 脚本一 import 就是一屏英文堆栈。改成内容比对后：清单变了 → 自动补装，
# 已装好的包 pip 会跳过，只下新增的；清单没变 → 照旧秒过。自愈，不需要
# 用户做任何事，也不需要额外维护一个版本号。
__dc_py="$DOC_CONVERT_VENV_DIR/bin/python"
if [ -x "$__dc_py" ] && cmp -s "$__dc_req" "$DOC_CONVERT_VENV_DIR/.deps-ok"; then
  export DOC_CONVERT_PY="$__dc_py"
  echo "[doc-convert] Python 就绪：$DOC_CONVERT_PY"
  unset __dc_py __dc_req
  return 0 2>/dev/null || exit 0
fi

# ── 2. 选 base 解释器 ─────────────────────────────────────────────────
__dc_base=""
if [ -n "$DOC_CONVERT_PYTHON_HOME" ]; then
  for __c in "$DOC_CONVERT_PYTHON_HOME/bin/python3" "$DOC_CONVERT_PYTHON_HOME/bin/python" "$DOC_CONVERT_PYTHON_HOME/python3"; do
    if [ -x "$__c" ]; then __dc_base="$__c"; break; fi
  done
  [ -z "$__dc_base" ] && echo "[doc-convert] 警告：DOC_CONVERT_PYTHON_HOME=$DOC_CONVERT_PYTHON_HOME 下没找到解释器，回退系统 python"
fi
if [ -z "$__dc_base" ]; then
  for __c in python3.12 python3.11 python3; do
    if command -v "$__c" >/dev/null 2>&1; then __dc_base="$(command -v "$__c")"; break; fi
  done
fi
if [ -z "$__dc_base" ]; then
  echo "[doc-convert] 错误：没有可用的 Python 解释器。请安装 Python 3.12（推荐）或确保 app 自带 runtime 完整。"
  unset __dc_py __dc_req __dc_base __c
  return 1 2>/dev/null || exit 1
fi

__dc_ver="$("$__dc_base" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null)"
case "$__dc_ver" in
  3.14|3.15|3.16|3.17|3.18|3.19)
    echo "[doc-convert] 警告：base 解释器是 Python $__dc_ver，部分依赖可能无预编译 wheel，pip 会退化源码编译（慢/可能失败）。建议改用 Python 3.12。"
    ;;
esac

# ── 3. 建 venv（缺则建）+ pip install ─────────────────────────────────
if [ ! -x "$__dc_py" ]; then
  echo "[doc-convert] 用 $__dc_base (Python $__dc_ver) 建 venv → $DOC_CONVERT_VENV_DIR"
  if ! "$__dc_base" -m venv "$DOC_CONVERT_VENV_DIR"; then
    echo "[doc-convert] 错误：创建 venv 失败。"
    unset __dc_py __dc_req __dc_base __c __dc_ver
    return 1 2>/dev/null || exit 1
  fi
fi

echo "[doc-convert] 安装依赖（首次约几分钟，之后秒过）…"
"$__dc_py" -m pip install --upgrade pip >/dev/null 2>&1

__dc_mirrors=(
  "https://pypi.tuna.tsinghua.edu.cn/simple"
  "https://mirrors.aliyun.com/pypi/simple"
  ""
)
__dc_ok=0
for __dc_idx in "${__dc_mirrors[@]}"; do
  if [ -n "$__dc_idx" ]; then
    echo "[doc-convert] 尝试镜像源：$__dc_idx"
    __dc_host="$(echo "$__dc_idx" | sed -E 's#https?://([^/]+).*#\1#')"
    if "$__dc_py" -m pip install -r "$__dc_req" -i "$__dc_idx" --trusted-host "$__dc_host" --timeout 30; then
      __dc_ok=1
      break
    fi
  else
    echo "[doc-convert] 尝试官方源：pypi.org"
    if "$__dc_py" -m pip install -r "$__dc_req" --timeout 30; then
      __dc_ok=1
      break
    fi
  fi
  echo "[doc-convert] 该源失败/超时，换下一个…"
done

if [ "$__dc_ok" = 1 ]; then
  cp "$__dc_req" "$DOC_CONVERT_VENV_DIR/.deps-ok"
  export DOC_CONVERT_PY="$__dc_py"
  echo "[doc-convert] Python 就绪：$DOC_CONVERT_PY"
  unset __dc_py __dc_req __dc_base __c __dc_ver __dc_mirrors __dc_idx __dc_host __dc_ok
  return 0 2>/dev/null || exit 0
fi

echo "[doc-convert] 错误：清华/阿里/官方三个源均安装失败。检查网络后重跑本脚本（venv 已建，只补依赖）。"
unset __dc_py __dc_req __dc_base __c __dc_ver __dc_mirrors __dc_idx __dc_host __dc_ok
return 1 2>/dev/null || exit 1
