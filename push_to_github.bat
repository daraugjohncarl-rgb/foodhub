@echo off
echo Pushing project to GitHub repository...
cd /d "%~dp0"
"C:\Program Files\Git\cmd\git.exe" push -u origin main --force
pause
