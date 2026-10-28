#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDE_EXT_DIR="/mnt/c/Users/Ismael/.antigravity-ide/extensions/antigravity-account-switcher"
BIN_TARGET="$HOME/.local/bin/agy-switch"

echo "=== Installing Antigravity Account Switcher ==="

# 1. Install to Antigravity IDE
echo "[1/2] Installing extension to Antigravity IDE..."
mkdir -p "$IDE_EXT_DIR"
cp "$REPO_DIR/extension.js" "$IDE_EXT_DIR/"
cp "$REPO_DIR/package.json" "$IDE_EXT_DIR/"
cp "$REPO_DIR/switch.py" "$IDE_EXT_DIR/"
chmod +x "$IDE_EXT_DIR/switch.py"

# 2. Install CLI helper to ~/.local/bin
echo "[2/2] Installing terminal CLI shortcut (agy-switch)..."
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO_DIR/switch.py" "$BIN_TARGET"
chmod +x "$BIN_TARGET"

echo "=== Installation Complete! ==="
echo "• Antigravity IDE: Extension installed. Reload Antigravity IDE to activate."
echo "• Terminal CLI: Available as 'agy-switch' command."
