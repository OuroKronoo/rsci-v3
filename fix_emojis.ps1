$filePath = Join-Path $PSScriptRoot 'rsci.js'
$content = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8)

# Remove empty empty-icon divs (both regular and escaped quote variants)
$content = $content.Replace('<div class="empty-icon"></div>', '')
$content = $content.Replace('<div class=\"empty-icon\"></div>', '')
# Also handle the variant: class=\\\"empty-icon\\\"
$content = $content.Replace('<div class=\\\"empty-icon\\\"></div>', '')

[System.IO.File]::WriteAllText($filePath, $content, (New-Object System.Text.UTF8Encoding $true))
Write-Host "Done - empty icon divs removed"
