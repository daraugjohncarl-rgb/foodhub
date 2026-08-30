# Inbox POS Localhost PowerShell Launcher
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " Starting Inbox POS on Localhost (http://127.0.0.1:8000)" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Cyan

$PythonExe = "python"
if (Test-Path "fastapi\venv\Scripts\python.exe") {
    $PythonExe = "fastapi\venv\Scripts\python.exe"
}

& $PythonExe run.py
