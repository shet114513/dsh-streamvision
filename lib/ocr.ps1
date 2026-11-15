param(
  [Parameter(Mandatory=$true)][string]$Path,
  [double]$CropTop = 0.84,
  [double]$CropBottom = 0.94,
  [double]$Scale = 3.0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$src = [System.Drawing.Image]::FromFile($Path)
$sw = $src.Width
$y0 = [int]($src.Height * $CropTop)
$h = [int]($src.Height * ($CropBottom - $CropTop))
if ($h -lt 8) { $h = 8 }
$rect = New-Object System.Drawing.Rectangle(0, $y0, $sw, $h)
$crop = $src.Clone($rect, $src.PixelFormat)

$w2 = [int]($sw * $Scale)
$h2 = [int]($h * $Scale)
$big = New-Object System.Drawing.Bitmap($w2, $h2)
$g = [System.Drawing.Graphics]::FromImage($big)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($crop, 0, 0, $w2, $h2)
$g.Dispose()

$tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ("svocr_" + [guid]::NewGuid().ToString('N') + ".png"))
$big.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose(); $crop.Dispose(); $src.Dispose()

$OcrEngine = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$BitmapDecoder = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$StorageFile = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]

$engine = $OcrEngine::TryCreateFromUserProfileLanguages()

$file = Await ($StorageFile::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ($BitmapDecoder::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$lines = @()
foreach ($line in $result.Lines) { $lines += $line.Text }
$text = ($lines -join "`n").Trim()

Remove-Item $tmp -Force -ErrorAction SilentlyContinue
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output ((@{ ok = $true; text = $text; lines = $lines.Count; crop = "${sw}x${h}" }) | ConvertTo-Json -Compress)
