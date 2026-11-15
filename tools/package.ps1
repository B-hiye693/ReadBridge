$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$stage = Join-Path ([IO.Path]::GetTempPath()) ('readbridge-package-' + [guid]::NewGuid())
New-Item -ItemType Directory $stage | Out-Null
foreach ($directory in @('apps','docs','tools','tests')) { Copy-Item -LiteralPath (Join-Path $root $directory) -Destination $stage -Recurse }
$launchDirectory = Get-ChildItem $root -Directory | Where-Object { $_.Name -notin @('apps','docs','tools','tests','artifacts') -and !$_.Name.StartsWith('.') }
foreach ($directory in $launchDirectory) { Copy-Item -LiteralPath $directory.FullName -Destination $stage -Recurse }
Get-ChildItem $stage -Directory -Recurse | Where-Object { $_.Name -in @('__pycache__','bin','obj') } | Sort-Object FullName -Descending | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
foreach ($file in @('README.md','.env.example','.gitignore','LICENSE','NOTICE')) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage }
$desktopArtifact = Get-ChildItem (Join-Path $root 'artifacts') -Directory | Where-Object { $_.Name -match '^ReadBridge-Desktop-win-x64-v(\d+)$' } | Sort-Object { [int]([regex]::Match($_.Name, 'v(\d+)$').Groups[1].Value) } -Descending | Select-Object -First 1
if (!$desktopArtifact) { throw 'Desktop artifact not found. Run apps/windows-desktop/build.ps1 first.' }
New-Item -ItemType Directory -Path (Join-Path $stage 'artifacts') | Out-Null
Copy-Item -LiteralPath $desktopArtifact.FullName -Destination (Join-Path $stage 'artifacts') -Recurse
$outputDirectory = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Force $outputDirectory | Out-Null
$output = Join-Path $outputDirectory 'ReadBridge-submission.zip'
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $output -Force
Write-Host "Created: $output"
