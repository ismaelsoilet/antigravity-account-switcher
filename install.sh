#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLISHER="antigravity-community"
EXT_NAME="antigravity-account-switcher"

if ! command -v python3 >/dev/null 2>&1; then
    printf 'python3 is required by agy-switch and by the installer.\n' >&2
    exit 1
fi
DRY_RUN=0
REGISTER_VSIX=0

for argument in "$@"; do
    case "$argument" in
        --dry-run) DRY_RUN=1 ;;
        --register-vsix) REGISTER_VSIX=1 ;;
        -h|--help)
            printf '%s\n' "Usage: ./install.sh [--dry-run] [--register-vsix]"
            printf '%s\n' ""
            printf '%s\n' "  --dry-run         Show every action without changing files."
            printf '%s\n' "  --register-vsix   Also ask the Antigravity server CLI to register the VSIX."
            exit 0
            ;;
        *)
            printf 'Unknown option: %s\n' "$argument" >&2
            exit 1
            ;;
    esac
done

VERSION="$(python3 - "$REPO_DIR/package.json" <<'PY' 2>/dev/null || true
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])
PY
)"
if [ -z "$VERSION" ]; then
    VERSION="$(grep '"version"' "$REPO_DIR/package.json" | head -n 1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
fi

note() {
    printf '%s\n' "$*"
}

run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '  [dry-run] %s\n' "$*"
    else
        "$@"
    fi
}

find_windows_home() {
    if [ -n "${ANTIGRAVITY_WIN_HOME:-}" ]; then
        printf '%s\n' "$ANTIGRAVITY_WIN_HOME"
        return 0
    fi

    if command -v cmd.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
        local raw
        raw="$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r' || true)"
        if [ -n "$raw" ]; then
            local converted
            converted="$(wslpath -u "$raw" 2>/dev/null || true)"
            if [ -n "$converted" ] && [ -d "$converted" ]; then
                printf '%s\n' "$converted"
                return 0
            fi
        fi
    fi

    if [ -d /mnt/c/Users ]; then
        local candidate name
        for candidate in /mnt/c/Users/*; do
            [ -d "$candidate" ] || continue
            name="$(basename "$candidate")"
            case "$name" in
                Public|Default|"Default User"|"All Users"|desktop.ini) continue ;;
            esac
            if [ -d "$candidate/.gemini" ] || [ -d "$candidate/.antigravity-ide" ] || [ -d "$candidate/.antigravity" ]; then
                printf '%s\n' "$candidate"
                return 0
            fi
        done
    fi
    return 0
}

update_manifest() {
    local root="$1"
    local target="$2"
    local manifest="$root/extensions.json"

    if [ ! -f "$manifest" ]; then
        return 0
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
        note "[dry-run] update manifest entry -> $manifest"
        return 0
    fi

    python3 - "$manifest" "$target" "$VERSION" <<'PY'
import json
import os
import sys

manifest, target, version = sys.argv[1:4]
extension_id = "antigravity-community.antigravity-account-switcher"

try:
    with open(manifest, "r", encoding="utf-8") as handle:
        original = handle.read()
    data = json.loads(original)
except Exception as error:
    sys.stderr.write(f"Warning: could not parse {manifest}: {error}\n")
    sys.exit(0)

is_list = isinstance(data, list)
items = data if is_list else data.get("extensions")
if not isinstance(items, list):
    sys.exit(0)

normalized = target.replace("\\", "/")
if normalized.startswith("/mnt/") and len(normalized) > 6 and normalized[5].isalpha():
    uri_path = "/" + normalized[5] + ":" + normalized[6:]
else:
    uri_path = normalized

items = [
    entry for entry in items
    if isinstance(entry, dict) and (entry.get("identifier") or {}).get("id") != extension_id
]
items.append({
    "identifier": {"id": extension_id},
    "version": version,
    "location": {"$mid": 1, "path": uri_path, "scheme": "file"},
    "relativeLocation": os.path.basename(target),
})

if is_list:
    data = items
else:
    data["extensions"] = items

with open(manifest + ".bak", "w", encoding="utf-8") as handle:
    handle.write(original)

temp_path = manifest + ".tmp"
with open(temp_path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2)
os.replace(temp_path, manifest)
PY
    note "Updated manifest -> $manifest"
}

cleanup_duplicates() {
    local root="$1"
    local keep="$2"
    local candidate
    for candidate in "$root/$EXT_NAME" "$root/$PUBLISHER.$EXT_NAME"-*; do
        [ -e "$candidate" ] || continue
        [ "$candidate" = "$keep" ] && continue
        if grep -q '"name"[[:space:]]*:[[:space:]]*"antigravity-account-switcher"' "$candidate/package.json" 2>/dev/null; then
            note "Removing duplicate/old copy: $candidate"
            run rm -rf "$candidate"
        fi
    done
}

install_extension() {
    local root="$1"
    local target="$root/$PUBLISHER.$EXT_NAME-$VERSION"

    if [ "$DRY_RUN" -eq 1 ]; then
        note "[dry-run] install extension -> $target"
    else
        mkdir -p "$target"
        install -m 0644 "$REPO_DIR/extension.js" "$target/extension.js"
        install -m 0644 "$REPO_DIR/tokenManager.js" "$target/tokenManager.js"
        install -m 0644 "$REPO_DIR/package.json" "$target/package.json"
        if [ -f "$REPO_DIR/LICENSE" ]; then
            install -m 0644 "$REPO_DIR/LICENSE" "$target/LICENSE"
        fi
        for extra in README.md CHANGELOG.md; do
            if [ -f "$REPO_DIR/$extra" ]; then
                install -m 0644 "$REPO_DIR/$extra" "$target/$extra"
            fi
        done
        if [ -d "$REPO_DIR/assets" ]; then
            run mkdir -p "$target/assets"
            run cp -R "$REPO_DIR/assets/." "$target/assets/"
        fi
        note "Installed extension -> $target"
    fi
    cleanup_duplicates "$root" "$target"
    update_manifest "$root" "$target"
}

note "=== Antigravity Account Switcher installer (v$VERSION) ==="
if [ "$DRY_RUN" -eq 1 ]; then
    note "Dry run enabled: no files will be changed."
fi

WIN_HOME="$(find_windows_home)"
if [ -n "$WIN_HOME" ] && { [ -d "$WIN_HOME/.antigravity-ide" ] || [ -d "$WIN_HOME/.antigravity" ]; }; then
    install_extension "$WIN_HOME/.antigravity-ide/extensions"
    if [ -d "$WIN_HOME/.antigravity" ]; then
        install_extension "$WIN_HOME/.antigravity/extensions"
    fi
else
    note "Windows Antigravity IDE not found; skipping the Windows copy."
fi

for server_root in "$HOME/.antigravity-server" "$HOME/.antigravity-ide-server"; do
    if [ -d "$server_root" ]; then
        install_extension "$server_root/extensions"
    else
        note "Skipping $server_root (not installed)."
    fi
done

BIN_DIR="$HOME/.local/bin"
note "Installing the agy-switch CLI in $BIN_DIR..."
run mkdir -p "$BIN_DIR"
run rm -f "$BIN_DIR/agy-switch"
run install -m 0755 "$REPO_DIR/switch.py" "$BIN_DIR/agy-switch"
case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) note "Warning: $BIN_DIR is not in PATH. Add it to use 'agy-switch' from any directory." ;;
esac

if [ "$REGISTER_VSIX" -eq 1 ]; then
    VSIX="$REPO_DIR/$EXT_NAME-$VERSION.vsix"
    if [ -f "$VSIX" ]; then
        SERVER_BIN="$(find "$HOME/.antigravity-ide-server/bin" "$HOME/.antigravity-server/bin" -type f -name "antigravity-ide-server" 2>/dev/null | sort -V | tail -n 1 || true)"
        if [ -n "$SERVER_BIN" ]; then
            note "Registering the VSIX with the Antigravity server..."
            run "$SERVER_BIN" --install-extension "$VSIX" --force || note "VSIX registration failed; the copied files are still installed."
        else
            note "No Antigravity server CLI found; the copied extension files are enough."
        fi
    else
        note "VSIX for v$VERSION not found. Build it with: npm run package"
    fi
else
    note "VSIX registration skipped (directory copies are enough). Use --register-vsix to attempt it."
fi

note ""
note "=== Installation complete ==="
note "Reload the Antigravity IDE window (or restart the server) to load v$VERSION."
