import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {formatDateWithCFormatString, formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Widget, capitalize, label, openCalendarApp, vbox} from './base.js';

const LIMITS = {small: 1, medium: 3, large: 7};

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

// Today's remaining events (and tomorrow's in the large size). Events come
// from the shell's calendar source, which loads the month the calendar shows.
export const EventsWidget = GObject.registerClass(
class GnEventsWidget extends Widget {
    constructor(size, {eventSource, wallClock}) {
        super(size, {accessible_name: _('Up Next')});
        this.add_style_class_name('gn-events-widget');
        this._getSource = eventSource;

        const box = new St.BoxLayout({x_expand: true, y_expand: true});
        if (this.small)
            box.orientation = Clutter.Orientation.VERTICAL;
        this.child = box;

        const date = vbox({style_class: 'gn-events-date'});
        this._weekday = label('gn-events-weekday');
        date.add_child(this._weekday);
        this._day = label('gn-events-day');
        date.add_child(this._day);
        box.add_child(date);

        this._list = vbox({style_class: 'gn-events-list', x_expand: true, y_expand: true});
        box.add_child(this._list);

        this._wallClock = wallClock;
        wallClock?.connectObject('notify::clock', () => this._sync(), this);
        this.connect('notify::mapped', () => this._connectSource());
        this.connect('destroy', () => {
            this._wallClock?.disconnectObject(this);
            this._source?.disconnectObject(this);
        });
        this._connectSource();
    }

    // The shell replaces its event source when the session mode changes
    _connectSource() {
        const source = this._getSource?.() ?? null;
        if (source !== this._source) {
            this._source?.disconnectObject(this);
            this._source = source;
            source?.connectObject('changed', () => this._sync(), this);
        }
        this._sync();
    }

    _events(day, from) {
        if (!this._source)
            return [];
        return this._source.getEvents(day, addDays(day, 1))
            .filter(e => e.end > from || e.date.getTime() === e.end.getTime() && e.date >= from)
            .sort((a, b) => a.date - b.date);
    }

    _sync() {
        const now = new Date();
        const today = startOfDay(now);
        this._weekday.text = capitalize(formatDateWithCFormatString(now, '%A'));
        this._day.text = formatDateWithCFormatString(now, '%-d');

        this._list.destroy_all_children();
        const limit = LIMITS[this.widgetSize];
        const todays = this._events(today, now).slice(0, limit);
        todays.forEach(e => this._list.add_child(this._row(e, today)));

        if (this.large && todays.length < limit) {
            const tomorrow = addDays(today, 1);
            const next = this._events(tomorrow, tomorrow).slice(0, limit - todays.length);
            if (next.length > 0) {
                this._list.add_child(label('gn-events-section', {text: _('Tomorrow')}));
                next.forEach(e => this._list.add_child(this._row(e, tomorrow)));
            }
        }

        if (this._list.get_n_children() === 0) {
            const none = new St.Label({
                style_class: 'gn-widget-dim gn-events-none',
                text: _('No more events today'),
                y_expand: !this.small,
                y_align: this.small ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
            });
            none.clutter_text.set({line_wrap: true, ellipsize: Pango.EllipsizeMode.NONE});
            this._list.add_child(none);
        }
    }

    _row(event, day) {
        const row = new St.BoxLayout({style_class: 'gn-events-row', x_expand: true});
        row.add_child(new St.Widget({style_class: 'gn-events-bar'}));
        const text = vbox({x_expand: true});
        text.add_child(label('gn-events-title', {text: event.summary ?? ''}));
        text.add_child(label('gn-widget-dim gn-events-time', {text: this._time(event, day)}));
        row.add_child(text);
        return row;
    }

    _time(event, day) {
        const end = addDays(day, 1);
        if (event.date <= day && event.end >= end)
            return _('All Day');
        const start = formatTime(event.date, {timeOnly: true});
        if (event.date < day)
            return _('Until %s').format(formatTime(event.end, {timeOnly: true}));
        if (event.end.getTime() === event.date.getTime() || event.end > end)
            return start;
        return `${start} – ${formatTime(event.end, {timeOnly: true})}`;
    }

    activate() {
        openCalendarApp();
    }
});
