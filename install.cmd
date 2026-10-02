@echo off
rem ---------------------------------------------------------------------------
rem dsh-plugin-power-button — local install helper (Windows).
rem
rem   install.cmd            install into the "desktop" profile
rem   install.cmd web        install into the "web" profile (button stays hidden)
rem   install.cmd desktop C:\path\to\checkout
rem
rem It syntax-checks the three shipped JavaScript files, runs the self-test, then
rem links this checkout into the chosen profile (dsh plugin add <path>) and prints
rem how to roll it back. Restart DSH afterwards; the power button only appears once
rem the profile has reloaded and the page has been refreshed.
rem ---------------------------------------------------------------------------
setlocal

set "PROFILE=%~1"
if "%PROFILE%"=="" set "PROFILE=desktop"

set "PLUGIN_DIR=%~2"
if "%PLUGIN_DIR%"=="" set "PLUGIN_DIR=%~dp0"
rem strip a trailing backslash so the path is spelled the same way in both uses
if "%PLUGIN_DIR:~-1%"=="\" set "PLUGIN_DIR=%PLUGIN_DIR:~0,-1%"

echo [1/3] checking syntax ^(node --check^)
node --check "%PLUGIN_DIR%\src\index.js" || goto :fail
node --check "%PLUGIN_DIR%\src\power.js" || goto :fail
node --check "%PLUGIN_DIR%\src\helper.mjs" || goto :fail
node --check "%PLUGIN_DIR%\lib\client.js" || goto :fail

echo [2/3] running the self-test ^(never touches a real process^)
node "%PLUGIN_DIR%\verify\verify.mjs" || goto :fail

echo [3/3] installing into profile "%PROFILE%"
dsh plugin --profile %PROFILE% add "%PLUGIN_DIR%" || goto :fail

echo.
echo Installed. Next steps:
echo   1. restart DSH ^(the host half registers its route at startup^);
echo   2. hard-refresh the browser ^(Ctrl+Shift+R^) so the client bundle reloads;
echo   3. look to the right of the sidebar account button and click the power glyph.
echo.
echo To roll back:
echo   dsh plugin --profile %PROFILE% remove dsh-plugin-power-button
echo.
exit /b 0

:fail
echo.
echo Install failed. If the "dsh" command is missing, run the install step yourself
echo with the CLI that ships inside your DSH installation directory:
echo   ^<DSH^>\resources\runtime\cli\bin\dsh.cmd plugin --profile %PROFILE% add "%PLUGIN_DIR%"
echo and make sure Node.js is available for the syntax check and the self-test.
exit /b 1
