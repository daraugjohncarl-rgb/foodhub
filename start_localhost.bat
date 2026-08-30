@echo off
title Inbox POS Localhost Server
echo ========================================================
echo  Starting Inbox POS on Localhost (http://127.0.0.1:8000)
echo ========================================================

set PYTHON_CMD=python
if exist "fastapi\venv\Scripts\python.exe" (
    set PYTHON_CMD=fastapi\venv\Scripts\python.exe
)

%PYTHON_CMD% run.py
pause
