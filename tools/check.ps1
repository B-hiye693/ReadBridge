$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$env:PYTHONPATH = Join-Path $root 'apps\api'
& .\.venv\Scripts\python.exe -m compileall -q apps/api/server
if ($LASTEXITCODE) { throw 'Python syntax check failed.' }
$manifest = Get-Content apps/browser-extension/manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.manifest_version -ne 3) { throw 'Invalid extension manifest version.' }
$resources = @($manifest.background.service_worker, $manifest.action.default_popup) + @($manifest.content_scripts | ForEach-Object { $_.js })
foreach ($resource in $resources) { if (!(Test-Path (Join-Path apps/browser-extension $resource))) { throw "Missing extension resource: $resource" } }
Get-ChildItem apps/browser-extension -Filter *.js | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE) { throw 'JavaScript syntax check failed.' } }
& .\.venv\Scripts\python.exe -m unittest discover -s tests -q
if ($LASTEXITCODE) { throw 'Backend tests failed.' }
node tests/browser/test-speech-manager.mjs
if ($LASTEXITCODE) { throw 'System speech test failed.' }
node tests/browser/test-neural-speech-manager.mjs
if ($LASTEXITCODE) { throw 'Neural speech test failed.' }
$dotnet = Join-Path $root '.dotnet\dotnet.exe'
if (!(Test-Path $dotnet)) { $command = Get-Command dotnet -ErrorAction SilentlyContinue; if ($command) { $dotnet = $command.Source } else { $dotnet = $null } }
if ($dotnet) {
    $env:DOTNET_CLI_HOME = Join-Path $root '.dotnet-home'
    $env:APPDATA = Join-Path $root '.appdata'
    $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
    # 依赖已由安装/打包阶段还原；日常回归不应因 NuGet 网络波动而失败。
    & $dotnet build apps/windows-desktop/ReadBridge.Desktop/ReadBridge.Desktop.csproj -c Release --no-restore
    if ($LASTEXITCODE) { throw 'Desktop build failed.' }
    $desktopDll = Join-Path $root 'apps\windows-desktop\ReadBridge.Desktop\bin\Release\net10.0-windows10.0.19041.0\ReadBridge.dll'
    if (Test-Path $desktopDll) {
        $selfTestOutput = Join-Path ([IO.Path]::GetTempPath()) ('readbridge-library-' + [guid]::NewGuid() + '.txt')
        & $dotnet $desktopDll --library-test (Join-Path $root 'tests\fixtures\desktop-import-sample.txt') $selfTestOutput
        if ($LASTEXITCODE -or !(Test-Path $selfTestOutput)) { throw 'Desktop library self-test did not complete.' }
        $selfTestResult = Get-Content $selfTestOutput -Raw
        Remove-Item -LiteralPath $selfTestOutput -Force
        if ($selfTestResult -match 'ERROR:' -or $selfTestResult -match '=False') { throw "Desktop library self-test failed: $selfTestResult" }
    }
} else { Write-Warning '.NET SDK not found; desktop build check skipped.' }
Write-Host 'All checks passed.'
