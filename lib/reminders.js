import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {formatDateWithCFormatString, formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {parseReminder} from './reminderTime.js';

export {parseReminder};

const SNOOZE = 10 * 60; // seconds
const MAX_WAIT = 60; // seconds; timeouts stop while suspended, so check often

// Reminders are stored as JSON objects, one per string: {id, text, due,
// notified}, with `due` in Unix seconds (0 for none). Plain strings from
// older versions are reminders without a time.
export function readReminders(settings) {
    return settings.get_strv('reminders').map((entry, i) => {
        try {
            const r = JSON.parse(entry);
            if (typeof r?.text === 'string') {
                return {
                    id: String(r.id ?? `r${i}`),
                    text: r.text,
                    due: Number(r.due) || 0,
                    notified: Boolean(r.notified),
                };
            }
        } catch {}
        return {id: `legacy-${i}`, text: entry, due: 0, notified: false};
    });
}

export function writeReminders(settings, reminders) {
    settings.set_strv('reminders', reminders.map(({id, text, due, notified}) =>
        JSON.stringify(due ? {id, text, due, notified} : {id, text})));
}

export function newReminder(input) {
    const {text, due} = parseReminder(input);
    return {id: GLib.uuid_string_random().slice(0, 8), text, due, notified: false};
}

// Timed reminders first, soonest first; the others in the order added
export function sortReminders(reminders) {
    const timed = reminders.filter(r => r.due).sort((a, b) => a.due - b.due);
    return [...timed, ...reminders.filter(r => !r.due)];
}

function nowUnix() {
    return GLib.DateTime.new_now_local().to_unix();
}

function dayNumber(dateTime) {
    return Math.round(GLib.DateTime.new_local(dateTime.get_year(), dateTime.get_month(),
        dateTime.get_day_of_month(), 12, 0, 0).to_unix() / 86400);
}

// "09:00", "Amanhã, 09:00", "Sex, 09:00", "25 de dez, 09:00"
export function formatDue(due, now = GLib.DateTime.new_now_local()) {
    const date = GLib.DateTime.new_from_unix_local(due);
    const time = formatTime(date, {timeOnly: true});
    const days = dayNumber(date) - dayNumber(now);
    if (days === 0)
        return time;
    if (days === 1)
        return _('Tomorrow, %s').format(time);
    if (days === -1)
        return _('Yesterday, %s').format(time);
    const jsDate = new Date(due * 1000);
    let day;
    if (days > 1 && days < 7)
        day = formatDateWithCFormatString(jsDate, '%a');
    else if (date.get_year() === now.get_year())
        /* Translators: day and month of a reminder, see strftime(3) */
        day = formatDateWithCFormatString(jsDate, _('%-d %b'));
    else
        /* Translators: day, month and year of a reminder, see strftime(3) */
        day = formatDateWithCFormatString(jsDate, _('%-d %b %Y'));
    return `${day[0].toLocaleUpperCase()}${day.slice(1)}, ${time}`;
}

export function isOverdue(reminder) {
    return reminder.due > 0 && reminder.due <= nowUnix();
}

// Shows a notification when a reminder is due, including those that came due
// while logged out
export class ReminderScheduler {
    constructor(settings) {
        this._settings = settings;
        this._timeoutId = 0;
        this._notifications = new Map(); // reminder id -> notification
        this._source = null;
    }

    enable() {
        this._settings.connectObject('changed::reminders', () => this._check(), this);
        this._check();
    }

    disable() {
        this._settings.disconnectObject(this);
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._source?.destroy();
        this._source = null;
        this._notifications.clear();
    }

    _check() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;

        const now = nowUnix();
        const reminders = readReminders(this._settings);

        // Completed, removed or snoozed elsewhere
        for (const [id, notification] of this._notifications) {
            if (!reminders.some(r => r.id === id && r.notified))
                notification.destroy();
        }

        const due = reminders.filter(r => r.due && !r.notified && r.due <= now);
        if (due.length > 0) {
            due.forEach(r => {
                r.notified = true;
                this._notify(r);
            });
            // Comes back through changed::reminders
            writeReminders(this._settings, reminders);
            return;
        }

        const next = Math.min(...reminders.filter(r => r.due && !r.notified).map(r => r.due));
        if (!Number.isFinite(next))
            return;
        const wait = Math.min(Math.max(next - now, 1), MAX_WAIT);
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, wait, () => {
            this._timeoutId = 0;
            this._check();
            return GLib.SOURCE_REMOVE;
        });
    }

    _notify(reminder) {
        if (!this._source) {
            this._source = new MessageTray.Source({
                title: _('Reminders'),
                iconName: 'alarm-symbolic',
            });
            this._source.connect('destroy', () => (this._source = null));
            Main.messageTray.add(this._source);
        }

        this._notifications.get(reminder.id)?.destroy();
        const notification = new MessageTray.Notification({
            source: this._source,
            title: reminder.text,
            body: formatDue(reminder.due),
            urgency: MessageTray.Urgency.HIGH,
            sound: new MessageTray.Sound(null, 'alarm-clock-elapsed'),
        });
        notification.addAction(_('Complete'), () => this._change(reminder.id, null));
        notification.addAction(_('Snooze 10 min'), () =>
            this._change(reminder.id, {due: nowUnix() + SNOOZE, notified: false}));
        notification.connect('activated', () => Main.panel.statusArea.dateMenu?.menu.open());
        notification.connect('destroy', () => {
            if (this._notifications.get(reminder.id) === notification)
                this._notifications.delete(reminder.id);
        });
        this._notifications.set(reminder.id, notification);
        this._source.addNotification(notification);
    }

    // Removes the reminder (`changes` null) or updates it
    _change(id, changes) {
        // The notification goes away by itself after the action
        this._notifications.delete(id);
        const reminders = readReminders(this._settings);
        const index = reminders.findIndex(r => r.id === id);
        if (index < 0)
            return;
        if (changes)
            Object.assign(reminders[index], changes);
        else
            reminders.splice(index, 1);
        writeReminders(this._settings, reminders);
    }
}
