Option Explicit
Dim shell, fs, root, profile, env
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName))
profile = "A"
If WScript.Arguments.Count > 0 Then profile = WScript.Arguments(0)
If profile <> "A" And profile <> "B" Then WScript.Quit 1
Set env = shell.Environment("Process")
env.Remove "ELECTRON_RUN_AS_NODE"
env.Remove "NODE_OPTIONS"
env.Remove "NODE_PATH"
shell.CurrentDirectory = root
shell.Run """" & root & "\node_modules\electron\dist\electron.exe"" """ & root & "\desktop\chrome-main.mjs"" --profile=" & profile, 0, False
