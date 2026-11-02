import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {clipboardHistory, imageFile} from '../clipboard.js';
import {sizeTag} from '../clipboardPopup.js';
import {addPressFeedback} from '../spring.js';
import {Widget, label, placeholder, vbox} from './base.js';

const LIMITS = {small: 1, medium: 2, large: 7};
const COPIED_TIME = 1200; // ms the "Copied" mark stays

// What was copied lately, text and pictures: click an item to copy it
// again, × to forget it
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
        const all = this._history?.items ?? [];
        // Pinned ones first, as in the popup
        const items = [...all.filter(i => i.pinned), ...all.filter(i => !i.pinned)]
            .slice(0, LIMITS[this.widgetSize]);
        this._list.destroy_all_children();
        items.forEach(item => this._list.add_child(this._row(item)));
        this._list.visible = items.length > 0;
        this._placeholder.visible = items.length === 0;
        this._clear.visible = items.length > 0 && !this.small;
    }

    _key(item) {
        return item.type === 'image' ? `image:${item.hash}` : `text:${item.text}`;
    }

    _row(item) {
        const image = item.type === 'image';
        const row = new St.BoxLayout({style_class: 'gn-clipboard-row', x_expand: true, y_expand: image && this.small});
        const button = new St.Button({
            style_class: `button gn-clipboard-item${image ? ' image' : ''}`,
            can_focus: true,
            x_expand: true,
            y_expand: image && this.small,
            accessible_name: image ? _('Copy Picture') : _('Copy “%s”').format(item.text.slice(0, 60)),
        });

        const copied = this._key(item) === this._copied;
        if (image) {
            // The picture fills the row, cropped; "Copied" shows over it
            const picture = new St.Widget({
                style_class: 'gn-clipboard-picture',
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                y_expand: true,
                style: `background-image: url("${imageFile(item).get_uri().replaceAll('"', '%22')}");`,
            });
            picture.add_child(sizeTag(item));
            if (copied) {
                picture.add_child(new St.Label({
                    style_class: 'gn-clipboard-picture-copied',
                    text: _('Copied'),
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            button.child = picture;
        } else {
            const textLabel = new St.Label({
                style_class: 'gn-clipboard-text',
                // One line per item; the small widget shows the latest in full
                text: copied ? _('Copied') : this.small ? item.text : item.text.replace(/\s+/g, ' ').trim(),
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            textLabel.clutter_text.set({
                ellipsize: Pango.EllipsizeMode.END,
                line_wrap: this.small,
                line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            });
            button.child = textLabel;
        }
        if (copied)
            button.add_style_pseudo_class('checked');
        button.connect('clicked', () => {
            this._history?.copy(item);
            this._markCopied(this._key(item));
        });
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
            remove.connect('clicked', () => this._history?.remove(item));
            row.add_child(remove);
        }
        return row;
    }

    // The row copied says so for a moment
    _markCopied(key) {
        this._copied = key;
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
