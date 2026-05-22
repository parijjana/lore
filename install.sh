#!/bin/bash
# Lore - macOS/Linux Installer

SETTINGS_PATH="$HOME/.gemini/settings.json"
CURRENT_DIR=$(pwd)
INDEX_PATH="$CURRENT_DIR/index.js"

echo "Registering MCP server in $SETTINGS_PATH..."

if [ ! -f "$SETTINGS_PATH" ]; then
    echo "Error: Could not find Gemini settings.json at $SETTINGS_PATH"
    exit 1
fi

# Install dependencies
echo "Installing dependencies..."
npm install --silent

# Update settings.json using node (since we know it's installed)
node <<EOF
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('$SETTINGS_PATH', 'utf8'));

if (!settings.mcpServers) {
    settings.mcpServers = {};
}

settings.mcpServers.lessons = {
    command: 'node',
    args: ['$INDEX_PATH']
};

fs.writeFileSync('$SETTINGS_PATH', JSON.stringify(settings, null, 2), 'utf8');
EOF

echo "Success! The Lessons Archive MCP server has been registered."
echo "Restart your Gemini CLI session to use the new tools."
