@echo off
rem Double-click once on the server to install SimplicityTS as a Windows service.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-service.ps1" %*
