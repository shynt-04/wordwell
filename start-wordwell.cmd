@echo off
cd /d "%~dp0"
echo Starting Wordwell. Open http://127.0.0.1:4173 in your browser.
echo Keep this window open while you learn. Press Ctrl+C to stop.
node --watch vocab-app\server.mjs
pause
