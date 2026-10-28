#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDE_EXT_DIR="/mnt/c/Users/Ismael/.antigravity-ide/extensions/antigravity-account-switcher"
IDE_VERSIONED_DIR="/mnt/c/Users/Ismael/.antigravity-ide/extensions/antigravity-community.antigravity-account-switcher-1.4.0"
SERVER_EXT_DIR="$HOME/.antigravity-server/extensions/antigravity-account-switcher"
SERVER_VERSIONED_DIR="$HOME/.antigravity-server/extensions/antigravity-community.antigravity-account-switcher-1.4.0"
BIN_TARGET="$HOME/.local/bin/agy-switch"

echo "=== Installing Antigravity Account Switcher ==="

# 1. Install to Windows Antigravity IDE (both folder names for maximum compatibility)
echo "[1/3] Installing extension to Windows Antigravity IDE..."
for target in "$IDE_EXT_DIR" "$IDE_VERSIONED_DIR"; do
    mkdir -p "$target"
    cp "$REPO_DIR/extension.js" "$target/"
    cp "$REPO_DIR/tokenManager.js" "$target/"
    cp "$REPO_DIR/package.json" "$target/"
    cp "$REPO_DIR/switch.py" "$target/"
    cp "$REPO_DIR/LICENSE" "$target/" 2>/dev/null || true
    chmod +x "$target/switch.py"
done

# 2. Install to Antigravity Remote Server (WSL workspaces)
echo "[2/3] Installing extension to Antigravity Remote Server (WSL)..."
for target in "$SERVER_EXT_DIR" "$SERVER_VERSIONED_DIR"; do
    mkdir -p "$target"
    cp "$REPO_DIR/extension.js" "$target/"
    cp "$REPO_DIR/tokenManager.js" "$target/"
    cp "$REPO_DIR/package.json" "$target/"
    cp "$REPO_DIR/switch.py" "$target/"
    cp "$REPO_DIR/LICENSE" "$target/" 2>/dev/null || true
    chmod +x "$target/switch.py"
done

# 3. Install CLI helper to ~/.local/bin
echo "[3/3] Installing terminal CLI shortcut (agy-switch)..."
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO_DIR/switch.py" "$BIN_TARGET"
chmod +x "$BIN_TARGET"

echo "=== Installation Complete! ==="
echo "• Windows Antigravity IDE & WSL Remote: Extension installed."
echo "• Terminal CLI: Available as 'agy-switch' command."
