Add-Type -AssemblyName System.Drawing
$assetDirectory = Join-Path $PSScriptRoot '../app/assets'
New-Item -ItemType Directory -Path $assetDirectory -Force | Out-Null
$bitmap = [Drawing.Bitmap]::new(256,256)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([Drawing.ColorTranslator]::FromHtml('#192213'))
$pen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#c4ed9e'),19)
$pen.StartCap = [Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($pen,73,105,73,151)
$graphics.DrawLine($pen,110,66,110,190)
$graphics.DrawLine($pen,147,85,147,171)
$graphics.DrawLine($pen,184,114,184,142)
$pngPath = Join-Path $assetDirectory 'icon.png'
$bitmap.Save($pngPath,[Drawing.Imaging.ImageFormat]::Png)
$pen.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
$pngBytes = [IO.File]::ReadAllBytes($pngPath)
$iconStream = [IO.File]::Create((Join-Path $assetDirectory 'icon.ico'))
$writer = [IO.BinaryWriter]::new($iconStream)
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$pngBytes.Length); $writer.Write([uint32]22)
$writer.Write($pngBytes); $writer.Dispose()
