# Inbox POS Localhost PowerShell Launcher
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " Starting Inbox POS on Localhost (http://127.0.0.1:8000)" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Cyan

$PythonExe = "python"
if (Test-Path ".venv\Scripts\python.exe") {
    $PythonExe = ".venv\Scripts\python.exe"
} elseif (Test-Path "fastapi\venv\Scripts\python.exe") {
    $PythonExe = "fastapi\venv\Scripts\python.exe"
} else {
    try {
        & py -3.12 -c "import uvicorn" 2>$null
        if ($LASTEXITCODE -eq 0) {
            $PythonExe = "py -3.12"
        } else {
            & py -3.15 -c "import uvicorn" 2>$null
            if ($LASTEXITCODE -eq 0) {
                $PythonExe = "py -3.15"
            }
        }
    } catch {}
}

Write-Host "Using Python runtime: $PythonExe" -ForegroundColor Yellow
Write-Host "Opening Cashier POS in browser..." -ForegroundColor Cyan
Start-Process "http://127.0.0.1:8000/cashier#pos"

& $PythonExe run.py
