#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDE_EXT_DIR="/mnt/c/Users/Ismael/.antigravity-ide/extensions/antigravity-account-switcher"
SERVER_EXT_DIR="$HOME/.antigravity-server/extensions/antigravity-account-switcher"
BIN_TARGET="$HOME/.local/bin/agy-switch"

echo "=== Installing Antigravity Account Switcher ==="

# 1. Install to Windows Antigravity IDE
echo "[1/3] Installing extension to Windows Antigravity IDE..."
mkdir -p "$IDE_EXT_DIR"
cp "$REPO_DIR/extension.js" "$IDE_EXT_DIR/"
cp "$REPO_DIR/package.json" "$IDE_EXT_DIR/"
cp "$REPO_DIR/switch.py" "$IDE_EXT_DIR/"
chmod +x "$IDE_EXT_DIR/switch.py"

# 2. Install to Antigravity Remote Server (WSL workspaces)
echo "[2/3] Installing extension to Antigravity Remote Server (WSL)..."
mkdir -p "$SERVER_EXT_DIR"
cp "$REPO_DIR/extension.js" "$SERVER_EXT_DIR/"
cp "$REPO_DIR/package.json" "$SERVER_EXT_DIR/"
cp "$REPO_DIR/switch.py" "$SERVER_EXT_DIR/"
chmod +x "$SERVER_EXT_DIR/switch.py"

# 3. Install CLI helper to ~/.local/bin
echo "[3/3] Installing terminal CLI shortcut (agy-switch)..."
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO_DIR/switch.py" "$BIN_TARGET"
chmod +x "$BIN_TARGET"

echo "=== Installation Complete! ==="
echo "• Windows Antigravity IDE & WSL Remote: Extension installed."
echo "• Terminal CLI: Available as 'agy-switch' command."
