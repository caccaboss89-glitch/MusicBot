@echo off
setlocal enabledelayedexpansion

echo.
echo ========================================
echo   Discord Music Bot - Avvio
echo ========================================
echo.

echo [VERIFICA] Controllo dipendenze...

REM Test Python e yt-dlp module
python -m yt_dlp --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERRORE] Python o yt-dlp non trovato
    echo.
    pause
    exit /b 1
)

REM Test ffmpeg
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERRORE] ffmpeg non trovato in PATH
    echo.
    echo Installa ffmpeg oppure aggiungi la cartella di installazione al PATH
    echo.
    pause
    exit /b 1
)

REM Test Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERRORE] Node.js non trovato nel PATH
    echo.
    echo Installa Node.js da https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo [OK] Python (con yt-dlp), ffmpeg e Node.js trovati!
echo.
echo Avvio bot Discord Music Bot...
echo.

cd /d "F:\Programmi\Bots\DiscordMusicBot"
npm start

pause
