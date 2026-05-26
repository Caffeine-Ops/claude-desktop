@echo off
REM ppt-master Python bootstrap - Windows.
REM
REM 与 ensure-python.sh 对应的 Windows 版。CMD 没有 `source` 语义，没法把
REM 变量回灌父进程，所以这里改成「把就绪解释器路径写到 stdout 最后一行」，
REM 约定调用方读取那一行作为 PPT_PY。SKILL.md 顶部对 Windows 的说明照此。
REM
REM venv 落在 %USERPROFILE%\.ppt-master\venv（用户可写，与 config.py 的
REM USER_CONFIG_DIR 一致；打包后的 skill 目录只读，venv 不能建那）。base
REM 解释器优先 app 自带 runtime（PPT_MASTER_PYTHON_HOME，钉 3.12），否则回退
REM 系统 py -3.12 / python。
setlocal enabledelayedexpansion

if "%PPT_MASTER_VENV_DIR%"=="" set "PPT_MASTER_VENV_DIR=%USERPROFILE%\.ppt-master\venv"
set "SKILL_ROOT=%~dp0.."
set "REQ=%SKILL_ROOT%\requirements.txt"
set "VENV_PY=%PPT_MASTER_VENV_DIR%\Scripts\python.exe"

REM 1. 已就绪 -> 直接输出
if exist "%VENV_PY%" if exist "%PPT_MASTER_VENV_DIR%\.deps-ok" (
  echo [ppt-master] Python 就绪：%VENV_PY%
  echo PPT_PY=%VENV_PY%
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
  echo [ppt-master] 错误：没有可用的 Python 解释器。请安装 Python 3.12 或确保 app 自带 runtime 完整。
  exit /b 1
)

REM 3. 建 venv + pip install
if not exist "%VENV_PY%" (
  echo [ppt-master] 用 %BASE% 建 venv -^> %PPT_MASTER_VENV_DIR%
  %BASE% -m venv "%PPT_MASTER_VENV_DIR%"
  if errorlevel 1 (
    echo [ppt-master] 错误：创建 venv 失败。
    exit /b 1
  )
)

echo [ppt-master] 安装依赖（首次约几分钟，之后秒过）…
"%VENV_PY%" -m pip install --upgrade pip >nul 2>&1
"%VENV_PY%" -m pip install -r "%REQ%"
if errorlevel 1 (
  echo [ppt-master] 错误：pip install 失败。检查网络后重跑本脚本。
  exit /b 1
)
break > "%PPT_MASTER_VENV_DIR%\.deps-ok"
echo [ppt-master] Python 就绪：%VENV_PY%
echo PPT_PY=%VENV_PY%
exit /b 0
