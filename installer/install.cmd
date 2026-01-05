@echo off
rem install.cmd — add ../cli to PATH (current session + persist to user environment)

rem Resolve absolute path to ../cli relative to this script
pushd "%~dp0..\cli" >nul 2>&1 || (
    echo Error: ../cli not found relative to "%~dp0"
    exit /b 1
)
set "CLI_DIR=%CD%"
popd

rem Run npm install in project root (one level up from this script)
pushd "%~dp0.." >nul 2>&1 || (
    echo Error: project root not found relative to "%~dp0"
    exit /b 1
)
echo Running npm install in "%CD%"...
npm install >nul 2>&1
if %errorlevel%==0 (
    echo npm install succeeded.
) else (
    echo npm install failed. You may need to run "npm install" manually in "%CD%".
)
popd

rem If already in PATH, exit
echo %PATH% | find /I "%CLI_DIR%" >nul
if %errorlevel%==0 (
    echo "%CLI_DIR%" is already in PATH.
    exit /b 0
)

rem Add to current session
set "PATH=%PATH%;%CLI_DIR%"

rem Persist to current user's environment (requires no admin for user PATH)
setx PATH "%PATH%" >nul 2>&1
if %errorlevel%==0 (
    echo Added "%CLI_DIR%" to PATH (current session and user environment).
) else (
    echo Added to current session, but failed to persist to user environment.
)

rem Optionally set OPENAI_API_KEY permanently
if /I "%~1"=="-y" (
    echo Skipping OPENAI_API_KEY prompt (-y provided).
    goto :end_api_prompt
)

echo.
set /p "OPENAI_API_KEY_INPUT=Enter OPENAI_API_KEY (leave blank or type -y to skip): "
if "%OPENAI_API_KEY_INPUT%"=="" (
    echo Skipping OPENAI_API_KEY configuration.
    goto :end_api_prompt
)
if /I "%OPENAI_API_KEY_INPUT%"=="-y" (
    echo Skipping OPENAI_API_KEY configuration.
    goto :end_api_prompt
)

rem Persist to user environment and set for current session
setx OPENAI_API_KEY "%OPENAI_API_KEY_INPUT%" >nul 2>&1
if %errorlevel%==0 (
    set "OPENAI_API_KEY=%OPENAI_API_KEY_INPUT%"
    echo OPENAI_API_KEY saved to user environment. Open a new terminal to use it everywhere.
)
goto :end_api_prompt

:end_api_prompt