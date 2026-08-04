@echo off
REM writing skill Python bootstrap - Windows.
REM
REM Deliberately maintained in parallel with ppt-creator instead of factoring
REM out a shared file: a skill must be self-contained -- a user may install
REM writing without ppt-creator, and the two can be packaged and published
REM separately. This file corresponds line by line to
REM skills-src/ppt-creator/bin/ensure-python.cmd; when you change one, check
REM whether the other needs the same change (but do NOT merge them).
REM
REM Windows counterpart of ensure-python.sh. CMD has no `source` semantics and
REM cannot export variables back to the caller, so this script instead writes
REM the ready interpreter path as the LAST stdout line; callers read that line
REM as WRITING_PY. The Windows note at the top of SKILL.md follows this contract.
REM
REM The venv lives in %USERPROFILE%\.writing-skill\venv (user-writable; the
REM packaged skill dir is read-only so the venv must not go there). Base
REM interpreter: the app's bundled runtime first (WRITING_PYTHON_HOME, pinned to
REM 3.12), else system py -3.12 / python.
REM
REM ############################################################################
REM # THIS FILE MUST STAY CRLF-TERMINATED AND PURE ASCII. DO NOT ADD NON-ASCII #
REM # CHARACTERS (2026-08-04 incident).                                        #
REM #                                                                          #
REM # cmd.exe parses batch files by byte offset, re-seeking as it goes. With    #
REM # LF-only endings that re-seek lands mid-line, so multi-line ( ... ) blocks #
REM # and for /f loops silently misexecute: `set` lines appear to never run and #
REM # the final `echo WRITING_PY=%VENV_PY%` expands to an empty string.        #
REM #                                                                          #
REM # Non-ASCII is just as fatal: on a GBK code page a UTF-8 character is read  #
REM # as byte pairs, and the leftover trailing byte swallows the ASCII byte     #
REM # that follows it -- an escaped `^>` loses its caret and turns into a real  #
REM # redirection. `chcp 65001` does NOT fix this: it changes the console code  #
REM # page, not how cmd.exe decodes this file, and it leaks into the caller's   #
REM # session. Enforced by .gitattributes (eol=crlf) plus a repo test.          #
REM ############################################################################
setlocal enabledelayedexpansion

if "%WRITING_VENV_DIR%"=="" set "WRITING_VENV_DIR=%USERPROFILE%\.writing-skill\venv"
set "SKILL_ROOT=%~dp0.."
set "REQ=%SKILL_ROOT%\requirements.txt"
set "VENV_PY=%WRITING_VENV_DIR%\Scripts\python.exe"

REM 1. Already provisioned -> report and exit.
if exist "%VENV_PY%" if exist "%WRITING_VENV_DIR%\.deps-ok" (
  echo [writing] Python ready: %VENV_PY%
  echo WRITING_PY=%VENV_PY%
  exit /b 0
)

REM 2. Pick the base interpreter.
set "BASE="
if not "%WRITING_PYTHON_HOME%"=="" (
  if exist "%WRITING_PYTHON_HOME%\python.exe" set "BASE=%WRITING_PYTHON_HOME%\python.exe"
)
if "%BASE%"=="" (
  where py >nul 2>&1 && set "BASE=py -3.12"
)
if "%BASE%"=="" (
  where python >nul 2>&1 && set "BASE=python"
)
if "%BASE%"=="" (
  echo [writing] ERROR: no usable Python interpreter found. Install Python 3.12 or make sure the app's bundled runtime is intact.
  exit /b 1
)

REM Warn when the base interpreter is 3.14+: PyMuPDF/Pillow/numpy may have no
REM cp31x wheel, so pip falls back to building from source (very slow, often
REM fails). Mirrors lines 63-70 of ensure-python.sh. The app's bundled runtime
REM is pinned to 3.12 and never trips this. %BASE% is intentionally unquoted
REM (it may be "py -3.12"), same as the venv creation below; chr(46) builds the
REM dot to avoid nesting single quotes inside the for /f command string.
set "PYVER="
for /f "delims=" %%v in ('%BASE% -c "import sys;print(str(sys.version_info[0])+chr(46)+str(sys.version_info[1]))" 2^>nul') do set "PYVER=%%v"
set "PY_TOO_NEW="
if "%PYVER%"=="3.14" set "PY_TOO_NEW=1"
if "%PYVER%"=="3.15" set "PY_TOO_NEW=1"
if "%PYVER%"=="3.16" set "PY_TOO_NEW=1"
if "%PYVER%"=="3.17" set "PY_TOO_NEW=1"
if "%PYVER%"=="3.18" set "PY_TOO_NEW=1"
if "%PYVER%"=="3.19" set "PY_TOO_NEW=1"
if defined PY_TOO_NEW echo [writing] WARNING: base interpreter is Python %PYVER%; some dependencies may have no prebuilt wheel and pip will fall back to building from source (slow, may fail). Python 3.12 is recommended.

REM 3. Create the venv (if missing), then install dependencies.
if not exist "%VENV_PY%" (
  echo [writing] Creating venv with %BASE% in %WRITING_VENV_DIR%
  %BASE% -m venv "%WRITING_VENV_DIR%"
  if errorlevel 1 (
    echo [writing] ERROR: failed to create the venv.
    exit /b 1
  )
)

echo [writing] Installing dependencies (a few minutes on first run, instant afterwards)...
"%VENV_PY%" -m pip install --upgrade pip >nul 2>&1

REM Try Tsinghua -> Aliyun -> official PyPI in order. A single index that stalls
REM or drops the connection (common for direct pypi.org access from mainland
REM China) falls through to the next one instead of hanging forever.
set "WRITING_DEPS_OK="

echo [writing] Trying mirror: https://pypi.tuna.tsinghua.edu.cn/simple
"%VENV_PY%" -m pip install -r "%REQ%" -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn --timeout 30
if not errorlevel 1 set "WRITING_DEPS_OK=1"

if not defined WRITING_DEPS_OK (
  echo [writing] That index failed or timed out, trying the next one...
  echo [writing] Trying mirror: https://mirrors.aliyun.com/pypi/simple
  "%VENV_PY%" -m pip install -r "%REQ%" -i https://mirrors.aliyun.com/pypi/simple --trusted-host mirrors.aliyun.com --timeout 30
  if not errorlevel 1 set "WRITING_DEPS_OK=1"
)

if not defined WRITING_DEPS_OK (
  echo [writing] That index failed or timed out, trying the next one...
  echo [writing] Trying the official index: pypi.org
  "%VENV_PY%" -m pip install -r "%REQ%" --timeout 30
  if not errorlevel 1 set "WRITING_DEPS_OK=1"
)

if not defined WRITING_DEPS_OK (
  echo [writing] ERROR: all three indexes (Tsinghua/Aliyun/official) failed. Check your network and re-run this script.
  exit /b 1
)
break > "%WRITING_VENV_DIR%\.deps-ok"
echo [writing] Python ready: %VENV_PY%
echo WRITING_PY=%VENV_PY%
exit /b 0
