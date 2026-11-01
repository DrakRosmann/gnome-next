import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GWeather from 'gi://GWeather';
import St from 'gi://St';

import {formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Widget, label, launchApp, placeholder, vbox} from './base.js';
import {ClockFace} from './drawing.js';

const LIMITS = {small: 4, medium: 4, large: 6};

function cityName(location) {
    return location.get_city_name() || location.get_name();
}

// "Today, +3 h" relative to the local time
function relativeTime(now, local) {
    const hours = (now.get_utc_offset() - local.get_utc_offset()) / 3600 / 1000000;
    const days = (now.get_year() * 400 + now.get_day_of_year()) -
        (local.get_year() * 400 + local.get_day_of_year());
    const day = days > 0 ? _('Tomorrow') : days < 0 ? _('Yesterday') : _('Today');
    if (hours === 0)
        return day;
    const sign = hours > 0 ? '+' : '−';
    const value = Math.abs(hours);
    const text = Number.isInteger(value) ? `${value}` : value.toFixed(1);
    /* Translators: a day ("Today") and the time difference ("+3") */
    return _('%s, %s h').format(day, `${sign}${text}`);
}

export const ClocksWidget = GObject.registerClass(
class GnClocksWidget extends Widget {
    constructor(size, {wallClock}) {
        super(size, {accessible_name: _('World Clocks')});
        this.add_style_class_name('gn-clocks-widget');

        const box = vbox({x_expand: true, y_expand: true});
        this.child = box;
        this._grid = new St.Widget({
            style_class: 'gn-clocks-grid',
            layout_manager: new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true}),
            x_expand: true,
            y_expand: true,
        });
        box.add_child(this._grid);
        this._placeholder = placeholder('clock-symbolic', _('Add cities in Clocks'));
        box.add_child(this._placeholder);

        this._entries = [];
        this._settings = new Gio.Settings({schema_id: 'org.gnome.shell.world-clocks'});
        this._settings.connectObject('changed::locations', () => this._reload(), this);
        this._wallClock = wallClock;
        wallClock?.connectObject('notify::clock', () => this._updateTimes(), this);
        this.connect('destroy', () => {
            this._settings.disconnectObject(this);
            this._wallClock?.disconnectObject(this);
        });
        this._reload();
    }

    _reload() {
        const world = GWeather.Location.get_world();
        const locations = this._settings.get_value('locations').deepUnpack()
            .map(l => world.deserialize(l))
            .filter(l => l?.get_timezone())
            .slice(0, LIMITS[this.widgetSize]);

        this.empty = locations.length === 0;
        this._placeholder.visible = this.empty;
        this._grid.visible = !this.empty;
        this._grid.destroy_all_children();
        this._entries = [];

        const layout = this._grid.layout_manager;
        locations.forEach((location, i) => {
            const entry = this.large
                ? this._makeRow(location)
                : this._makeColumn(location);
            entry.location = location;
            this._entries.push(entry);
            if (this.small)
                layout.attach(entry.actor, i % 2, Math.floor(i / 2), 1, 1);
            else if (this.large)
                layout.attach(entry.actor, 0, i, 1, 1);
            else
                layout.attach(entry.actor, i, 0, 1, 1);
        });
        this._updateTimes();
    }

    _makeColumn(location) {
        const actor = vbox({style_class: 'gn-clock-cell', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const face = new ClockFace({x_align: Clutter.ActorAlign.CENTER});
        actor.add_child(face);
        const city = label('gn-clock-cell-city', {text: cityName(location), x_align: Clutter.ActorAlign.CENTER});
        actor.add_child(city);
        let offset = null;
        if (!this.small) {
            offset = label('gn-widget-dim gn-clock-cell-offset', {x_align: Clutter.ActorAlign.CENTER});
            actor.add_child(offset);
        }
        return {actor, face, offset};
    }

    _makeRow(location) {
        const actor = new St.BoxLayout({style_class: 'gn-clock-list-row', x_expand: true});
        const face = new ClockFace({y_align: Clutter.ActorAlign.CENTER});
        actor.add_child(face);
        const labels = vbox({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        labels.add_child(label('gn-clock-cell-city', {text: cityName(location)}));
        const offset = label('gn-widget-dim');
        labels.add_child(offset);
        actor.add_child(labels);
        const time = label('gn-clock-list-time', {y_align: Clutter.ActorAlign.CENTER});
        actor.add_child(time);
        return {actor, face, offset, time};
    }

    _updateTimes() {
        const local = GLib.DateTime.new_now_local();
        for (const {location, face, offset, time} of this._entries) {
            const now = GLib.DateTime.new_now(location.get_timezone());
            face.setTime(now.get_hour(), now.get_minute());
            if (time)
                time.text = formatTime(now, {timeOnly: true});
            if (offset) {
                offset.text = time
                    ? relativeTime(now, local)
                    : formatTime(now, {timeOnly: true});
            }
        }
    }

    activate() {
        launchApp(['org.gnome.clocks.desktop']);
    }
});
