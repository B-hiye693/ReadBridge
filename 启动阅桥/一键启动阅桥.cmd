@echo off
set "READBRIDGE_ROOT=%~dp0.."
start "ReadBridge Backend" cmd.exe /c call "%READBRIDGE_ROOT%\tools\start.cmd"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%READBRIDGE_ROOT%\tools\wait-for-backend.ps1" -TimeoutSeconds 25
start "" "%READBRIDGE_ROOT%\artifacts\ReadBridge-Desktop-win-x64-v18\ReadBridge.exe"
