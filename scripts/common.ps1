# Shared helpers for the SimplicityTS PowerShell scripts. Dot-source this file: . "$PSScriptRoot\common.ps1"

$AppDir = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }
function Write-Err([string]$Message) { Write-Host "    $Message" -ForegroundColor Red }

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Re-runs the calling script as Administrator (shows the Windows UAC prompt).
function Restart-AsAdmin([string]$ScriptPath, [string]$Arguments) {
    Write-Host "Administrator rights are needed. Windows will ask for permission..." -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" $Arguments"
    exit
}

# Reads a value from the app's .env file, or returns the default.
function Get-EnvValue([string]$Name, [string]$Default) {
    $envFile = Join-Path $AppDir '.env'
    if (Test-Path $envFile) {
        foreach ($line in Get-Content $envFile) {
            if ($line -match "^\s*$Name\s*=\s*(.*?)\s*$") {
                $value = $Matches[1].Trim('"').Trim("'")
                if ($value -ne '') { return $value }
            }
        }
    }
    return $Default
}

# Runs git in the app folder. safe.directory avoids "dubious ownership" errors when
# the folder was cloned by a different Windows user than the one running the script.
function Invoke-Git {
    $safeDir = $AppDir -replace '\\', '/'
    & git -c "safe.directory=$safeDir" -C $AppDir @args
}

# Checks that the app answers on its port. Returns $true/$false.
function Test-AppResponds([int]$Port, [int]$Seconds = 20) {
    for ($i = 0; $i -lt $Seconds; $i++) {
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return $true }
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    return $false
}

function Wait-ForEnter {
    if (-not $NoPause) {
        Write-Host ""
        Read-Host "Press Enter to close"
    }
}
