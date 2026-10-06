# Updates SimplicityTS to the latest version from GitHub.
#
#   1. Checks GitHub for a newer version
#   2. Backs up the database
#   3. Stops the service, downloads the new code, installs packages, starts the service
#   4. Checks the app responds; if not, goes back to the previous version automatically
#
# Run it by double-clicking update.bat in the app folder, or from PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\update.ps1
param(
    [string]$ServiceName = 'SimplicityTS',
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service -and -not (Test-IsAdmin)) {
    $passArgs = "-ServiceName `"$ServiceName`""
    if ($NoPause) { $passArgs += ' -NoPause' }
    Restart-AsAdmin $PSCommandPath $passArgs
}

Write-Host "SimplicityTS update" -ForegroundColor White
Write-Host "App folder: $AppDir"

try {
    # ----- 1. Check for a new version -----
    Write-Step "Checking for updates"
    foreach ($tool in 'git', 'node', 'npm') {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not installed or not on PATH." }
    }

    Invoke-Git fetch --quiet origin
    if ($LASTEXITCODE -ne 0) { throw 'Could not reach GitHub (git fetch failed). Check the internet connection.' }

    $current = (Invoke-Git rev-parse HEAD).Trim()
    $latest = (Invoke-Git rev-parse '@{u}').Trim()
    if ($current -eq $latest) {
        Write-Ok "Already up to date (version $($current.Substring(0, 7)))."
        Wait-ForEnter
        exit 0
    }

    Write-Ok "New version available: $($current.Substring(0, 7)) -> $($latest.Substring(0, 7))"
    Write-Host ""
    Write-Host "    Changes:"
    Invoke-Git log --oneline --no-decorate "$current..$latest" | ForEach-Object { Write-Host "      $_" }

    # Refuse to update if someone edited the code on the server; it would be overwritten.
    $localChanges = Invoke-Git status --porcelain --untracked-files=no
    if ($localChanges) {
        Write-Err 'These files were changed on this server:'
        $localChanges | ForEach-Object { Write-Err "  $_" }
        throw 'Update stopped so these changes are not lost. Undo them (git checkout -- .) or commit them first.'
    }

    # ----- 2. Back up the database -----
    Write-Step 'Backing up the database'
    if (Test-Path (Join-Path $AppDir 'tickets.db')) {
        & node (Join-Path $PSScriptRoot 'backup-db.js') 'before-update'
        if ($LASTEXITCODE -ne 0) { throw 'Backup failed, so the update was not started.' }
    } else {
        Write-Warn 'No database yet, nothing to back up.'
    }

    # ----- 3. Stop, update, start -----
    if ($service) {
        Write-Step "Stopping service $ServiceName"
        Stop-Service -Name $ServiceName
        Write-Ok 'Stopped.'
    } else {
        Write-Warn "Service '$ServiceName' is not installed; only the files will be updated."
    }

    $updateOk = $true
    try {
        Write-Step 'Downloading the new version'
        Invoke-Git merge --ff-only --quiet $latest
        if ($LASTEXITCODE -ne 0) { throw 'git merge failed.' }
        Write-Ok "Now on version $($latest.Substring(0, 7))."

        Write-Step 'Installing packages'
        Push-Location $AppDir
        try {
            & npm ci --omit=dev --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
        } finally {
            Pop-Location
        }
    } catch {
        Write-Err $_.Exception.Message
        $updateOk = $false
    }

    $port = [int](Get-EnvValue 'PORT' '5000')
    if ($updateOk -and $service) {
        Write-Step "Starting service $ServiceName"
        Start-Service -Name $ServiceName
        if (Test-AppResponds $port) {
            Write-Ok "The app is running at http://localhost:$port"
        } else {
            Write-Err "The app did not respond on port $port after the update."
            $updateOk = $false
        }
    }

    # ----- 4. Roll back if something went wrong -----
    if (-not $updateOk) {
        Write-Step "Going back to the previous version ($($current.Substring(0, 7)))"
        if ($service) { Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue }
        Invoke-Git reset --hard --quiet $current
        Push-Location $AppDir
        try { & npm ci --omit=dev --no-audit --no-fund } finally { Pop-Location }
        if ($service) {
            Start-Service -Name $ServiceName
            if (Test-AppResponds $port) { Write-Ok 'Previous version is running again.' }
            else { Write-Err 'The previous version did not start either. Check the log in the logs folder.' }
        }
        $logFile = Join-Path $AppDir 'logs\service.log'
        if (Test-Path $logFile) {
            Write-Host ""
            Write-Host '    Last lines of logs\service.log:'
            Get-Content $logFile -Tail 20 | ForEach-Object { Write-Host "      $_" }
        }
        throw 'The update failed and was rolled back. The database backup is in the backups folder.'
    }

    Write-Host ""
    Write-Host "Update complete." -ForegroundColor Green
} catch {
    Write-Host ""
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Wait-ForEnter
    exit 1
}

Wait-ForEnter
