import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {clipboardHistory, imageFile} from './clipboard.js';
import {addPressFeedback, springTo} from './spring.js';

const SHELL_KEYBINDINGS = 'org.gnome.shell.keybindings';
const TRAY_BINDING = 'toggle-message-tray';
const BINDING_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;
// Time for the window to have the keyboard again before pasting into it
const PASTE_DELAY = 120; // ms
// Terminals paste with Ctrl+Shift+V
const TERMINALS = /term|kitty|alacritty|wezterm|foot|konsole|console|ptyxis|tilix|terminator|ghostty|blackbox/i;

const normalize = accel => accel.toLowerCase().replace(/\s/g, '');

// The clipboard history at a shortcut, as Super+V on Windows: search it,
// pick with the arrows or the pointer, and Enter or a click pastes into the
// window that had the keyboard. Items can be pinned (they stay) or removed.
export class ClipboardPopup {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        this._takeShortcut();
        this._settings.connectObject('changed::clipboard-shortcut', () => {
            this._giveShortcutBack();
            this._takeShortcut();
        }, this);
    }

    disable() {
        this._settings.disconnectObject(this);
        this._close({animate: false});
        this._giveShortcutBack();
        this._keyboard = null;
    }

    // The shell's notification list shortcut shares Super+V: it keeps its
    // other keys, read from a copy of its settings kept in memory, so the
    // user's own settings are left alone
    _takeShortcut() {
        const ours = this._settings.get_strv('clipboard-shortcut').map(normalize);
        const shellKeys = new Gio.Settings({schema_id: SHELL_KEYBINDINGS});
        const trayKeys = shellKeys.get_strv(TRAY_BINDING);
        const kept = trayKeys.filter(accel => !ours.includes(normalize(accel)));
        if (kept.length !== trayKeys.length) {
            Main.wm.removeKeybinding(TRAY_BINDING);
            this._traySettings = new Gio.Settings({
                schema_id: SHELL_KEYBINDINGS,
                backend: Gio.memory_settings_backend_new(),
            });
            this._traySettings.set_strv(TRAY_BINDING, kept);
            Main.wm.addKeybinding(TRAY_BINDING, this._traySettings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, BINDING_MODES,
                () => Main.wm._toggleCalendar());
        }
        Main.wm.addKeybinding('clipboard-shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, BINDING_MODES,
            () => this._toggle());
    }

    _giveShortcutBack() {
        Main.wm.removeKeybinding('clipboard-shortcut');
        if (!this._traySettings)
            return;
        this._traySettings = null;
        Main.wm.removeKeybinding(TRAY_BINDING);
        Main.wm.addKeybinding(TRAY_BINDING, new Gio.Settings({schema_id: SHELL_KEYBINDINGS}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, BINDING_MODES,
            () => Main.wm._toggleCalendar());
    }

    _toggle() {
        if (this._root)
            this._close();
        else
            this._open();
    }

    _open() {
        const history = clipboardHistory();
        if (!history)
            return;
        this._history = history;
        this._target = global.display.focus_window;

        const monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        // Clicking anywhere around the card closes it
        this._root = new St.Widget({
            reactive: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });
        this._root.connect('button-press-event', (_a, event) => {
            if (global.stage.get_event_actor(event) === this._root)
                this._close();
            return Clutter.EVENT_STOP;
        });

        this._card = new St.BoxLayout({
            style_class: 'gn-clip-popup',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this._root.add_child(this._card);

        const header = new St.BoxLayout({style_class: 'gn-clip-popup-header'});
        header.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'gn-clip-popup-icon'}));
        header.add_child(new St.Label({
            style_class: 'gn-clip-popup-title',
            text: _('Clipboard'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const clear = new St.Button({
            style_class: 'button gn-clip-popup-clear',
            label: _('Clear All'),
            can_focus: true,
        });
        clear.connect('clicked', () => this._history.clear());
        header.add_child(clear);
        this._card.add_child(header);

        this._entry = new St.Entry({
            style_class: 'gn-clip-popup-search',
            hint_text: _('Search'),
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'gn-clip-popup-search-icon'}));
        this._entry.clutter_text.connect('text-changed', () => {
            this._selected = 0;
            this._sync();
        });
        // Keys are taken on their way to the search: the text field keeps
        // Enter and the arrows to itself (and to an input method)
        this._root.connect('captured-event', (_a, event) =>
            event.type() === Clutter.EventType.KEY_PRESS ? this._onKey(event) : Clutter.EVENT_PROPAGATE);
        this._card.add_child(this._entry);

        this._list = new St.BoxLayout({
            style_class: 'gn-clip-popup-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'gn-clip-popup-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._list,
        });
        this._card.add_child(this._scroll);
        this._empty = new St.Label({
            style_class: 'gn-clip-popup-empty',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._card.add_child(this._empty);

        Main.layoutManager.addTopChrome(this._root);
        this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});

        this._selected = 0;
        this._history.connectObject('changed', () => this._sync(), this);
        this._sync();

        // A third of the way down, centered, popping in
        const [, width] = this._card.get_preferred_width(-1);
        this._card.set_position(Math.round((monitor.width - width) / 2), Math.round(monitor.height * 0.18));
        this._card.set_pivot_point(0.5, 0);
        this._card.set({opacity: 0, scale_x: 0.94, scale_y: 0.94, translation_y: -10});
        this._card.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        springTo(this._card, {scale_x: 1, scale_y: 1, translation_y: 0}, {preset: 'bouncy'});
        this._entry.grab_key_focus();
    }

    _close({animate = true} = {}) {
        if (!this._root)
            return;
        const root = this._root;
        this._root = null;
        this._history?.disconnectObject(this);
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        const destroy = () => root.destroy();
        if (!animate || !this._card.mapped) {
            destroy();
            return;
        }
        root.reactive = false;
        this._card.ease({
            opacity: 0,
            scale_x: 0.96,
            scale_y: 0.96,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: destroy,
        });
    }

    _visibleItems() {
        const query = this._entry.text.trim().toLowerCase();
        const items = this._history.items.filter(i =>
            !query || i.type === 'text' && i.text.toLowerCase().includes(query));
        // Pinned ones first, each group newest first
        return [...items.filter(i => i.pinned), ...items.filter(i => !i.pinned)];
    }

    _sync() {
        if (!this._root)
            return;
        this._items = this._visibleItems();
        this._selected = Math.clamp(this._selected, 0, Math.max(0, this._items.length - 1));
        this._list.destroy_all_children();
        this._items.forEach((item, i) => this._list.add_child(this._row(item, i)));
        this._empty.text = this._history.items.length === 0
            ? _('Copy some text or a picture to see it here')
            : _('Nothing matches');
        this._empty.visible = this._items.length === 0;
        this._scroll.visible = this._items.length > 0;
    }

    _row(item, index) {
        const row = new St.BoxLayout({style_class: 'gn-clip-popup-row', x_expand: true});
        const button = new St.Button({
            style_class: `button gn-clip-popup-item${item.type === 'image' ? ' image' : ''}`,
            x_expand: true,
            can_focus: false,
        });
        if (index === this._selected)
            button.add_style_pseudo_class('selected');

        if (item.type === 'image') {
            button.child = new St.Widget({
                style_class: 'gn-clip-popup-picture',
                x_expand: true,
                style: `background-image: url("${imageFile(item).get_uri().replaceAll('"', '%22')}");`,
            });
        } else {
            const label = new St.Label({
                style_class: 'gn-clip-popup-text',
                text: item.text.length > 400 ? `${item.text.slice(0, 400)}…` : item.text,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            label.clutter_text.set({
                line_wrap: true,
                line_wrap_mode: Pango.WrapMode.WORD_CHAR,
                ellipsize: Pango.EllipsizeMode.END,
            });
            button.child = label;
        }
        button.connect('clicked', () => this._paste(item));
        button.connect('notify::hover', () => {
            if (button.hover && this._selected !== index) {
                this._selected = index;
                this._syncSelection();
            }
        });
        row.add_child(button);

        const actions = new St.BoxLayout({
            style_class: 'gn-clip-popup-actions',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const pin = new St.Button({
            style_class: 'button gn-clip-popup-action',
            icon_name: 'view-pin-symbolic',
            accessible_name: item.pinned ? _('Unpin') : _('Pin'),
            toggle_mode: true,
            checked: !!item.pinned,
        });
        pin.connect('clicked', () => this._history.togglePin(item));
        addPressFeedback(pin, {scale: 0.85});
        actions.add_child(pin);
        const remove = new St.Button({
            style_class: 'button gn-clip-popup-action',
            icon_name: 'user-trash-symbolic',
            accessible_name: _('Remove'),
        });
        remove.connect('clicked', () => this._history.remove(item));
        addPressFeedback(remove, {scale: 0.85});
        actions.add_child(remove);
        row.add_child(actions);
        return row;
    }

    _syncSelection() {
        this._list.get_children().forEach((row, i) => {
            const button = row.get_first_child();
            if (i === this._selected)
                button.add_style_pseudo_class('selected');
            else
                button.remove_style_pseudo_class('selected');
        });
        // Keep the selected one in view
        const row = this._list.get_child_at_index(this._selected);
        if (row?.has_allocation()) {
            const box = row.get_allocation_box();
            const adjustment = this._scroll.vadjustment;
            if (box.y1 < adjustment.value)
                adjustment.value = box.y1;
            else if (box.y2 > adjustment.value + adjustment.page_size)
                adjustment.value = box.y2 - adjustment.page_size;
        }
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        switch (key) {
        case Clutter.KEY_Escape:
            this._close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
        case Clutter.KEY_Up:
            if (this._items.length > 0) {
                const step = key === Clutter.KEY_Down ? 1 : -1;
                this._selected = (this._selected + step + this._items.length) % this._items.length;
                this._syncSelection();
            }
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter: {
            const item = this._items[this._selected];
            if (item)
                this._paste(item);
            return Clutter.EVENT_STOP;
        }
        case Clutter.KEY_Delete:
            if (this._entry.text === '' && this._items[this._selected])
                this._history.remove(this._items[this._selected]);
            return this._entry.text === '' ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    // Puts the item on the clipboard and pastes it into the window that had
    // the keyboard, with Ctrl+V (Ctrl+Shift+V in a terminal)
    _paste(item) {
        this._history.copy(item);
        const target = this._target;
        this._close();
        if (!target)
            return;
        const terminal = TERMINALS.test(`${target.get_wm_class() ?? ''} ${target.get_gtk_application_id?.() ?? ''}`);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY, () => {
            if (global.display.focus_window === target)
                this._sendPaste(terminal);
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendPaste(shift) {
        this._keyboard ??= global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const time = () => GLib.get_monotonic_time();
        const keys = [Clutter.KEY_Control_L, ...shift ? [Clutter.KEY_Shift_L] : [], Clutter.KEY_v];
        keys.forEach(k => this._keyboard.notify_keyval(time(), k, Clutter.KeyState.PRESSED));
        [...keys].reverse().forEach(k => this._keyboard.notify_keyval(time(), k, Clutter.KeyState.RELEASED));
    }
}
