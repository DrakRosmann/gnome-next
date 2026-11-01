import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GWeather from 'gi://GWeather';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Widget, capitalize, label, launchApp, placeholder, vbox} from './base.js';
import {dailyForecast, forecasts, setWeatherIcon, temp, weatherIcon} from './weather.js';

const LIMITS = {small: 3, medium: 3, large: 6};
const REFRESH = 30 * 60; // seconds
const PROVIDERS = GWeather.Provider.METAR | GWeather.Provider.MET_NO | GWeather.Provider.OWM;

// One GWeather.Info per place, shared by every copy of the widget
const cache = new Map();

function watchPlace(location, callback) {
    const key = location.serialize().print(true);
    let entry = cache.get(key);
    if (!entry) {
        const info = new GWeather.Info({
            application_id: 'org.gnome.Shell',
            contact_info: 'https://github.com/DrakRosmann/gnome-next',
            enabled_providers: PROVIDERS,
        });
        info.set_location(location);
        entry = {info, requestedAt: 0, listeners: new Set()};
        info.connect('updated', () => entry.listeners.forEach(cb => cb()));
        cache.set(key, entry);
    }
    const now = GLib.get_monotonic_time() / 1e6;
    if (!entry.requestedAt || now - entry.requestedAt > REFRESH) {
        entry.requestedAt = now;
        entry.info.update();
    }
    entry.listeners.add(callback);
    return {info: entry.info, unwatch: () => entry.listeners.delete(callback)};
}

export function clearPlaces() {
    cache.clear();
}

function settingsFor(schemaId) {
    const schema = Gio.SettingsSchemaSource.get_default().lookup(schemaId, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

function cityName(location) {
    return location.get_city_name() || location.get_name();
}

// The places saved in GNOME Weather, or the world clocks when there are none
export const CitiesWidget = GObject.registerClass(
class GnCitiesWidget extends Widget {
    constructor(size) {
        super(size, {accessible_name: _('Weather in Other Cities')});
        this.add_style_class_name('gn-weather-widget');
        this.add_style_class_name('gn-cities-widget');
        this._watches = [];

        const box = vbox({x_expand: true, y_expand: true});
        this.child = box;
        this._grid = new St.Widget({
            style_class: 'gn-cities-grid',
            layout_manager: new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true}),
            x_expand: true,
            y_expand: true,
        });
        box.add_child(this._grid);
        this._placeholder = placeholder('mark-location-symbolic', _('Add cities in Weather'));
        box.add_child(this._placeholder);

        this._sources = ['org.gnome.Weather', 'org.gnome.shell.world-clocks']
            .map(id => settingsFor(id))
            .filter(Boolean);
        this._sources.forEach(s => s.connectObject('changed::locations', () => this._reload(), this));
        this.connect('destroy', () => {
            this._sources.forEach(s => s.disconnectObject(this));
            this._unwatchAll();
        });
        // Refresh stale places each time the calendar opens
        this.connect('notify::mapped', () => {
            if (this.mapped)
                this._reload();
        });
        this._reload();
    }

    _unwatchAll() {
        this._watches.forEach(w => w.unwatch());
        this._watches = [];
    }

    _locations() {
        const world = GWeather.Location.get_world();
        const seen = new Set();
        for (const settings of this._sources) {
            const locations = settings.get_value('locations').deepUnpack()
                .map(v => world.deserialize(v))
                .filter(l => {
                    const key = l && cityName(l);
                    if (!key || seen.has(key))
                        return false;
                    seen.add(key);
                    return true;
                });
            if (locations.length > 0)
                return locations.slice(0, LIMITS[this.widgetSize]);
        }
        return [];
    }

    _reload() {
        this._unwatchAll();
        this._grid.destroy_all_children();
        const locations = this._locations();
        this.empty = locations.length === 0;
        this._placeholder.visible = this.empty;
        this._grid.visible = !this.empty;

        const layout = this._grid.layout_manager;
        locations.forEach((location, i) => {
            const cell = this.widgetSize === 'medium' ? this._column() : this._row();
            if (this.widgetSize === 'medium')
                layout.attach(cell.actor, i, 0, 1, 1);
            else
                layout.attach(cell.actor, 0, i, 1, 1);
            cell.city.text = cityName(location);
            const watch = watchPlace(location, () => this._fill(cell, watch.info, location));
            this._watches.push(watch);
            this._fill(cell, watch.info, location);
        });
    }

    _column() {
        const actor = vbox({style_class: 'gn-city-column', x_expand: true});
        const city = label('gn-city-name', {x_align: Clutter.ActorAlign.CENTER});
        const icon = weatherIcon('gn-city-icon');
        icon.x_align = Clutter.ActorAlign.CENTER;
        const now = label('gn-city-temp', {x_align: Clutter.ActorAlign.CENTER});
        const range = label('gn-widget-dim gn-city-range', {x_align: Clutter.ActorAlign.CENTER});
        [city, icon, now, range].forEach(a => actor.add_child(a));
        return {actor, city, icon, now, range};
    }

    _row() {
        const actor = new St.BoxLayout({style_class: 'gn-city-row', x_expand: true});
        const names = vbox({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const city = label('gn-city-name');
        names.add_child(city);
        let conditions = null;
        if (this.large) {
            conditions = label('gn-widget-dim gn-city-conditions');
            names.add_child(conditions);
        }
        actor.add_child(names);
        const icon = weatherIcon('gn-city-icon');
        actor.add_child(icon);
        const now = label('gn-city-temp', {y_align: Clutter.ActorAlign.CENTER});
        actor.add_child(now);
        let range = null;
        if (!this.small) {
            range = label('gn-widget-dim gn-city-range', {y_align: Clutter.ActorAlign.CENTER});
            actor.add_child(range);
        }
        return {actor, city, icon, now, range, conditions};
    }

    _fill(cell, info, location) {
        if (!info.is_valid()) {
            cell.now.text = '–';
            return;
        }
        setWeatherIcon(cell.icon, info.get_symbolic_icon_name());
        cell.now.text = temp(info);
        if (cell.conditions) {
            const conditions = info.get_conditions();
            cell.conditions.text = capitalize(conditions && conditions !== '-' ? conditions : info.get_sky());
        }
        if (cell.range) {
            const [today] = dailyForecast(forecasts(info), location.get_timezone());
            cell.range.text = today ? `${Math.round(today.max)}° ${Math.round(today.min)}°` : '';
        }
    }

    activate() {
        launchApp(['org.gnome.Weather.desktop']);
    }
});
