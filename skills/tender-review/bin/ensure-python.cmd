@echo off
REM tender-review skill Python bootstrap - Windows.
REM
REM 故意与 writing 平行维护，不抽公共依赖：技能必须自包含——用户可能只装
REM 其中一个，它们也可能被分开打包发布。本文件与
REM skills/writing/bin/ensure-python.cmd 结构逐行对应（由它机械替换前缀生成），
REM 改一处记得对照另一处是否也该改（但不要合并成共享文件）。
REM
REM 与 ensure-python.sh 对应的 Windows 版。CMD 没有 `source` 语义，没法把
REM 变量回灌父进程，所以这里改成「把就绪解释器路径写到 stdout 最后一行」，
REM 约定调用方读取那一行作为 TENDER_PY。SKILL.md 顶部对 Windows 的说明照此。
REM
REM 为什么这个技能需要它：上游的 §-1 check_env.py 是「检测缺什么、然后告诉用户
REM 自己去敲 pip install」——命令行里这是对的设计，桌面产品里不是。本脚本把那一步
REM 变成用户零操作。
REM
REM venv 落在 %USERPROFILE%\.tender-review-skill\venv（用户可写，打包后的 skill
REM 目录只读，venv 不能建那）。base 解释器优先 app 自带 runtime
REM （TENDER_PYTHON_HOME，钉 3.12），否则回退系统 py -3.12 / python。
setlocal enabledelayedexpansion

if "%TENDER_VENV_DIR%"=="" set "TENDER_VENV_DIR=%USERPROFILE%\.tender-review-skill\venv"
set "SKILL_ROOT=%~dp0.."
set "REQ=%SKILL_ROOT%\requirements.txt"
set "VENV_PY=%TENDER_VENV_DIR%\Scripts\python.exe"

REM 1. 已就绪 -> 直接输出
if exist "%VENV_PY%" if exist "%TENDER_VENV_DIR%\.deps-ok" (
  echo [tender] Python 就绪：%VENV_PY%
  echo TENDER_PY=%VENV_PY%
  exit /b 0
)

REM 2. 选 base 解释器
set "BASE="
if not "%TENDER_PYTHON_HOME%"=="" (
  if exist "%TENDER_PYTHON_HOME%\python.exe" set "BASE=%TENDER_PYTHON_HOME%\python.exe"
)
if "%BASE%"=="" (
  where py >nul 2>&1 && set "BASE=py -3.12"
)
if "%BASE%"=="" (
  where python >nul 2>&1 && set "BASE=python"
)
if "%BASE%"=="" (
  echo [tender] 错误：没有可用的 Python 解释器。请安装 Python 3.12 或确保 app 自带 runtime 完整。
  exit /b 1
)

REM py3.14+ 命中时告警：PyMuPDF/Pillow/numpy 可能无 cp314 wheel，pip 退化源码
REM 编译会极慢甚至失败（与 ensure-python.sh 第 63-70 行逐行对应）。app 自带
REM runtime 钉 3.12 不会命中。%BASE% 不加引号，与下面建 venv 处一致（BASE 可能
REM 是 "py -3.12"）；用 chr(46) 拼小数点，避开 for /f 单引号命令里嵌单引号的坑。
set "PYVER="
for /f "delims=" %%v in ('%BASE% -c "import sys;print(str(sys.version_info[0])+chr(46)+str(sys.version_info[1]))" 2^>nul') do set "PYVER=%%v"
set "PY_TOO_NEW="
if "%PYVER%"=="3.14" set "PY_TOO_NEW=1"
if "%PYVER%"=="3.15" set "PY_TOO_NEW=1"
if "%PYVER%"=="3.16" set "PY_TOO_NEW=1"
if "%PYVER%"=="3.17" set "PY_TOO_NEW=1"
if "%PYVER%"=="3.18" set "PY_TOO_NEW=1"
if "%PYVER%"=="3.19" set "PY_TOO_NEW=1"
if defined PY_TOO_NEW echo [tender] 警告：base 解释器是 Python %PYVER%，部分依赖可能无预编译 wheel，pip 会退化源码编译（慢/可能失败）。建议改用 Python 3.12。

REM 3. 建 venv + pip install
if not exist "%VENV_PY%" (
  echo [tender] 用 %BASE% 建 venv -^> %TENDER_VENV_DIR%
  %BASE% -m venv "%TENDER_VENV_DIR%"
  if errorlevel 1 (
    echo [tender] 错误：创建 venv 失败。
    exit /b 1
  )
)

echo [tender] 安装依赖（首次约几分钟，之后秒过）…
"%VENV_PY%" -m pip install --upgrade pip >nul 2>&1

REM 依次尝试清华 -> 阿里 -> 官方 PyPI；单源卡住/中断（国内直连官方源常见）
REM 就换下一个，而不是无限等。
set "TENDER_DEPS_OK="

echo [tender] 尝试镜像源：https://pypi.tuna.tsinghua.edu.cn/simple
"%VENV_PY%" -m pip install -r "%REQ%" -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn --timeout 30
if not errorlevel 1 set "TENDER_DEPS_OK=1"

if not defined TENDER_DEPS_OK (
  echo [tender] 该源失败/超时，换下一个…
  echo [tender] 尝试镜像源：https://mirrors.aliyun.com/pypi/simple
  "%VENV_PY%" -m pip install -r "%REQ%" -i https://mirrors.aliyun.com/pypi/simple --trusted-host mirrors.aliyun.com --timeout 30
  if not errorlevel 1 set "TENDER_DEPS_OK=1"
)

if not defined TENDER_DEPS_OK (
  echo [tender] 该源失败/超时，换下一个…
  echo [tender] 尝试官方源：pypi.org
  "%VENV_PY%" -m pip install -r "%REQ%" --timeout 30
  if not errorlevel 1 set "TENDER_DEPS_OK=1"
)

if not defined TENDER_DEPS_OK (
  echo [tender] 错误：清华/阿里/官方三个源均安装失败。检查网络后重跑本脚本。
  exit /b 1
)
break > "%TENDER_VENV_DIR%\.deps-ok"
echo [tender] Python 就绪：%VENV_PY%
echo TENDER_PY=%VENV_PY%
exit /b 0
