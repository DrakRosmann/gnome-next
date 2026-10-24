#!/usr/bin/env bash
# Installs the latest GNOME Next release for the current user, no build tools needed:
#   curl -fsSL https://raw.githubusercontent.com/DrakRosmann/gnome-next/master/get.sh | bash
set -euo pipefail

UUID=gnome-next@gui
URL=https://github.com/DrakRosmann/gnome-next/releases/latest/download/$UUID.zip
SUPPORTED="50 51"

if ! command -v gnome-extensions >/dev/null; then
    echo "gnome-extensions not found: GNOME Shell does not seem to be installed." >&2
    exit 1
fi

major=$(gnome-shell --version 2>/dev/null | sed -n 's/.* \([0-9]\+\)\..*/\1/p')
if [[ -n $major && " $SUPPORTED " != *" $major "* ]]; then
    echo "Warning: GNOME Shell $major is not supported (supported: $SUPPORTED)." >&2
    echo "The shell will refuse to load the extension." >&2
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if command -v curl >/dev/null; then
    curl -fsSL -o "$tmp/$UUID.zip" "$URL"
else
    wget -qO "$tmp/$UUID.zip" "$URL"
fi
gnome-extensions install --force "$tmp/$UUID.zip"

echo "Installed $UUID."
if [[ ${XDG_SESSION_TYPE:-} == x11 ]]; then
    echo "Restart the shell (Alt+F2, r, Enter), then:"
else
    echo "Log out and back in, then:"
fi
echo "  gnome-extensions enable $UUID"
