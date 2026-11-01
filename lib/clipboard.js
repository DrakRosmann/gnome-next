import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const MAX_ITEMS = 30;
const MAX_LENGTH = 8000; // characters kept of each copy
// Password managers mark what they copy with this (KeePassXC, Bitwarden…)
const SECRET_HINT = 'x-kde-passwordManagerHint';

function historyFile() {
    return Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_user_cache_dir(), 'gnome-next', 'clipboard.json']));
}

// Text copied lately, newest first. It is only kept while the clipboard
// widget is on the board, and saved to a file only the user can read, so it
// lasts through a lock (which disables the extension).
export class ClipboardHistory extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._items = [];
        this._watching = false;
    }

    enable() {
        this._settings.connectObject('changed::widgets', () => this._syncWatching(), this);
        this._load();
        this._syncWatching();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._stopWatching();
    }

    get items() {
        return this._items;
    }

    _wanted() {
        return this._settings.get_strv('widgets').some(entry => entry.startsWith('clipboard:'));
    }

    _syncWatching() {
        if (this._wanted() && !this._watching) {
            this._watching = true;
            global.display.get_selection().connectObject('owner-changed', (_s, type) => {
                if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                    this._read();
            }, this);
        } else if (!this._wanted() && this._watching) {
            this._stopWatching();
            // Taking the widget away forgets what it kept
            this.clear();
        }
    }

    _stopWatching() {
        if (!this._watching)
            return;
        this._watching = false;
        global.display.get_selection().disconnectObject(this);
    }

    _read() {
        const clipboard = St.Clipboard.get_default();
        if (clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD).includes(SECRET_HINT))
            return;
        clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (!text?.trim() || !this._watching)
                return;
            this._push(text.slice(0, MAX_LENGTH));
        });
    }

    _push(text) {
        if (this._items[0] === text)
            return;
        this._items = [text, ...this._items.filter(t => t !== text)].slice(0, MAX_ITEMS);
        this._changed();
    }

    // Puts `text` back on the clipboard; it moves to the top
    copy(text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._push(text);
    }

    remove(text) {
        this._items = this._items.filter(t => t !== text);
        this._changed();
    }

    clear() {
        if (this._items.length === 0)
            return;
        this._items = [];
        this._changed();
    }

    _changed() {
        this._save();
        this.emit('changed');
    }

    _load() {
        try {
            const [, contents] = historyFile().load_contents(null);
            const items = JSON.parse(new TextDecoder().decode(contents));
            if (Array.isArray(items))
                this._items = items.filter(t => typeof t === 'string').slice(0, MAX_ITEMS);
        } catch {
            this._items = [];
        }
    }

    _save() {
        const file = historyFile();
        try {
            if (this._items.length === 0) {
                file.delete(null);
                return;
            }
            GLib.mkdir_with_parents(file.get_parent().get_path(), 0o700);
            const bytes = new TextEncoder().encode(JSON.stringify(this._items));
            file.replace_contents(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                logError(e, 'GNOME Next: Failed to save the clipboard history');
        }
    }
}

let instance = null;

export function setClipboardHistory(history) {
    instance = history;
}

export function clipboardHistory() {
    return instance;
}
