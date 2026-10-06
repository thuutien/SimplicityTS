# One-time setup on the Windows server:
#   - installs packages (npm ci)
#   - registers SimplicityTS as a Windows service (starts automatically, restarts if it crashes)
#   - opens the app's port in Windows Firewall
#   - schedules a daily database backup at 2:00 AM
#
# Needs NSSM (https://nssm.cc): install it with "winget install NSSM.NSSM", or put nssm.exe in the tools folder.
# Run it by double-clicking install-service.bat in the app folder, or from PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
param(
    [string]$ServiceName = 'SimplicityTS',
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"

if (-not (Test-IsAdmin)) {
    $passArgs = "-ServiceName `"$ServiceName`""
    if ($NoPause) { $passArgs += ' -NoPause' }
    Restart-AsAdmin $PSCommandPath $passArgs
}

Write-Host "SimplicityTS service setup" -ForegroundColor White
Write-Host "App folder: $AppDir"

try {
    # ----- Check requirements -----
    Write-Step 'Checking requirements'
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw 'Node.js is not installed. Install Node.js 24 LTS from https://nodejs.org and run this again.' }
    $nodeVersion = (& $node --version).Trim()
    if ([version]($nodeVersion.TrimStart('v')) -lt [version]'22.13.0') { throw "Node.js $nodeVersion is too old. Install Node.js 24 LTS." }
    Write-Ok "Node.js $nodeVersion ($node)"

    $nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
    if (-not $nssm -and (Test-Path (Join-Path $AppDir 'tools\nssm.exe'))) { $nssm = Join-Path $AppDir 'tools\nssm.exe' }
    if (-not $nssm) { throw 'NSSM was not found. Install it with "winget install NSSM.NSSM" (then open a new window), or put nssm.exe in the tools folder.' }
    Write-Ok "NSSM ($nssm)"

    if (Test-Path (Join-Path $AppDir '.env')) {
        Write-Ok '.env found'
    } else {
        Write-Warn 'No .env file. The app will run, but email is off and links in emails will point to localhost.'
        Write-Warn 'Copy .env.example to .env, fill it in, then run: Restart-Service SimplicityTS'
    }
    $port = [int](Get-EnvValue 'PORT' '5000')

    # ----- Packages -----
    Write-Step 'Installing packages'
    Push-Location $AppDir
    try {
        & npm ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    } finally {
        Pop-Location
    }

    # ----- Service -----
    Write-Step "Registering Windows service '$ServiceName'"
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
        Write-Warn 'Service already exists; reinstalling it with the current settings.'
        Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
        & $nssm remove $ServiceName confirm | Out-Null
    }
    $logDir = Join-Path $AppDir 'logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $logFile = Join-Path $logDir 'service.log'

    & $nssm install $ServiceName $node (Join-Path $AppDir 'server.js') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'nssm install failed.' }
    $settings = @(
        @('AppDirectory', $AppDir),
        @('DisplayName', 'SimplicityTS Helpdesk'),
        @('Description', 'SimplicityTS ticket system (Node.js)'),
        @('Start', 'SERVICE_AUTO_START'),
        @('AppStdout', $logFile),
        @('AppStderr', $logFile),
        @('AppRotateFiles', '1'),
        @('AppRotateOnline', '1'),
        @('AppRotateBytes', '10485760'),
        @('AppRestartDelay', '5000')
    )
    foreach ($s in $settings) {
        & $nssm set $ServiceName $s[0] $s[1] | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "nssm set $($s[0]) failed." }
    }
    Write-Ok "Service installed (log file: logs\service.log)"

    # ----- Firewall -----
    Write-Step "Opening port $port in Windows Firewall"
    $ruleName = "SimplicityTS (TCP $port)"
    if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
        Write-Ok 'Firewall rule already exists.'
    } else {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Domain,Private | Out-Null
        Write-Ok "Allowed inbound TCP $port (domain and private networks)."
    }

    # ----- Daily backup -----
    Write-Step 'Scheduling daily database backup (2:00 AM)'
    $taskName = 'SimplicityTS Daily Backup'
    $action = New-ScheduledTaskAction -Execute $node -Argument "`"$(Join-Path $PSScriptRoot 'backup-db.js')`" daily" -WorkingDirectory $AppDir
    $trigger = New-ScheduledTaskTrigger -Daily -At 2am
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    Write-Ok "Task '$taskName' created. Backups go to the backups folder (newest 30 kept)."

    # ----- Start -----
    Write-Step 'Starting the service'
    Start-Service -Name $ServiceName
    if (Test-AppResponds $port) {
        Write-Ok "The app is running at http://localhost:$port"
    } else {
        Write-Err "The app did not respond on port $port. Last lines of logs\service.log:"
        if (Test-Path $logFile) { Get-Content $logFile -Tail 20 | ForEach-Object { Write-Host "      $_" } }
        throw 'The service was installed but the app did not start.'
    }

    Write-Host ""
    Write-Host "Setup complete." -ForegroundColor Green
    Write-Host "Other PCs can open: http://$($env:COMPUTERNAME):$port  (make sure APP_URL in .env matches the address people use)"
} catch {
    Write-Host ""
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Wait-ForEnter
    exit 1
}

Wait-ForEnter
