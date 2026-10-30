@echo off
setlocal enabledelayedexpansion
title Inbox POS Localhost Server
echo ========================================================
echo  Starting Inbox POS on Localhost (http://127.0.0.1:8000)
echo ========================================================

set PYTHON_CMD=python
if exist ".venv\Scripts\python.exe" (
    set PYTHON_CMD=.venv\Scripts\python.exe
) else if exist "fastapi\venv\Scripts\python.exe" (
    set PYTHON_CMD=fastapi\venv\Scripts\python.exe
) else (
    py -3.12 -c "import uvicorn" >nul 2>&1
    if !errorlevel! equ 0 (
        set PYTHON_CMD=py -3.12
    ) else (
        py -3.15 -c "import uvicorn" >nul 2>&1
        if !errorlevel! equ 0 (
            set PYTHON_CMD=py -3.15
        ) else (
            py -c "import uvicorn" >nul 2>&1
            if !errorlevel! equ 0 (
                set PYTHON_CMD=py
            )
        )
    )
)

echo Using Python runtime: %PYTHON_CMD%
echo.
echo Opening Cashier POS in browser...
start http://127.0.0.1:8000/cashier#pos

%PYTHON_CMD% run.py
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Server terminated with error code %errorlevel%.
    pause
)
