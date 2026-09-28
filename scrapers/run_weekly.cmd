@echo off
REM Weekly zero-usage sourcing run for the banker harness: the signal engine,
REM then the sourcing pipeline (website -> fit -> owners -> signals).
REM Called by the hidden .vbs launcher on Windows Task Scheduler, or directly.
setlocal
set SCRIPT_DIR=%~dp0
if "%HARNESS_DB_PATH%"=="" (set DB_PATH=%SCRIPT_DIR%..\data\harness.db) else (set DB_PATH=%HARNESS_DB_PATH%)
cd /d "%SCRIPT_DIR%.."
if not exist scrapers\.tmp mkdir scrapers\.tmp
python scrapers\harness_signals.py run --db "%DB_PATH%" >> scrapers\.tmp\weekly.log 2>&1
python scrapers\pipeline.py run --db "%DB_PATH%" --limit 500 --quiet --log scrapers\.tmp\pipeline-runs.jsonl >> scrapers\.tmp\weekly.log 2>&1
endlocal
