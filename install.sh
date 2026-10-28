#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDE_EXT_DIR="/mnt/c/Users/Ismael/.antigravity-ide/extensions/antigravity-account-switcher"
IDE_VERSIONED_DIR="/mnt/c/Users/Ismael/.antigravity-ide/extensions/antigravity-community.antigravity-account-switcher-1.4.0"
SERVER_EXT_DIR="$HOME/.antigravity-server/extensions/antigravity-account-switcher"
SERVER_VERSIONED_DIR="$HOME/.antigravity-server/extensions/antigravity-community.antigravity-account-switcher-1.4.0"
IDE_SERVER_EXT_DIR="$HOME/.antigravity-ide-server/extensions/antigravity-account-switcher"
IDE_SERVER_VERSIONED_DIR="$HOME/.antigravity-ide-server/extensions/antigravity-community.antigravity-account-switcher-1.4.0"
BIN_TARGET="$HOME/.local/bin/agy-switch"

echo "=== Installing Antigravity Account Switcher ==="

# 1. Install to Windows Antigravity IDE (both folder names for maximum compatibility)
echo "[1/4] Installing extension to Windows Antigravity IDE..."
for target in "$IDE_EXT_DIR" "$IDE_VERSIONED_DIR"; do
    mkdir -p "$target"
    cp "$REPO_DIR/extension.js" "$target/"
    cp "$REPO_DIR/tokenManager.js" "$target/"
    cp "$REPO_DIR/package.json" "$target/"
    cp "$REPO_DIR/switch.py" "$target/"
    cp "$REPO_DIR/LICENSE" "$target/" 2>/dev/null || true
    chmod +x "$target/switch.py"
done

# 2. Install to Antigravity Remote Server (WSL workspaces - server and ide-server)
echo "[2/4] Installing extension to Antigravity Remote Server (WSL)..."
for target in "$SERVER_EXT_DIR" "$SERVER_VERSIONED_DIR" "$IDE_SERVER_EXT_DIR" "$IDE_SERVER_VERSIONED_DIR"; do
    mkdir -p "$target"
    cp "$REPO_DIR/extension.js" "$target/"
    cp "$REPO_DIR/tokenManager.js" "$target/"
    cp "$REPO_DIR/package.json" "$target/"
    cp "$REPO_DIR/switch.py" "$target/"
    cp "$REPO_DIR/LICENSE" "$target/" 2>/dev/null || true
    chmod +x "$target/switch.py"
done

# 3. Install CLI helper to ~/.local/bin
echo "[3/4] Installing terminal CLI shortcut (agy-switch)..."
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO_DIR/switch.py" "$BIN_TARGET"
chmod +x "$BIN_TARGET"

# 4. Attempt VSIX registration via server CLI if available
echo "[4/4] Ensuring VSIX registration..."
VSIX_FILE="$REPO_DIR/antigravity-account-switcher-1.4.0.vsix"
SERVER_BIN="$(find "$HOME/.antigravity-ide-server/bin" -name "antigravity-ide-server" 2>/dev/null | head -n 1 || true)"
if [ -n "$SERVER_BIN" ] && [ -x "$SERVER_BIN" ] && [ -f "$VSIX_FILE" ]; then
    "$SERVER_BIN" --install-extension "$VSIX_FILE" --force 2>/dev/null || true
fi

echo "=== Installation Complete! ==="
echo "• Windows Antigravity IDE, WSL Remote Server & IDE-Server: Extension fully installed."
echo "• Terminal CLI: Available as 'agy-switch' command."
