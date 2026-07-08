@echo off
REM spreadsheets skill Python bootstrap - Windows.
REM
REM 与 ensure-python.sh 对应的 Windows 版。CMD 没有 `source` 语义，没法把
REM 变量回灌父进程，所以这里改成「把就绪解释器路径写到 stdout 最后一行」，
REM 约定调用方读取那一行作为 SHEETS_PY。SKILL.md 顶部对 Windows 的说明照此。
REM
REM venv 落在 %USERPROFILE%\.spreadsheets-skill\venv（用户可写；打包后的 skill
REM 目录只读，venv 不能建那）。base 解释器优先 app 自带 runtime
REM （PPT_MASTER_PYTHON_HOME，名字带 ppt-master 是历史原因——engine 只注入这
REM 一个 python home 变量，所有 Python skill 共用，钉 3.12），否则回退系统
REM py -3.12 / python。
setlocal enabledelayedexpansion

if "%SHEETS_VENV_DIR%"=="" set "SHEETS_VENV_DIR=%USERPROFILE%\.spreadsheets-skill\venv"
set "SKILL_ROOT=%~dp0.."
set "REQ=%SKILL_ROOT%\requirements.txt"
set "VENV_PY=%SHEETS_VENV_DIR%\Scripts\python.exe"

REM 1. 已就绪 -> 直接输出
if exist "%VENV_PY%" if exist "%SHEETS_VENV_DIR%\.deps-ok" (
  echo [spreadsheets] Python 就绪：%VENV_PY%
  echo SHEETS_PY=%VENV_PY%
  exit /b 0
)

REM 2. 选 base 解释器
set "BASE="
if not "%PPT_MASTER_PYTHON_HOME%"=="" (
  if exist "%PPT_MASTER_PYTHON_HOME%\python.exe" set "BASE=%PPT_MASTER_PYTHON_HOME%\python.exe"
)
if "%BASE%"=="" (
  where py >nul 2>&1 && set "BASE=py -3.12"
)
if "%BASE%"=="" (
  where python >nul 2>&1 && set "BASE=python"
)
if "%BASE%"=="" (
  echo [spreadsheets] 错误：没有可用的 Python 解释器。请安装 Python 3.12 或确保 app 自带 runtime 完整。
  exit /b 1
)

REM 3. 建 venv + pip install
if not exist "%VENV_PY%" (
  echo [spreadsheets] 用 %BASE% 建 venv -^> %SHEETS_VENV_DIR%
  %BASE% -m venv "%SHEETS_VENV_DIR%"
  if errorlevel 1 (
    echo [spreadsheets] 错误：创建 venv 失败。
    exit /b 1
  )
)

echo [spreadsheets] 安装依赖（首次不到一分钟，之后秒过）…
"%VENV_PY%" -m pip install --upgrade pip >nul 2>&1
"%VENV_PY%" -m pip install -r "%REQ%"
if errorlevel 1 (
  echo [spreadsheets] 错误：pip install 失败。检查网络后重跑本脚本。
  exit /b 1
)
break > "%SHEETS_VENV_DIR%\.deps-ok"
echo [spreadsheets] Python 就绪：%VENV_PY%
echo SHEETS_PY=%VENV_PY%
exit /b 0
