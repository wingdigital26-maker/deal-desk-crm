@echo off
REM Weekly zero-usage signal run for the banker harness.
REM Called by the hidden .vbs launcher on Windows Task Scheduler, or directly.
setlocal
set SCRIPT_DIR=%~dp0
set DB_PATH=%SCRIPT_DIR%..\data\harness.db
cd /d "%SCRIPT_DIR%.."
python scrapers\harness_signals.py run --db "%DB_PATH%"
endlocal
