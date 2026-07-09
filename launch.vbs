Set oShell = CreateObject("WScript.Shell")
oShell.Run "cmd /c cd /d C:\Users\Pastor David\Desktop\NET KENYA && node server.js > node.out.log 2> node.err.log", 0, False
