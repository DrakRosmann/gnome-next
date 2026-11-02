import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const MAX_ITEMS = 30;
const MAX_LENGTH = 8000; // characters kept of each copy
const MAX_IMAGE_SIZE = 16 * 1024 * 1024; // bytes
const IMAGE_TYPE = 'image/png';
const TEXT_TYPES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING'];
// Password managers mark what they copy with this (KeePassXC, Bitwarden…)
const SECRET_HINT = 'x-kde-passwordManagerHint';

function cacheDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-next']);
}

function historyFile() {
    return Gio.File.new_for_path(GLib.build_filenamev([cacheDir(), 'clipboard.json']));
}

export function imageFile(item) {
    return Gio.File.new_for_path(GLib.build_filenamev([cacheDir(), 'clipboard', `${item.hash}.png`]));
}

const sameItem = (a, b) => a.type === b.type && (a.type === 'image' ? a.hash === b.hash : a.text === b.text);

// Text and pictures copied lately, newest first: {type: 'text', text} or
// {type: 'image', hash}, with the picture in a file named by its hash. It is
// only kept while the clipboard widget is on the board, in files only the
// user can read, so it lasts through a lock (which disables the extension).
export class ClipboardHistory extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._items = [];
        this._watching = false;
    }

    enable() {
        this._settings.connectObject(
            'changed::widgets', () => this._syncWatching(),
            'changed::clipboard-popup', () => this._syncWatching(),
            this);
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

    // Kept while the widget is on the board or the history popup is on
    _wanted() {
        return this._settings.get_boolean('clipboard-popup') ||
            this._settings.get_strv('widgets').some(entry => entry.startsWith('clipboard:'));
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
            // Turning both off forgets what they kept, pinned items too
            this.clear({pinned: true});
        }
    }

    _stopWatching() {
        if (!this._watching)
            return;
        this._watching = false;
        global.display.get_selection().disconnectObject(this);
    }

    // Text when there is text (a spreadsheet copies both), else a picture
    _read() {
        const clipboard = St.Clipboard.get_default();
        const types = clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
        if (types.includes(SECRET_HINT))
            return;

        if (types.some(t => TEXT_TYPES.includes(t)) || !types.includes(IMAGE_TYPE)) {
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
                if (text?.trim() && this._watching)
                    this._push({type: 'text', text: text.slice(0, MAX_LENGTH)});
            });
            return;
        }

        clipboard.get_content(St.ClipboardType.CLIPBOARD, IMAGE_TYPE, (_c, bytes) => {
            const size = bytes?.get_size() ?? 0;
            if (!this._watching || size === 0 || size > MAX_IMAGE_SIZE)
                return;
            const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
            const item = {type: 'image', hash};
            try {
                const file = imageFile(item);
                if (!file.query_exists(null)) {
                    GLib.mkdir_with_parents(file.get_parent().get_path(), 0o700);
                    file.replace_contents(bytes.toArray(), null, false, Gio.FileCreateFlags.PRIVATE, null);
                }
            } catch (e) {
                logError(e, 'GNOME Next: Failed to keep a copied picture');
                return;
            }
            this._push(item);
        });
    }

    // Newest first; pinned items stay, whatever comes after them
    _push(item) {
        if (this._items[0] && sameItem(this._items[0], item))
            return;
        const old = this._items.find(i => sameItem(i, item));
        const items = [{...item, pinned: old?.pinned ?? item.pinned ?? false},
            ...this._items.filter(i => !sameItem(i, item))];
        let unpinned = 0;
        const kept = items.filter(i => i.pinned || ++unpinned <= MAX_ITEMS);
        const evicted = items.filter(i => !kept.includes(i));
        this._items = kept;
        evicted.forEach(i => this._forget(i));
        this._changed();
    }

    togglePin(item) {
        const found = this._items.find(i => sameItem(i, item));
        if (!found)
            return;
        found.pinned = !found.pinned;
        this._changed();
    }

    // Puts `item` back on the clipboard; it moves to the top
    copy(item) {
        const clipboard = St.Clipboard.get_default();
        if (item.type === 'image') {
            try {
                const [, contents] = imageFile(item).load_contents(null);
                clipboard.set_content(St.ClipboardType.CLIPBOARD, IMAGE_TYPE, new GLib.Bytes(contents));
            } catch (e) {
                logError(e, 'GNOME Next: Failed to copy a picture');
                this.remove(item);
                return;
            }
        } else {
            clipboard.set_text(St.ClipboardType.CLIPBOARD, item.text);
        }
        this._push(item);
    }

    remove(item) {
        this._items = this._items.filter(i => !sameItem(i, item));
        this._forget(item);
        this._changed();
    }

    // Pinned items stay unless `pinned`, as on Windows
    clear({pinned = false} = {}) {
        const gone = this._items.filter(i => pinned || !i.pinned);
        if (gone.length === 0)
            return;
        this._items = this._items.filter(i => !gone.includes(i));
        gone.forEach(i => this._forget(i));
        this._changed();
    }

    _forget(item) {
        if (item.type !== 'image' || this._items.some(i => sameItem(i, item)))
            return;
        try {
            imageFile(item).delete(null);
        } catch {}
    }

    _changed() {
        this._save();
        this.emit('changed');
    }

    _load() {
        try {
            const [, contents] = historyFile().load_contents(null);
            const items = JSON.parse(new TextDecoder().decode(contents));
            this._items = (Array.isArray(items) ? items : [])
                // Older versions kept plain strings
                .map(i => (typeof i === 'string' ? {type: 'text', text: i} : i))
                .filter(i => i?.type === 'text' && typeof i.text === 'string' ||
                    i?.type === 'image' && /^[0-9a-f]+$/.test(i.hash ?? '') && imageFile(i).query_exists(null))
                .slice(0, MAX_ITEMS);
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
