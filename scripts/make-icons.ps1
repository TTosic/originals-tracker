# Generates the extension icons to MATCH the in-game toggle gem: an OUTLINE
# gem (the same three paths — outer pentagon, girdle line, V facets), not a
# filled jewel. Teal stroke + a faint fill for weight, sized edge-to-edge so
# it isn't dwarfed in the Chrome toolbar.
# Re-run:  powershell -File scripts\make-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$dir  = Join-Path $root 'icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$stroke = [System.Drawing.Color]::FromArgb(255, 45, 212, 191)  # gem teal (toggle uses currentColor; here it's branded teal)
$fill   = [System.Drawing.Color]::FromArgb(46,  45, 212, 191)  # faint teal body so it isn't hollow

$sizes = 16, 32, 48, 128
foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = $size * 0.05
  $avail = $size - 2 * $pad
  $bx0 = 2; $by0 = 4; $bw = 20; $bh = 17
  $scale = $avail / $bw
  $offX = $pad
  $offY = ($size - $bh * $scale) / 2
  $mk = { param($x, $y) New-Object System.Drawing.PointF([single]($offX + ($x - $bx0) * $scale), [single]($offY + ($y - $by0) * $scale)) }

  $outer = @((& $mk 5 4), (& $mk 19 4), (& $mk 22 9), (& $mk 12 21), (& $mk 2 9))
  $vee   = @((& $mk 8 9), (& $mk 12 21), (& $mk 16 9))

  $sw = [single]([Math]::Max(1.4, $size * 0.072))
  $pen = New-Object System.Drawing.Pen($stroke, $sw)
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
  $brush = New-Object System.Drawing.SolidBrush($fill)

  $g.FillPolygon($brush, [System.Drawing.PointF[]]$outer)
  $g.DrawPolygon($pen, [System.Drawing.PointF[]]$outer)
  $g.DrawLine($pen, (& $mk 2 9), (& $mk 22 9))
  $g.DrawLines($pen, [System.Drawing.PointF[]]$vee)

  $out = Join-Path $dir "$size.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $pen.Dispose(); $brush.Dispose()
  Write-Host "wrote $out"
}
