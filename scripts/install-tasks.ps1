<#
Registers two Windows Scheduled Tasks for banker-harness:
  HarnessSignalsWeekly  - Mondays 06:00 - runs the Python signal scraper
  HarnessBackupNightly  - daily 02:30    - runs the database backup script

Both launch hidden via a .vbs -> .bat chain (scripts/run-*.vbs / .bat) to work
around a known bug on this machine: a hidden .vbs launcher silently exits 1 if
Task Scheduler passes it 2+ space-separated command-line tokens. So each task
action is the .vbs alone, invoked with wscript.exe //B and no other arguments;
the .vbs then runs its .bat, and the .bat is the one place that carries the
actual multi-argument command.

Idempotent: re-running this replaces any existing task of the same name
instead of duplicating it (Register-ScheduledTask -Force).

Usage:
  powershell -File scripts/install-tasks.ps1            # register/update both tasks
  powershell -File scripts/install-tasks.ps1 -Remove     # unregister both tasks
#>

param(
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ScriptsDir = Join-Path $RepoRoot "scripts"

$Tasks = @(
    @{
        Name    = "HarnessSignalsWeekly"
        Vbs     = Join-Path $ScriptsDir "run-signals-weekly.vbs"
        Trigger = { New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 6:00am }
        Summary = "Mondays 06:00 -> scrapers/harness_signals.py run --db data/harness.db"
    },
    @{
        Name    = "HarnessBackupNightly"
        Vbs     = Join-Path $ScriptsDir "run-backup-nightly.vbs"
        Trigger = { New-ScheduledTaskTrigger -Daily -At 2:30am }
        Summary = "Daily 02:30 -> scripts/backup-db.mjs"
    }
)

function Remove-HarnessTasks {
    foreach ($t in $Tasks) {
        $existing = Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue
        if ($existing) {
            Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false
            Write-Host "Removed scheduled task: $($t.Name)"
        } else {
            Write-Host "Scheduled task not present (nothing to remove): $($t.Name)"
        }
    }
}

function Install-HarnessTasks {
    foreach ($t in $Tasks) {
        if (-not (Test-Path $t.Vbs)) {
            throw "Missing launcher: $($t.Vbs)"
        }

        # wscript.exe //B <vbs-path-with-no-other-arguments> keeps the .vbs's own
        # command line to a single token, avoiding the silent-exit-1 bug.
        $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B `"$($t.Vbs)`""
        $trigger = & $t.Trigger
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

        Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
        Write-Host "Registered scheduled task: $($t.Name)"
        Write-Host "  $($t.Summary)"
        Write-Host "  Launcher: $($t.Vbs)"
    }
}

if ($Remove) {
    Remove-HarnessTasks
    Write-Host ""
    Write-Host "Removed HarnessSignalsWeekly and HarnessBackupNightly (if present)."
} else {
    Install-HarnessTasks
    Write-Host ""
    Write-Host "Summary:"
    foreach ($t in $Tasks) {
        Write-Host "  $($t.Name): $($t.Summary)"
    }
    Write-Host ""
    Write-Host "Re-run this script any time to update both tasks in place."
    Write-Host "Run with -Remove to unregister both tasks."
}
