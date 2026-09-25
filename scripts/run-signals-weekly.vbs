' Hidden launcher. Known bug on this machine: a hidden .vbs launcher silently
' exits 1 if its command line has 2+ space-separated tokens, so Task Scheduler
' must invoke this .vbs with NO arguments, and this script in turn runs exactly
' one path (the .bat sitting next to it, which itself has no spaces in its name).
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = fso.BuildPath(scriptDir, "run-signals-weekly.bat")
Set objShell = CreateObject("WScript.Shell")
objShell.Run batPath, 0, False
