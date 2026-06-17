@echo off
cd /d "%~dp0"
echo Starting Simple AI for this PC and other devices on your Wi-Fi...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 5 IPAddress,InterfaceAlias"
echo.
echo If Windows Firewall asks, allow access on Private networks.
echo Keep this window open.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve-nebula.ps1" -StartPath "simple-ai/index.html" -ListenAddress "0.0.0.0"
pause
