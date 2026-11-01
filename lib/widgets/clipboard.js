import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {clipboardHistory} from '../clipboard.js';
import {addPressFeedback} from '../spring.js';
import {Widget, label, placeholder, vbox} from './base.js';

const LIMITS = {small: 1, medium: 2, large: 7};
const COPIED_TIME = 1200; // ms the "Copied" mark stays

// What was copied lately: click an item to copy it again, × to forget it
export const ClipboardWidget = GObject.registerClass(
class GnClipboardWidget extends Widget {
    constructor(size) {
        super(size, {accessible_name: _('Clipboard')});
        this.add_style_class_name('gn-clipboard-widget');
        this._history = clipboardHistory();

        const box = vbox({style_class: 'gn-clipboard-box', x_expand: true, y_expand: true});
        this.child = box;

        const header = new St.BoxLayout({style_class: 'gn-clipboard-header'});
        header.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'gn-clipboard-icon'}));
        header.add_child(label('gn-widget-title', {text: _('Clipboard'), x_expand: true}));
        this._clear = new St.Button({
            style_class: 'button gn-clipboard-clear',
            icon_name: 'edit-clear-all-symbolic',
            accessible_name: _('Clear History'),
            can_focus: true,
        });
        this._clear.connect('clicked', () => this._history?.clear());
        addPressFeedback(this._clear, {scale: 0.85});
        header.add_child(this._clear);
        box.add_child(header);

        this._list = vbox({style_class: 'gn-clipboard-list', x_expand: true, y_expand: true});
        box.add_child(this._list);
        this._placeholder = placeholder('edit-copy-symbolic', _('Copy some text to see it here'));
        box.add_child(this._placeholder);

        this._history?.connectObject('changed', () => this._sync(), this);
        this.connect('destroy', () => {
            this._history?.disconnectObject(this);
            if (this._copiedId)
                GLib.source_remove(this._copiedId);
        });
        this._sync();
    }

    _sync() {
        const items = (this._history?.items ?? []).slice(0, LIMITS[this.widgetSize]);
        this._list.destroy_all_children();
        items.forEach(text => this._list.add_child(this._row(text)));
        this._list.visible = items.length > 0;
        this._placeholder.visible = items.length === 0;
        this._clear.visible = items.length > 0 && !this.small;
    }

    _row(text) {
        const row = new St.BoxLayout({style_class: 'gn-clipboard-row', x_expand: true});
        const button = new St.Button({
            style_class: 'button gn-clipboard-item',
            can_focus: true,
            x_expand: true,
            accessible_name: _('Copy “%s”').format(text.slice(0, 60)),
        });
        const textLabel = new St.Label({
            style_class: 'gn-clipboard-text',
            // One line per item; the small widget shows the latest in full
            text: this.small ? text : text.replace(/\s+/g, ' ').trim(),
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        textLabel.clutter_text.set({
            ellipsize: Pango.EllipsizeMode.END,
            line_wrap: this.small,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
        });
        button.child = textLabel;
        button.connect('clicked', () => {
            this._history?.copy(text);
            this._markCopied(text);
        });
        if (text === this._copied) {
            textLabel.text = _('Copied');
            button.add_style_pseudo_class('checked');
        }
        addPressFeedback(button, {scale: 0.97});
        row.add_child(button);

        if (!this.small) {
            const remove = new St.Button({
                style_class: 'button gn-clipboard-remove',
                icon_name: 'window-close-symbolic',
                accessible_name: _('Remove'),
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            remove.connect('clicked', () => this._history?.remove(text));
            row.add_child(remove);
        }
        return row;
    }

    // The row copied says so for a moment
    _markCopied(text) {
        this._copied = text;
        if (this._copiedId)
            GLib.source_remove(this._copiedId);
        this._copiedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COPIED_TIME, () => {
            this._copiedId = 0;
            this._copied = null;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
        this._sync();
    }

    // The widget itself does nothing on click; its rows do
    activate() {
    }
});
