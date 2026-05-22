# Lore - Windows Installer

$settingsPath = Join-Path $HOME ".gemini" "settings.json"
$currentDir = Get-Location
$indexPath = Join-Path $currentDir "index.js"
$indexPath = $indexPath.Replace("\", "/")

Write-Host "Registering MCP server in $settingsPath..."

if (!(Test-Path $settingsPath)) {
    Write-Error "Could not find Gemini settings.json at $settingsPath"
    exit 1
}

# Install dependencies
Write-Host "Installing dependencies..."
npm install --silent

# Read and update settings.json
$settings = Get-Content $settingsPath | ConvertFrom-Json

if (!$settings.mcpServers) {
    $settings | Add-Member -MemberType NoteProperty -Name "mcpServers" -Value @{}
}

$lessonsConfig = @{
    command = "node"
    args = @($indexPath)
}

if ($settings.mcpServers.lessons) {
    $settings.mcpServers.lessons = $lessonsConfig
} else {
    $settings.mcpServers | Add-Member -MemberType NoteProperty -Name "lessons" -Value $lessonsConfig
}

$settings | ConvertTo-Json -Depth 10 | Set-Content $settingsPath

Write-Host "Success! The Lessons Archive MCP server has been registered."
Write-Host "Restart your Gemini CLI session to use the new tools."
