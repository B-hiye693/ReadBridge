$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$python = Join-Path $root '.venv\Scripts\python.exe'
if (!(Test-Path $python)) { throw 'Python virtual environment not found. Install apps/api/requirements.txt first.' }

$requiredRevision = '2026.11.15.fast-retry-v5'
$staleReadBridge = $false
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 2
    if ($health.status -eq 'ok' -and $health.name -eq 'ReadBridge' -and $health.api_revision -eq $requiredRevision) {
        Write-Host 'ReadBridge backend is already running at http://127.0.0.1:8000.' -ForegroundColor Green
        Write-Host 'The existing backend will be reused; no second process was started.'
        exit 0
    }
    if ($health.status -eq 'ok' -and $health.name -eq 'ReadBridge') { $staleReadBridge = $true }
} catch { }

$listener = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener -and $staleReadBridge) {
    Write-Host "An older ReadBridge backend is running (PID $($listener.OwningProcess)); restarting it for the new language contract..." -ForegroundColor Yellow
    Stop-Process -Id $listener.OwningProcess -Force
    Start-Sleep -Milliseconds 800
    $listener = $null
}
if ($listener) {
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    $processName = if ($process) { $process.ProcessName } else { 'unknown process' }
    throw "Port 8000 is occupied by $processName (PID $($listener.OwningProcess)), and it is not a healthy ReadBridge backend. Close that process or change the port."
}

& $python -m uvicorn server.main:app --app-dir apps/api --host 127.0.0.1 --port 8000
