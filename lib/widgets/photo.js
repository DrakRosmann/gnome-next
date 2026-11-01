import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Widget, closeCalendar, placeholder, vbox} from './base.js';

const EXTENSIONS = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|avif)$/i;
const MAX_FILES = 3000;
const MAX_DEPTH = 3;
const RESCAN_AFTER = 30 * 60; // seconds
const THUMB_SIZE = 640;

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_at_scale_async', 'new_from_stream_finish');

// Pictures found in the user's Pictures folder, shared by all photo widgets
const library = {files: [], scannedAt: 0, scanning: null};

async function scan(dir, depth, files, cancellable) {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES)
        return;
    let enumerator;
    try {
        enumerator = await dir.enumerate_children_async(
            'standard::name,standard::type,standard::is-hidden',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable);
    } catch {
        return;
    }
    const subdirs = [];
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const infos = await enumerator.next_files_async(100, GLib.PRIORITY_LOW, cancellable);
        if (infos.length === 0)
            break;
        for (const info of infos) {
            if (info.get_is_hidden())
                continue;
            const name = info.get_name();
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                subdirs.push(dir.get_child(name));
            else if (EXTENSIONS.test(name) && files.length < MAX_FILES)
                files.push(dir.get_child(name));
        }
    }
    enumerator.close_async(GLib.PRIORITY_LOW, null, null);
    for (const subdir of subdirs) {
        // eslint-disable-next-line no-await-in-loop
        await scan(subdir, depth + 1, files, cancellable);
    }
}

// Not cancellable: other widgets may be waiting for the same scan
function pictures() {
    const now = GLib.get_monotonic_time() / 1e6;
    if (library.scanning)
        return library.scanning;
    if (library.scannedAt && now - library.scannedAt < RESCAN_AFTER)
        return Promise.resolve(library.files);

    const path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
    if (!path)
        return Promise.resolve([]);
    const files = [];
    library.scanning = scan(Gio.File.new_for_path(path), 0, files, null)
        .then(() => {
            library.files = files;
            library.scannedAt = now;
            return files;
        })
        .finally(() => (library.scanning = null));
    return library.scanning;
}

// A small JPEG of the picture in our cache folder: loading the original
// would keep a full-size bitmap in the shell's texture cache
async function thumbnail(file, cancellable) {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-next', 'photos']);
    const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, file.get_uri(), -1);
    const path = GLib.build_filenamev([dir, `${hash}.jpg`]);
    if (GLib.file_test(path, GLib.FileTest.EXISTS))
        return path;

    GLib.mkdir_with_parents(dir, 0o700);
    const stream = await file.read_async(GLib.PRIORITY_LOW, cancellable);
    let pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
        stream, THUMB_SIZE, THUMB_SIZE, true, cancellable);
    stream.close_async(GLib.PRIORITY_LOW, null, null);
    pixbuf = pixbuf.apply_embedded_orientation() ?? pixbuf;
    if (pixbuf.get_has_alpha()) {
        // JPEG has no alpha: flatten onto black
        pixbuf = pixbuf.composite_color_simple(pixbuf.get_width(), pixbuf.get_height(),
            GdkPixbuf.InterpType.BILINEAR, 255, 32, 0, 0);
    }
    pixbuf.savev(path, 'jpeg', ['quality'], ['85']);
    return path;
}

// A random picture from the Pictures folder, a new one each time the
// calendar opens
export const PhotoWidget = GObject.registerClass(
class GnPhotoWidget extends Widget {
    constructor(size) {
        super(size, {accessible_name: _('Photo')});
        this.add_style_class_name('gn-photo-widget');
        this._cancellable = new Gio.Cancellable();

        const box = vbox({x_expand: true, y_expand: true});
        this.child = box;
        this._placeholder = placeholder('folder-pictures-symbolic', _('Add pictures to your Pictures folder'));
        box.add_child(this._placeholder);

        this.empty = true;
        this.connect('notify::mapped', () => {
            if (this.mapped)
                this._next();
        });
        this.connect('destroy', () => this._cancellable.cancel());
        this._next();
    }

    async _next() {
        try {
            const files = await pictures();
            if (this._cancellable.is_cancelled())
                return;
            this.empty = files.length === 0;
            this._placeholder.visible = this.empty;
            if (this.empty) {
                this.style = null;
                return;
            }
            // Try a few in case some cannot be decoded
            for (let attempt = 0; attempt < 5; attempt++) {
                const file = files[Math.floor(Math.random() * files.length)];
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const path = await thumbnail(file, this._cancellable);
                    this._file = file;
                    if (this._cancellable.is_cancelled())
                        return;
                    this.style = `background-image: url("${GLib.filename_to_uri(path, null)}");`;
                    return;
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                }
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'GNOME Next: Failed to load a photo');
        }
    }

    activate() {
        if (!this._file)
            return;
        closeCalendar();
        Gio.AppInfo.launch_default_for_uri(this._file.get_uri(), global.create_app_launch_context(0, -1));
    }
});

export function clearPhotoLibrary() {
    library.files = [];
    library.scannedAt = 0;
}
