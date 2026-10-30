# 打包 WordSense 为单文件 Windows 程序（WebView2 原生窗口，不再启动浏览器）
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'stage'
$zip = Join-Path $dist 'app.zip'
$wv = Join-Path $root 'tools\webview2\lib\net462'
$loader = Join-Path $root 'tools\webview2\runtimes\win-x64\native\WebView2Loader.dll'

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null
New-Item -ItemType Directory -Force (Join-Path $stage 'data') | Out-Null

Copy-Item (Join-Path $root 'index.html') $stage
Copy-Item (Join-Path $root 'manifest.webmanifest') $stage
Copy-Item (Join-Path $root 'assets') $stage -Recurse
Copy-Item (Join-Path $root 'js') $stage -Recurse
Copy-Item (Join-Path $root 'data\words.js') (Join-Path $stage 'data\words.js')
Remove-Item (Join-Path $stage 'assets\app-icon-source.jpg') -Force -ErrorAction SilentlyContinue

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
Write-Host ("app.zip  {0:N2} MB" -f ((Get-Item $zip).Length / 1MB))

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "找不到 csc.exe" }
if (-not (Test-Path (Join-Path $wv 'Microsoft.Web.WebView2.Core.dll'))) { throw "WebView2 SDK 缺失" }

$exe = Join-Path $dist '词感.exe'
& $csc /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 `
  "/out:$exe" `
  "/win32icon:$dist\icon.ico" `
  "/r:$(Join-Path $wv 'Microsoft.Web.WebView2.Core.dll')" `
  "/r:$(Join-Path $wv 'Microsoft.Web.WebView2.WinForms.dll')" `
  "/resource:$(Join-Path $wv 'Microsoft.Web.WebView2.Core.dll'),Microsoft.Web.WebView2.Core.dll" `
  "/resource:$(Join-Path $wv 'Microsoft.Web.WebView2.WinForms.dll'),Microsoft.Web.WebView2.WinForms.dll" `
  "/resource:$loader,WebView2Loader.dll" `
  "/resource:$zip,app.zip" `
  /r:System.IO.Compression.dll `
  /r:System.IO.Compression.FileSystem.dll `
  /r:System.Windows.Forms.dll `
  /r:System.Drawing.dll `
  (Join-Path $dist 'launcher-webview.cs')

if ($LASTEXITCODE -ne 0 -or -not (Test-Path $exe)) { throw "编译失败" }

$readme = @"
词感 · 句子跟读刷词（Windows 原生窗口版 1.3.0）
============================================

1. 双击「词感.exe」启动，会打开一个独立的原生窗口，不再启动 Chrome/Edge。
2. 不需要管理员权限，直接双击即可；不要勾选「以管理员身份运行」。
3. 需要 Windows 10/11 自带的 Microsoft Edge WebView2 Runtime。
   如果提示缺少 WebView2，请安装：
   https://developer.microsoft.com/microsoft-edge/webview2/
4. 学习记录保存在 %LOCALAPPDATA%\WordSenseNative 中，不上传网络。
   首次运行会自动迁移旧版 %LOCALAPPDATA%\WordSense\profile 里的学习记录。
5. 首次点麦克风跟读时，Windows 会询问麦克风权限，请选择允许。
6. 朗读使用 Windows/Edge 自带语音；自动评分使用 Windows 语音识别。
7. 每日提醒到点会由系统通知（需允许通知，且窗口保持打开）；手机端是系统通知。
8. 换电脑前，请用「设置 → 数据管理 → 导出备份」备份学习记录。
9. 删除 %LOCALAPPDATA%\WordSenseNative 即可彻底清除本机数据。

如果 Windows SmartScreen 提示未知发布者，选择「更多信息 → 仍要运行」。
本程序不收集任何数据，词库为自建数据，仅供个人学习使用。
"@
Set-Content -Path (Join-Path $dist '使用说明.txt') -Value $readme -Encoding UTF8

$packDir = Join-Path $dist 'pack'
if (Test-Path $packDir) { Remove-Item -Recurse -Force $packDir }
New-Item -ItemType Directory -Force $packDir | Out-Null
Copy-Item $exe $packDir
Copy-Item (Join-Path $dist '使用说明.txt') $packDir
$outZip = Join-Path $dist 'WordSense-1.3.0-win64.zip'
if (Test-Path $outZip) { Remove-Item $outZip -Force }
Compress-Archive -Path (Join-Path $packDir '*') -DestinationPath $outZip -CompressionLevel Optimal
Remove-Item -Recurse -Force $packDir

Write-Host ("词感.exe       {0:N2} MB" -f ((Get-Item $exe).Length / 1MB))
Write-Host ("分发包         {0:N2} MB" -f ((Get-Item $outZip).Length / 1MB))
Write-Host "完成：$dist"
