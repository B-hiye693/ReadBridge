$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$dotnet = Join-Path $root '.dotnet\dotnet.exe'
if (!(Test-Path $dotnet)) { $dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue).Source }
if (!$dotnet) { throw '.NET 10 SDK not found. Install it or place dotnet.exe under .dotnet.' }
$env:DOTNET_CLI_HOME = Join-Path $root '.dotnet-home'
$env:APPDATA = Join-Path $root '.appdata'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$output = Join-Path $root 'artifacts\ReadBridge-Desktop-win-x64-v18'
& $dotnet publish (Join-Path $PSScriptRoot 'ReadBridge.Desktop\ReadBridge.Desktop.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -o $output
if ($LASTEXITCODE) { throw 'Desktop publish failed.' }
Write-Host "Created: $output\ReadBridge.exe"
