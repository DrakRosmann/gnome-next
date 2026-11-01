import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GWeather from 'gi://GWeather';
import St from 'gi://St';

import {formatDateWithCFormatString} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Widget, capitalize, closeCalendar, label, placeholder, vbox} from './base.js';

const HOURS = 5;
const DAYS = 5;

export function temp(info) {
    const [ok, value] = info.get_value_temp(GWeather.TemperatureUnit.DEFAULT);
    return ok ? `${Math.round(value)}°` : '–';
}

export function forecastTime(info) {
    const [ok, timestamp] = info.get_value_update();
    return ok && timestamp ? GLib.DateTime.new_from_unix_local(timestamp) : null;
}

function isSunny(iconName) {
    return iconName.startsWith('weather-clear') || iconName.startsWith('weather-few-clouds');
}

export function weatherIcon(styleClass) {
    return new St.Icon({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
}

export function setWeatherIcon(icon, iconName) {
    icon.icon_name = iconName;
    if (isSunny(iconName))
        icon.add_style_class_name('sunny');
    else
        icon.remove_style_class_name('sunny');
}

// Min, max and a midday icon for each day with forecasts. Days follow
// `timezone` (the place's), local time if not given.
export function dailyForecast(forecasts, timezone = null) {
    const days = new Map();
    for (const {info, time: localTime} of forecasts) {
        const time = timezone ? localTime.to_timezone(timezone) : localTime;
        const key = time.format('%F');
        const [ok, value] = info.get_value_temp(GWeather.TemperatureUnit.DEFAULT);
        if (!ok)
            continue;
        let day = days.get(key);
        if (!day) {
            day = {time, min: value, max: value, icon: info.get_symbolic_icon_name(), noon: 99};
            days.set(key, day);
        }
        day.min = Math.min(day.min, value);
        day.max = Math.max(day.max, value);
        const fromNoon = Math.abs(time.get_hour() - 13);
        if (fromNoon < day.noon) {
            day.noon = fromNoon;
            day.icon = info.get_symbolic_icon_name();
        }
    }
    return [...days.values()];
}

// Forecasts of `info` with their local time
export function forecasts(info) {
    return info.get_forecast_list()
        .map(f => ({info: f, time: forecastTime(f)}))
        .filter(f => f.time);
}

// Places its child between two fractions of the width
const RangeLayout = GObject.registerClass(
class GnRangeLayout extends Clutter.LayoutManager {
    constructor(from, to) {
        super();
        this._from = from;
        this._to = to;
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const child = container.get_first_child();
        return child ? child.get_preferred_height(forWidth) : [0, 0];
    }

    vfunc_allocate(container, box) {
        const child = container.get_first_child();
        if (!child)
            return;
        const width = box.get_width();
        const minWidth = Math.min(width, box.get_height());
        let x1 = box.x1 + Math.round(this._from * width);
        let x2 = box.x1 + Math.round(this._to * width);
        if (x2 - x1 < minWidth) {
            x2 = Math.min(box.x2, x1 + minWidth);
            x1 = x2 - minWidth;
        }
        if (container.text_direction === Clutter.TextDirection.RTL)
            [x1, x2] = [box.x1 + box.x2 - x2, box.x1 + box.x2 - x1];
        child.allocate(Clutter.ActorBox.new(x1, box.y1, x2, box.y2));
    }
});

// Small: place, temperature and conditions. Medium adds the next hours,
// large also the next days.
export const WeatherWidget = GObject.registerClass(
class GnWeatherWidget extends Widget {
    constructor(size, {weatherClient}) {
        super(size);
        this.add_style_class_name('gn-weather-widget');
        this._client = weatherClient;

        const box = vbox({x_expand: true, y_expand: true});
        this.child = box;

        this._content = vbox({style_class: 'gn-weather-content', x_expand: true, y_expand: true});
        box.add_child(this._content);
        this._placeholder = placeholder('weather-few-clouds-symbolic',
            _('Choose a location in Weather'));
        box.add_child(this._placeholder);

        const top = new St.BoxLayout({style_class: 'gn-weather-top', x_expand: true});
        this._content.add_child(top);

        const now = vbox({x_expand: true});
        top.add_child(now);
        this._place = label('gn-widget-title');
        now.add_child(this._place);
        this._temp = label('gn-weather-now');
        now.add_child(this._temp);

        const summary = vbox({style_class: 'gn-weather-summary-box', y_align: Clutter.ActorAlign.END});
        this._icon = weatherIcon('gn-weather-widget-icon');
        this._icon.x_align = Clutter.ActorAlign.START;
        summary.add_child(this._icon);
        this._conditions = label('gn-weather-conditions');
        summary.add_child(this._conditions);
        this._range = label('gn-widget-dim');
        summary.add_child(this._range);

        if (this.small) {
            now.add_child(summary);
            summary.y_expand = true;
        } else {
            summary.x_align = Clutter.ActorAlign.END;
            summary.y_align = Clutter.ActorAlign.START;
            this._icon.x_align = Clutter.ActorAlign.END;
            this._conditions.x_align = Clutter.ActorAlign.END;
            this._range.x_align = Clutter.ActorAlign.END;
            top.add_child(summary);
        }

        if (!this.small) {
            this._hours = new St.BoxLayout({
                style_class: 'gn-weather-hours',
                x_expand: true,
                y_expand: true,
                y_align: Clutter.ActorAlign.END,
            });
            this._content.add_child(this._hours);
        }
        if (this.large) {
            this._days = vbox({style_class: 'gn-weather-days', x_expand: true, y_expand: true});
            this._content.add_child(this._days);
        }

        if (this._client) {
            this._client.connectObject('changed', () => this._sync(), this);
            this.connect('destroy', () => this._client.disconnectObject(this));
        }
        this._sync();
    }

    _sync() {
        const client = this._client;
        const info = client?.info;
        const usable = client && client.available && client.hasLocation;
        this.empty = !usable;
        this._placeholder.visible = !usable;
        this._content.visible = !!usable;
        if (!usable || !info.is_valid())
            return;

        this._place.text = info.get_location_name() ?? '';
        this._temp.text = temp(info);
        setWeatherIcon(this._icon, info.get_symbolic_icon_name());
        const conditions = info.get_conditions();
        this._conditions.text = capitalize(conditions && conditions !== '-' ? conditions : info.get_sky());

        const upcoming = forecasts(info);
        const days = dailyForecast(upcoming);
        const today = days[0];
        this._range.text = today
            ? _('H:%s L:%s').format(`${Math.round(today.max)}°`, `${Math.round(today.min)}°`)
            : '';
        this._range.visible = !!today;

        if (this._hours)
            this._syncHours(upcoming);
        if (this._days)
            this._syncDays(days);
    }

    _syncHours(forecasts) {
        this._hours.destroy_all_children();
        const now = GLib.DateTime.new_now_local().to_unix();
        const upcoming = forecasts.filter(f => f.time.to_unix() > now - 1800).slice(0, HOURS);
        upcoming.forEach((f, i) => {
            const column = vbox({style_class: 'gn-weather-hour', x_expand: true});
            column.add_child(new St.Label({
                style_class: 'gn-widget-dim',
                text: i === 0 ? _('Now') : f.time.format('%H'),
                x_align: Clutter.ActorAlign.CENTER,
            }));
            const icon = weatherIcon('gn-weather-hour-icon');
            icon.x_align = Clutter.ActorAlign.CENTER;
            setWeatherIcon(icon, f.info.get_symbolic_icon_name());
            column.add_child(icon);
            column.add_child(new St.Label({
                style_class: 'gn-weather-hour-temp',
                text: temp(f.info),
                x_align: Clutter.ActorAlign.CENTER,
            }));
            this._hours.add_child(column);
        });
    }


    _syncDays(days) {
        this._days.destroy_all_children();
        const shown = days.slice(0, DAYS);
        const low = Math.min(...shown.map(d => d.min));
        const high = Math.max(...shown.map(d => d.max));

        shown.forEach((day, i) => {
            const row = new St.BoxLayout({style_class: 'gn-weather-day', x_expand: true});
            const date = new Date(day.time.to_unix() * 1000);
            row.add_child(new St.Label({
                style_class: 'gn-weather-day-name',
                text: i === 0 ? _('Today') : capitalize(formatDateWithCFormatString(date, '%a')),
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const icon = weatherIcon('gn-weather-day-icon');
            setWeatherIcon(icon, day.icon);
            row.add_child(icon);
            row.add_child(new St.Label({
                style_class: 'gn-widget-dim gn-weather-day-temp',
                text: `${Math.round(day.min)}°`,
                y_align: Clutter.ActorAlign.CENTER,
            }));

            // Temperature range bar, positioned within the week's range
            const span = Math.max(1, high - low);
            const track = new St.Widget({
                style_class: 'gn-weather-range',
                layout_manager: new RangeLayout((day.min - low) / span, (day.max - low) / span),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            track.add_child(new St.Widget({style_class: 'gn-weather-range-fill'}));
            row.add_child(track);

            row.add_child(new St.Label({
                style_class: 'gn-weather-day-temp',
                text: `${Math.round(day.max)}°`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            this._days.add_child(row);
        });
    }

    activate() {
        if (!this._client)
            return;
        this._client.activateApp();
        closeCalendar();
    }
});
