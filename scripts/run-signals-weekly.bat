@echo off
cd /d "%~dp0.."
python scrapers\harness_signals.py run --db data\harness.db
