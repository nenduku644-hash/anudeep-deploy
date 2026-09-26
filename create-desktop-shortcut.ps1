$desktopDir = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
$projectDir = "C:\Users\ADMIN\Desktop\anudeep-kadir-bandi"
$exePath = Join-Path $projectDir "AKB-Billing.exe"
$iconPath = Join-Path $projectDir "icon.ico"
$shortcutPath = Join-Path $desktopDir "Anudeep Khadi Bandar - GST Billing.lnk"

$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($shortcutPath)
$sc.TargetPath = $exePath
$sc.WorkingDirectory = $projectDir
$sc.IconLocation = "$iconPath,0"
$sc.Description = "Anudeep Khadi Bandar - Dedicated GST Billing Workstation"
$sc.Save()

Write-Host "✅ Dedicated App Desktop shortcut created successfully at: $shortcutPath"
