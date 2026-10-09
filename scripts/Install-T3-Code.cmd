@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\build-install-custom.ps1" %*
set "buildExitCode=%errorlevel%"
pause
exit /b %buildExitCode%
