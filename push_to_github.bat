@echo off
echo Pushing project to Git repository...
rem Never force-push: a rejected push means the remote has commits you do not have. Pull and merge them first.
cd /d "%~dp0"
"C:\Program Files\Git\cmd\git.exe" push -u origin main
pause
