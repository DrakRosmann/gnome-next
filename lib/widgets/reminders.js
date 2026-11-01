import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    formatDue, isOverdue, newReminder, parseReminder, readReminders, sortReminders, writeReminders,
} from '../reminders.js';
import {Widget, label, vbox} from './base.js';

// Rows that fit above the entry; the header shows the total
const LIMITS = {small: 2, medium: 2, large: 8};
const COMPLETE_DELAY = 1500; // ms a checked reminder stays before it goes
const REFRESH = 30; // seconds, for "overdue" and the day names

// A to-do list. Reminders live in the extension settings; a time typed with
// the text ("amanhã 9h", "em 20 min") makes a notification come up then (see
// ReminderScheduler). Checking one strikes it through and removes it a moment
// later (unless unchecked).
export const RemindersWidget = GObject.registerClass(
class GnRemindersWidget extends Widget {
    constructor(size, {settings}) {
        super(size, {accessible_name: _('Reminders')});
        this.add_style_class_name('gn-reminders-widget');
        this._settings = settings;
        this._completing = new Map(); // reminder id -> timeout id
        this._shown = null;

        const box = vbox({style_class: 'gn-reminders-box', x_expand: true, y_expand: true});
        this.child = box;

        const header = new St.BoxLayout({style_class: 'gn-reminders-header'});
        header.add_child(label('gn-widget-title gn-reminders-title', {text: _('Reminders'), x_expand: true}));
        this._count = new St.Label({style_class: 'gn-reminders-count'});
        header.add_child(this._count);
        // When the reminder being typed has a time
        this._preview = new St.BoxLayout({style_class: 'gn-reminders-preview', visible: false});
        this._preview.add_child(new St.Icon({icon_name: 'alarm-symbolic', style_class: 'gn-reminders-preview-icon'}));
        this._previewLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._preview.add_child(this._previewLabel);
        header.add_child(this._preview);
        box.add_child(header);

        this._list = vbox({style_class: 'gn-reminders-list', x_expand: true, y_expand: true});
        box.add_child(this._list);

        this._entry = new St.Entry({
            style_class: 'gn-reminders-entry',
            hint_text: this.small ? _('New reminder') : _('New reminder, e.g. “tomorrow 9am”'),
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({icon_name: 'list-add-symbolic', style_class: 'gn-reminders-add-icon'}));
        this._entry.clutter_text.connect('activate', () => this._add());
        this._entry.clutter_text.connect('text-changed', () => this._syncPreview());
        box.add_child(this._entry);

        settings.connectObject('changed::reminders', () => this._sync(), this);
        this.connect('destroy', () => {
            settings.disconnectObject(this);
            // Finish what was checked
            const done = [...this._completing.keys()];
            this._completing.forEach(id => GLib.source_remove(id));
            this._completing.clear();
            if (done.length)
                writeReminders(settings, readReminders(settings).filter(r => !done.includes(r.id)));
        });
        this._sync();
        this.poll(REFRESH, () => this._sync());
    }

    _add() {
        if (!this._entry.text.trim())
            return;
        const reminder = newReminder(this._entry.text);
        this._entry.text = '';
        writeReminders(this._settings, [...readReminders(this._settings), reminder]);
    }

    _syncPreview() {
        const {due} = this._entry.text.trim() ? parseReminder(this._entry.text) : {due: 0};
        this._preview.visible = due > 0;
        this._count.visible = !this._preview.visible;
        if (due)
            this._previewLabel.text = formatDue(due);
    }

    _toggle(id, check) {
        const timeoutId = this._completing.get(id);
        if (timeoutId) {
            GLib.source_remove(timeoutId);
            this._completing.delete(id);
            check.checked = false;
            return;
        }
        check.checked = true;
        this._completing.set(id, GLib.timeout_add(GLib.PRIORITY_DEFAULT, COMPLETE_DELAY, () => {
            this._completing.delete(id);
            writeReminders(this._settings, readReminders(this._settings).filter(r => r.id !== id));
            return GLib.SOURCE_REMOVE;
        }));
    }

    _sync() {
        const reminders = sortReminders(readReminders(this._settings));
        const shown = reminders.slice(0, LIMITS[this.widgetSize]).map(r => ({
            ...r,
            when: r.due ? formatDue(r.due) : '',
            overdue: isOverdue(r),
        }));
        // Polled: rebuild only when something visible changed
        const key = JSON.stringify([reminders.length, shown]);
        if (key === this._shown)
            return;
        this._shown = key;

        this._list.destroy_all_children();
        this._count.text = reminders.length ? `${reminders.length}` : '';

        for (const reminder of shown) {
            const row = new St.BoxLayout({style_class: 'gn-reminder', x_expand: true});
            const check = new St.Button({
                style_class: 'gn-reminder-check',
                child: new St.Icon({icon_name: 'object-select-symbolic', style_class: 'gn-reminder-check-icon'}),
                can_focus: true,
                accessible_name: _('Complete %s').format(reminder.text),
                y_align: Clutter.ActorAlign.CENTER,
            });
            const title = label('gn-reminder-text', {
                text: reminder.text,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            check.connect('notify::checked', () => {
                if (check.checked)
                    title.add_style_pseudo_class('checked');
                else
                    title.remove_style_pseudo_class('checked');
            });
            check.checked = this._completing.has(reminder.id);
            check.connect('clicked', () => {
                this._toggle(reminder.id, check);
                return Clutter.EVENT_STOP;
            });
            if (reminder.overdue)
                title.add_style_class_name('overdue');
            row.add_child(check);
            row.add_child(title);
            // No room for it in the small size
            if (reminder.when && !this.small) {
                const when = new St.Label({
                    style_class: `gn-reminder-due${reminder.overdue ? ' overdue' : ''}`,
                    text: reminder.when,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(when);
            }
            this._list.add_child(row);
        }

        if (reminders.length === 0 && !this.small) {
            this._list.add_child(label('gn-widget-dim gn-reminders-none', {
                text: _('Nothing to do'),
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
    }

    activate() {
        this._entry.grab_key_focus();
    }
});
