param([int]$TimeoutSeconds = 25)
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 2
        if ($health.status -eq 'ok' -and $health.name -eq 'ReadBridge') {
            Write-Host 'ReadBridge backend is ready.' -ForegroundColor Green
            exit 0
        }
    } catch { }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
Write-Warning 'Backend is not ready yet. The desktop client will still open; offline capture and file reading remain available.'
exit 1
