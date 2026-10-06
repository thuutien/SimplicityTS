@echo off
rem Double-click to update SimplicityTS to the latest version from GitHub.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1" %*
