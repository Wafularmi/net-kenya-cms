$ErrorActionPreference = 'SilentlyContinue'
Get-Process -Name "node" | Stop-Process -Force
Start-Sleep -Seconds 5
$job = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory "C:\Users\Pastor David\Desktop\NET KENYA" -PassThru -WindowStyle Hidden -RedirectStandardOutput node.verify.out.log -RedirectStandardError node.verify.err.log
Start-Sleep -Seconds 5
$result = Get-Process -Name "node" -ErrorAction SilentlyContinue | Select-Object Id, ProcessName | Format-Table -AutoSize | Out-String
$result
$job | Stop-Process -Force
Exit 0
