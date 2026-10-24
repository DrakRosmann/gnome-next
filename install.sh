#!/usr/bin/env bash
# Builds GNOME Next and installs it for the current user.
#   ./install.sh          install into ~/.local/share/gnome-shell/extensions
#   ./install.sh pack     build gnome-next@gui.zip
#   ./install.sh build    only build into ./build (used by the other commands)
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"
UUID=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' metadata.json)
BUILD=build/$UUID

build() {
    rm -rf build
    mkdir -p "$BUILD"
    cp -r metadata.json extension.js prefs.js stylesheet.css lib schemas "$BUILD/"
    # Ship both variants: the shell only reloads variant stylesheets when the
    # color scheme changes
    cp stylesheet.css "$BUILD/stylesheet-dark.css"
    cat stylesheet.css light.css > "$BUILD/stylesheet-light.css"
    glib-compile-schemas --strict "$BUILD/schemas"
    if ! command -v msgfmt >/dev/null; then
        echo "msgfmt not found (install gettext): skipping translations" >&2
        return
    fi
    for po in po/*.po; do
        lang=$(basename "$po" .po)
        mkdir -p "$BUILD/locale/$lang/LC_MESSAGES"
        msgfmt -c "$po" -o "$BUILD/locale/$lang/LC_MESSAGES/$UUID.mo"
    done
}

case "${1:-install}" in
    build)
        build ;;
    pack)
        build
        rm -f "$UUID.zip"
        (cd "$BUILD" && zip -qr "../../$UUID.zip" .)
        echo "Created $UUID.zip" ;;
    install)
        build
        dest="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
        rm -rf "$dest"
        mkdir -p "$(dirname "$dest")"
        cp -r "$BUILD" "$dest"
        echo "Installed to $dest"
        echo "Log out and back in (Wayland) or press Alt+F2, r, Enter (X11), then:"
        echo "  gnome-extensions enable $UUID" ;;
    *)
        echo "usage: $0 [install|pack|build]" >&2
        exit 1 ;;
esac
