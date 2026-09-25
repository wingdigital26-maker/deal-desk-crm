' Hidden launcher. Same no-space-tokens rule as run-signals-weekly.vbs: Task
' Scheduler invokes this with NO arguments, and it runs exactly one path.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = fso.BuildPath(scriptDir, "run-backup-nightly.bat")
Set objShell = CreateObject("WScript.Shell")
objShell.Run batPath, 0, False
