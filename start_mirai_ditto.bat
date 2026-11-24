@echo off
chcp 65001 > nul
cd /d "%~dp0"
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
    tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I "ollama.exe" >NUL
    if errorlevel 1 (
        echo ローカルLLM (Ollama) をバックグラウンドで起動しています...
        start "" /B "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve >nul 2>&1
    )
)
echo Mirai Voice Studio + Ditto TalkingHead を起動しています...
"C:\Users\yuuki\.gemini\antigravity\scratch\ditto-talkinghead\.venv\Scripts\python.exe" app.py
pause


