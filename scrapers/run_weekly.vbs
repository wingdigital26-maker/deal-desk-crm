' Hidden launcher for run_weekly.cmd, so Windows Task Scheduler never pops a console box.
Set objShell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
objShell.Run """" & scriptDir & "\run_weekly.cmd""", 0, False
