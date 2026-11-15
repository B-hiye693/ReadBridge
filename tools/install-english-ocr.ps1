$ErrorActionPreference = 'Stop'
Write-Host 'Installing Windows English OCR capability...' -ForegroundColor Cyan
Add-WindowsCapability -Online -Name 'Language.OCR~~~en-US~0.0.1.0'
Write-Host 'English OCR installed. Restart ReadBridge before using OCR.' -ForegroundColor Green
Read-Host 'Press Enter to close'
