import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Widget, label, vbox} from './base.js';

const SAVE_DELAY = 400; // ms

// A sticky note. The text is kept in the extension settings, so every copy
// of the widget (and the next login) shows the same note.
export const NotesWidget = GObject.registerClass(
class GnNotesWidget extends Widget {
    constructor(size, {settings}) {
        super(size, {accessible_name: _('Note')});
        this.add_style_class_name('gn-notes-widget');
        this._settings = settings;

        const box = vbox({x_expand: true, y_expand: true});
        this.child = box;
        box.add_child(label('gn-widget-title gn-notes-title', {text: _('Note')}));

        this._entry = new St.Entry({
            style_class: 'gn-notes-entry',
            hint_text: _('Write something…'),
            can_focus: true,
            x_expand: true,
            y_expand: true,
        });
        this._entry.clutter_text.set({
            single_line_mode: false,
            activatable: false,
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            y_align: Clutter.ActorAlign.START,
        });
        const scroll = new St.ScrollView({
            style_class: 'gn-notes-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: new St.Viewport({layout_manager: new Clutter.BinLayout()}),
        });
        scroll.child.add_child(this._entry);
        box.add_child(scroll);

        this._entry.text = settings.get_string('note-text');
        this._entry.clutter_text.connect('text-changed', () => this._queueSave());
        settings.connectObject('changed::note-text', () => {
            // Another copy of the note changed it
            const text = settings.get_string('note-text');
            if (!this._saveId && text !== this._entry.text)
                this._entry.text = text;
        }, this);

        this.connect('destroy', () => {
            this._save();
            settings.disconnectObject(this);
        });
    }

    _queueSave() {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _save() {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = 0;
        const text = this._entry.text;
        if (text !== this._settings.get_string('note-text'))
            this._settings.set_string('note-text', text);
    }

    activate() {
        this._entry.grab_key_focus();
        const text = this._entry.clutter_text;
        text.set_cursor_position(-1);
    }
});
