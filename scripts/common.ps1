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

# Finds nssm.exe (on PATH or in the app's tools folder). Returns $null if not found.
function Find-Nssm {
    $nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
    if (-not $nssm -and (Test-Path (Join-Path $AppDir 'tools\nssm.exe'))) { $nssm = Join-Path $AppDir 'tools\nssm.exe' }
    return $nssm
}

function Get-ServiceState([string]$Name) {
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($svc) { return $svc.Status.ToString() }
    return 'Missing'
}

# Waits until the service reports Stopped. Returns $true/$false.
function Wait-ServiceStopped([string]$Name, [int]$Seconds) {
    for ($i = 0; $i -lt $Seconds; $i++) {
        if ((Get-ServiceState $Name) -eq 'Stopped') { return $true }
        Start-Sleep -Seconds 1
    }
    return ((Get-ServiceState $Name) -eq 'Stopped')
}

# Stops the service even when Windows refuses (e.g. NSSM has it "Paused" because the app kept crashing):
#   1. Stop-Service   2. nssm stop   3. end the service's processes (NSSM and the node.exe it started)
function Stop-AppService([string]$Name) {
    if ((Get-ServiceState $Name) -eq 'Stopped') { return }

    try {
        Stop-Service -Name $Name -ErrorAction Stop
        if (Wait-ServiceStopped $Name 20) { return }
    } catch {
        Write-Warn "Windows could not stop the service ($((Get-ServiceState $Name))): $($_.Exception.Message)"
    }

    $nssm = Find-Nssm
    if ($nssm) {
        Write-Warn 'Asking NSSM to stop it...'
        & $nssm stop $Name | Out-Null
        if (Wait-ServiceStopped $Name 20) { return }
    }

    Write-Warn 'Still running: ending the service processes...'
    $svc = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
    if ($svc -and $svc.ProcessId -gt 0) {
        # node.exe (and anything else) started by NSSM first, then NSSM itself
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$($svc.ProcessId)" -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Stop-Process -Id $svc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if (-not (Wait-ServiceStopped $Name 15)) {
        throw "Could not stop the $Name service (status: $(Get-ServiceState $Name)). Restart the server, then run the update again."
    }
}

function Start-AppService([string]$Name) {
    try {
        Start-Service -Name $Name -ErrorAction Stop
    } catch {
        $nssm = Find-Nssm
        if (-not $nssm) { throw }
        Write-Warn "Start-Service failed ($($_.Exception.Message)); asking NSSM to start it..."
        & $nssm start $Name | Out-Null
    }
}

# Prints the service status and the end of the app log, to help explain a failed start.
function Show-ServiceDiagnostics([string]$Name) {
    Write-Host ""
    Write-Host "    Service status: $(Get-ServiceState $Name)"
    $logFile = Join-Path $AppDir 'logs\service.log'
    if (Test-Path $logFile) {
        Write-Host '    Last lines of logs\service.log:'
        Get-Content $logFile -Tail 20 | ForEach-Object { Write-Host "      $_" }
    }
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
