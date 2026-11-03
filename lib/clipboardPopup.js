import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {clipboardHistory, imageFile, imageSize} from './clipboard.js';
import {EmojiPanel} from './emojiPanel.js';
import {addPressFeedback, springTo} from './spring.js';

const SHELL_KEYBINDINGS = 'org.gnome.shell.keybindings';
// IBus picks emoji on Super+. as well, and takes the key first while a
// text field has the keyboard
const IBUS_EMOJI = 'org.freedesktop.ibus.panel.emoji';
const TRAY_BINDING = 'toggle-message-tray';
const BINDING_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;
// Time for the window to have the keyboard again before pasting into it
const PASTE_DELAY = 120; // ms
// Time for the window to read an emoji pasted through the clipboard before
// what was there is put back
const RESTORE_DELAY = 400; // ms
// Terminals paste with Ctrl+Shift+V
const TERMINALS = /term|kitty|alacritty|wezterm|foot|konsole|console|ptyxis|tilix|terminator|ghostty|blackbox/i;

const normalize = accel => accel.toLowerCase().replace(/\s/g, '');

// A picture's size in a corner, so a tiny or see-through one does not look
// like an empty item
export function sizeTag(item) {
    const size = imageSize(item);
    return new St.Label({
        style_class: 'gn-clip-size',
        text: size ? `${size[0]} × ${size[1]}` : _('Picture'),
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.END,
    });
}

// The clipboard history at a shortcut, as Super+V on Windows: search it,
// pick with the arrows or the pointer, and Enter or a click pastes into the
// window that had the keyboard. Items can be pinned (they stay) or removed.
// A second tab has the emoji (also on Super+., as Win+.).
export class ClipboardPopup {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        this._takeShortcut();
        const retake = () => {
            this._giveShortcutBack();
            this._takeShortcut();
        };
        this._settings.connectObject(
            'changed::clipboard-shortcut', retake,
            'changed::emoji-shortcut', retake,
            'changed::clipboard-panel-button', () => this._syncButton(),
            this);
        this._syncButton();
    }

    // A button in the top bar that opens the history, for the pointer
    _syncButton() {
        const wanted = this._settings.get_boolean('clipboard-panel-button');
        if (wanted === !!this._button)
            return;
        if (!wanted) {
            this._button.destroy();
            this._button = null;
            return;
        }
        this._button = new PanelMenu.Button(0.5, _('Clipboard History'), true);
        this._button.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        }));
        // The top bar does not take the keyboard, so the item picked is
        // pasted into the window that had it
        this._button.connect('button-press-event', () => {
            this._toggle('clipboard');
            return Clutter.EVENT_STOP;
        });
        this._button.connect('touch-event', (_a, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            this._toggle('clipboard');
            return Clutter.EVENT_STOP;
        });
        Main.panel.addToStatusArea('gn-clipboard', this._button, 0, 'right');
    }

    disable() {
        this._settings.disconnectObject(this);
        this._button?.destroy();
        this._button = null;
        this._close({animate: false});
        this._giveShortcutBack();
        // Turned off by the user (not a lock): IBus gets its keys back
        if (!this._settings.get_boolean('clipboard-popup') && !Main.sessionMode.isLocked)
            this._syncIbusHotkey({release: true});
        this._keyboard = null;
    }

    // Takes the emoji shortcut from IBus' emoji hotkeys, remembering what
    // was taken; gives back what the shortcut no longer uses (or all of it
    // with `release`)
    _syncIbusHotkey({release = false} = {}) {
        const schema = Gio.SettingsSchemaSource.get_default()?.lookup(IBUS_EMOJI, true);
        if (!schema)
            return;
        const ibus = new Gio.Settings({schema_id: IBUS_EMOJI});
        const ours = release ? [] : this._settings.get_strv('emoji-shortcut').map(normalize);
        const taken = this._settings.get_strv('ibus-hotkeys-taken');
        const hotkeys = ibus.get_strv('hotkey');
        const giveBack = taken.filter(accel => !ours.includes(normalize(accel)));
        const take = hotkeys.filter(accel => ours.includes(normalize(accel)));
        if (giveBack.length === 0 && take.length === 0)
            return;
        const next = [...hotkeys.filter(accel => !take.includes(accel)),
            ...giveBack.filter(accel => !hotkeys.includes(accel))];
        ibus.set_strv('hotkey', next);
        this._settings.set_strv('ibus-hotkeys-taken',
            [...taken.filter(accel => !giveBack.includes(accel)), ...take]);
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
            () => this._toggle('clipboard'));
        this._syncIbusHotkey();
        Main.wm.addKeybinding('emoji-shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, BINDING_MODES,
            () => this._toggle('emoji'));
    }

    _giveShortcutBack() {
        Main.wm.removeKeybinding('clipboard-shortcut');
        Main.wm.removeKeybinding('emoji-shortcut');
        if (!this._traySettings)
            return;
        this._traySettings = null;
        Main.wm.removeKeybinding(TRAY_BINDING);
        Main.wm.addKeybinding(TRAY_BINDING, new Gio.Settings({schema_id: SHELL_KEYBINDINGS}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, BINDING_MODES,
            () => Main.wm._toggleCalendar());
    }

    // The same shortcut again closes it; the other one switches tabs
    _toggle(tab = 'clipboard') {
        if (this._root && this._tab === tab)
            this._close();
        else if (this._root)
            this._showTab(tab);
        else
            this._open(tab);
    }

    _open(tab = 'clipboard') {
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
        // Only a press on the backdrop itself: stopping the others here, on
        // their way up, would keep the buttons in the card from seeing the
        // click (St.Button takes clicks through a gesture)
        this._root.connect('button-press-event', (_a, event) => {
            if (global.stage.get_event_actor(event) !== this._root)
                return Clutter.EVENT_PROPAGATE;
            this._close();
            return Clutter.EVENT_STOP;
        });

        // popup-menu-content: Blur my Shell blurs what is behind it, as it
        // does for menus (our own style still sets how it looks)
        this._card = new St.BoxLayout({
            style_class: 'popup-menu-content gn-clip-popup',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this._root.add_child(this._card);

        // Tabs, as on Windows: the clipboard and the emoji
        const header = new St.BoxLayout({style_class: 'gn-clip-popup-header'});
        this._tabs = new Map();
        for (const [id, icon, title] of [
            ['clipboard', 'edit-paste-symbolic', _('History')],
            ['emoji', 'face-smile-big-symbolic', _('Emoji')],
        ]) {
            const box = new St.BoxLayout({style_class: 'gn-clip-popup-tab-box'});
            box.add_child(new St.Icon({icon_name: icon, style_class: 'gn-clip-popup-tab-icon'}));
            box.add_child(new St.Label({text: title, y_align: Clutter.ActorAlign.CENTER}));
            const button = new St.Button({
                style_class: 'button gn-clip-popup-tab',
                child: box,
                toggle_mode: true,
                accessible_name: title,
            });
            button.connect('clicked', () => this._showTab(id));
            header.add_child(button);
            this._tabs.set(id, button);
        }
        header.add_child(new St.Widget({x_expand: true}));
        this._clear = new St.Button({
            style_class: 'button gn-clip-popup-clear',
            label: _('Clear All'),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clear.connect('clicked', () => this._history.clear());
        header.add_child(this._clear);
        this._card.add_child(header);

        this._entry = new St.Entry({
            style_class: 'gn-clip-popup-search',
            hint_text: _('Search'),
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'gn-clip-popup-search-icon'}));
        this._entry.clutter_text.connect('text-changed', () => {
            if (this._tab === 'emoji') {
                this._emoji?.setQuery(this._entry.text);
                return;
            }
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
        this._clipPage = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._clipPage.add_child(this._scroll);
        this._empty = new St.Label({
            style_class: 'gn-clip-popup-empty',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._clipPage.add_child(this._empty);
        this._card.add_child(this._clipPage);
        this._emoji = null;

        Main.layoutManager.addTopChrome(this._root);
        this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});

        this._selected = 0;
        this._history.connectObject('changed', () => this._sync(), this);
        this._sync();
        this._showTab(tab, {animate: false});

        // A third of the way down, centered, popping in
        const [, width] = this._card.get_preferred_width(-1);
        this._card.set_position(Math.round((monitor.width - width) / 2), Math.round(monitor.height * 0.18));
        this._card.set_pivot_point(0.5, 0);
        this._card.set({opacity: 0, scale_x: 0.94, scale_y: 0.94, translation_y: -10});
        this._card.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        springTo(this._card, {scale_x: 1, scale_y: 1, translation_y: 0}, {preset: 'bouncy'});
        this._entry.grab_key_focus();
    }

    _showTab(tab, {animate = true} = {}) {
        if (!this._root)
            return;
        const changed = tab !== this._tab;
        this._tab = tab;
        this._tabs.forEach((button, id) => (button.checked = id === tab));
        const emoji = tab === 'emoji';
        if (emoji && !this._emoji) {
            this._emoji = new EmojiPanel(this._settings);
            this._emoji.connect('emoji-picked', (_p, text) => this._insertText(text));
            this._card.add_child(this._emoji);
        }
        this._clipPage.visible = !emoji;
        if (this._emoji)
            this._emoji.visible = emoji;
        this._clear.visible = !emoji;
        this._entry.hint_text = emoji ? _('Search emoji') : _('Search');
        if (changed && this._entry.text)
            this._entry.text = '';
        const page = emoji ? this._emoji : this._clipPage;
        if (animate && changed && page.mapped) {
            page.set({opacity: 0, translation_x: emoji ? 16 : -16});
            page.ease({
                opacity: 255,
                translation_x: 0,
                duration: 220,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
        this._entry.grab_key_focus();
    }

    _close({animate = true} = {}) {
        if (!this._root)
            return;
        const root = this._root;
        this._root = null;
        this._tab = null;
        this._emoji = null;
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
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                style: `background-image: url("${imageFile(item).get_uri().replaceAll('"', '%22')}");`,
            });
            button.child.add_child(sizeTag(item));
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
        if (key === Clutter.KEY_Escape) {
            this._close();
            return Clutter.EVENT_STOP;
        }
        if (this._tab === 'emoji') {
            const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
            return this._emoji?.handleKey(key, shift) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }
        switch (key) {
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

    // Types `text` (an emoji) into the window that had the keyboard: through
    // the clipboard, which gets back what it had right after
    _insertText(text) {
        const target = this._target;
        const previous = this._history.items[0] ?? null;
        this._history.suspend(PASTE_DELAY + RESTORE_DELAY + 600);
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._close();
        if (!target)
            return;
        const terminal = TERMINALS.test(`${target.get_wm_class() ?? ''} ${target.get_gtk_application_id?.() ?? ''}`);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY, () => {
            if (global.display.focus_window === target)
                this._sendPaste(terminal);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTORE_DELAY, () => {
                if (previous)
                    this._history.setClipboard(previous);
                return GLib.SOURCE_REMOVE;
            });
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
