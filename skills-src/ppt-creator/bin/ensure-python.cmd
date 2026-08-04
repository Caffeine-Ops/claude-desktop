@echo off
REM ppt-creator Python bootstrap - Windows.
REM
REM Windows counterpart of ensure-python.sh. CMD has no `source` semantics and
REM cannot export variables back to the caller, so this script instead writes
REM the ready interpreter path as the LAST stdout line; callers read that line
REM as PPT_PY. The Windows note at the top of SKILL.md follows this contract.
REM
REM The venv lives in %USERPROFILE%\.ppt-master\venv (user-writable, matching
REM config.py's USER_CONFIG_DIR; the packaged skill dir is read-only so the venv
REM must not go there). Base interpreter: the app's bundled runtime first
REM (PPT_MASTER_PYTHON_HOME, pinned to 3.12), else system py -3.12 / python.
REM
REM ############################################################################
REM # THIS FILE MUST STAY CRLF-TERMINATED AND PURE ASCII. DO NOT ADD NON-ASCII #
REM # CHARACTERS (2026-08-04 incident).                                        #
REM #                                                                          #
REM # cmd.exe parses batch files by byte offset, re-seeking as it goes. With    #
REM # LF-only endings that re-seek lands mid-line, so multi-line ( ... ) blocks #
REM # and for /f loops silently misexecute: `set` lines appear to never run and #
REM # the final `echo PPT_PY=%VENV_PY%` expands to an empty string.            #
REM #                                                                          #
REM # Non-ASCII is just as fatal: on a GBK code page a UTF-8 character is read  #
REM # as byte pairs, and the leftover trailing byte swallows the ASCII byte     #
REM # that follows it -- an escaped `^>` loses its caret and turns into a real  #
REM # redirection. `chcp 65001` does NOT fix this: it changes the console code  #
REM # page, not how cmd.exe decodes this file, and it leaks into the caller's   #
REM # session. Enforced by .gitattributes (eol=crlf) plus a repo test.          #
REM ############################################################################
setlocal enabledelayedexpansion

if "%PPT_MASTER_VENV_DIR%"=="" set "PPT_MASTER_VENV_DIR=%USERPROFILE%\.ppt-master\venv"
set "SKILL_ROOT=%~dp0.."
set "REQ=%SKILL_ROOT%\requirements.txt"
set "VENV_PY=%PPT_MASTER_VENV_DIR%\Scripts\python.exe"

REM 1. Already provisioned -> report and exit.
if exist "%VENV_PY%" if exist "%PPT_MASTER_VENV_DIR%\.deps-ok" (
  echo [ppt-creator] Python ready: %VENV_PY%
  echo PPT_PY=%VENV_PY%
  exit /b 0
)

REM 2. Pick the base interpreter.
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
  echo [ppt-creator] ERROR: no usable Python interpreter found. Install Python 3.12 or make sure the app's bundled runtime is intact.
  exit /b 1
)

REM 3. Create the venv (if missing), then install dependencies.
if not exist "%VENV_PY%" (
  echo [ppt-creator] Creating venv with %BASE% in %PPT_MASTER_VENV_DIR%
  %BASE% -m venv "%PPT_MASTER_VENV_DIR%"
  if errorlevel 1 (
    echo [ppt-creator] ERROR: failed to create the venv.
    exit /b 1
  )
)

echo [ppt-creator] Installing dependencies (a few minutes on first run, instant afterwards)...
"%VENV_PY%" -m pip install --upgrade pip >nul 2>&1

REM Try Tsinghua -> Aliyun -> official PyPI in order. A single index that stalls
REM or drops the connection (common for direct pypi.org access from mainland
REM China) falls through to the next one instead of hanging forever.
set "PPT_DEPS_OK="

echo [ppt-creator] Trying mirror: https://pypi.tuna.tsinghua.edu.cn/simple
"%VENV_PY%" -m pip install -r "%REQ%" -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn --timeout 30
if not errorlevel 1 set "PPT_DEPS_OK=1"

if not defined PPT_DEPS_OK (
  echo [ppt-creator] That index failed or timed out, trying the next one...
  echo [ppt-creator] Trying mirror: https://mirrors.aliyun.com/pypi/simple
  "%VENV_PY%" -m pip install -r "%REQ%" -i https://mirrors.aliyun.com/pypi/simple --trusted-host mirrors.aliyun.com --timeout 30
  if not errorlevel 1 set "PPT_DEPS_OK=1"
)

if not defined PPT_DEPS_OK (
  echo [ppt-creator] That index failed or timed out, trying the next one...
  echo [ppt-creator] Trying the official index: pypi.org
  "%VENV_PY%" -m pip install -r "%REQ%" --timeout 30
  if not errorlevel 1 set "PPT_DEPS_OK=1"
)

if not defined PPT_DEPS_OK (
  echo [ppt-creator] ERROR: all three indexes (Tsinghua/Aliyun/official) failed. Check your network and re-run this script.
  exit /b 1
)
break > "%PPT_MASTER_VENV_DIR%\.deps-ok"
echo [ppt-creator] Python ready: %VENV_PY%
echo PPT_PY=%VENV_PY%
exit /b 0
