@echo off
REM Weekly sourcing: the signal engine, then the sourcing pipeline (website ->
REM fit -> owners -> signals) for up to 500 companies not checked in 30 days.
REM Output goes to scrapers\.tmp\weekly.log so a silent failure leaves a trace.
cd /d "%~dp0.."
if "%HARNESS_DB_PATH%"=="" set HARNESS_DB_PATH=data\harness.db
if not exist scrapers\.tmp mkdir scrapers\.tmp
echo ==== %DATE% %TIME% >> scrapers\.tmp\weekly.log
python scrapers\harness_signals.py run --db "%HARNESS_DB_PATH%" >> scrapers\.tmp\weekly.log 2>&1
python scrapers\pipeline.py run --db "%HARNESS_DB_PATH%" --limit 500 --quiet --log scrapers\.tmp\pipeline-runs.jsonl >> scrapers\.tmp\weekly.log 2>&1
