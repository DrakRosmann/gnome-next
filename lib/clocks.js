import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GWeather from 'gi://GWeather';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {slideFrom} from './animation.js';
import {addPressFeedback} from './spring.js';

// Mockup: up to 4 clocks get the large layout, more use a compact list and
// above 6 the list is paged
const LARGE_LIMIT = 4;
const PAGE_SIZE = 6;

export const AnalogClock = GObject.registerClass(
class GnAnalogClock extends St.DrawingArea {
    constructor(params) {
        super({style_class: 'gn-analog-clock', ...params});
        this._hours = 0;
        this._minutes = 0;
    }

    setTime(hours, minutes) {
        this._hours = hours;
        this._minutes = minutes;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const color = this.get_theme_node().get_foreground_color();
        const rgba = alpha => cr.setSourceRGBA(
            color.red / 255, color.green / 255, color.blue / 255, alpha);

        const radius = Math.min(width, height) / 2;
        const line = Math.max(1, radius / 11);
        cr.translate(width / 2, height / 2);
        cr.setLineCap(1); // CAIRO_LINE_CAP_ROUND

        // Minute ticks around the face, longer every five minutes
        for (let i = 0; i < 60; i++) {
            const major = i % 5 === 0;
            const angle = i * Math.PI / 30;
            const outer = radius - line / 2;
            const inner = outer - (major ? radius * 0.16 : radius * 0.06);
            cr.setLineWidth(major ? line * 0.8 : line * 0.45);
            rgba(major ? 0.6 : 0.3);
            cr.moveTo(Math.sin(angle) * inner, -Math.cos(angle) * inner);
            cr.lineTo(Math.sin(angle) * outer, -Math.cos(angle) * outer);
            cr.stroke();
        }

        const hand = (angle, length, lineWidth) => {
            cr.setLineWidth(lineWidth);
            cr.moveTo(0, 0);
            cr.lineTo(Math.sin(angle) * length, -Math.cos(angle) * length);
            cr.stroke();
        };

        rgba(1);
        hand(((this._hours % 12) + this._minutes / 60) * Math.PI / 6, radius * 0.48, line * 1.6);
        hand(this._minutes * Math.PI / 30, radius * 0.72, line * 1.1);

        cr.arc(0, 0, line * 1.2, 0, 2 * Math.PI);
        cr.fill();

        cr.$dispose();
    }
});

function cityName(location) {
    return location.get_city_name() || location.get_name();
}

export const ClocksCard = GObject.registerClass({
    Signals: {'changed': {}},
}, class GnClocksCard extends St.Button {
    constructor(wallClock) {
        super({
            style_class: 'gn-clocks world-clocks-button',
            can_focus: true,
            x_expand: true,
            accessible_name: _('World Clocks'),
        });

        this._locations = [];
        this._entries = [];
        this._page = 0;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.child = box;

        this._rows = new St.BoxLayout({
            style_class: 'gn-clock-rows',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        box.add_child(this._rows);

        this._dots = new St.BoxLayout({
            style_class: 'gn-page-dots',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._dots);

        this._settings = new Gio.Settings({schema_id: 'org.gnome.shell.world-clocks'});
        this._settings.connectObject('changed::locations', () => this._reload(), this);

        this._wallClock = wallClock;
        wallClock.connectObject('notify::clock', () => this._updateTimes(), this);

        this.connect('destroy', () => {
            this._settings.disconnectObject(this);
            this._wallClock.disconnectObject(this);
        });

        addPressFeedback(this, {scale: 0.98});
        this._reload();
    }

    get count() {
        return this._locations.length;
    }

    _reload() {
        const world = GWeather.Location.get_world();
        const clocks = this._settings.get_value('locations').deepUnpack();

        this._locations = clocks
            .map(c => world.deserialize(c))
            .filter(l => l?.get_timezone());

        const now = GLib.DateTime.new_now_local().to_unix();
        const offset = l => {
            const tz = l.get_timezone();
            return tz.get_offset(tz.find_interval(GLib.TimeType.STANDARD, now));
        };
        this._locations.sort((a, b) => offset(a) - offset(b));

        this._page = 0;
        this._rebuild();
        this.emit('changed');
    }

    get _pageCount() {
        return this._locations.length > PAGE_SIZE
            ? Math.ceil(this._locations.length / PAGE_SIZE)
            : 1;
    }

    _setPage(page) {
        page = Math.clamp(page, 0, this._pageCount - 1);
        if (page === this._page)
            return;
        const direction = page > this._page ? 1 : -1;
        this._page = page;
        this._rebuild();
        this._rows.get_children().forEach((row, i) => {
            slideFrom(row, direction, {distance: 30, duration: 240 + i * 20});
        });
    }

    _rebuild() {
        this._rows.destroy_all_children();
        this._dots.destroy_all_children();
        this._entries = [];

        const n = this._locations.length;
        this.visible = n > 0;

        const compact = n > LARGE_LIMIT;
        if (compact)
            this.add_style_class_name('compact');
        else
            this.remove_style_class_name('compact');

        const paged = this._pageCount > 1;
        const shown = paged
            ? this._locations.slice(this._page * PAGE_SIZE, (this._page + 1) * PAGE_SIZE)
            : this._locations;

        for (const location of shown) {
            const row = new St.BoxLayout({style_class: 'gn-clock-row', x_expand: true});
            const face = new AnalogClock({y_align: Clutter.ActorAlign.CENTER});
            row.add_child(face);

            const name = new St.Label({
                style_class: 'gn-clock-city',
                text: cityName(location),
                x_expand: compact,
                y_align: Clutter.ActorAlign.CENTER,
            });
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            const time = new St.Label({
                style_class: 'gn-clock-time',
                y_align: Clutter.ActorAlign.CENTER,
            });

            if (compact) {
                row.add_child(name);
                row.add_child(time);
            } else {
                const labels = new St.BoxLayout({
                    orientation: Clutter.Orientation.VERTICAL,
                    y_align: Clutter.ActorAlign.CENTER,
                    x_expand: true,
                });
                labels.add_child(name);
                labels.add_child(time);
                row.add_child(labels);
            }

            this._rows.add_child(row);
            this._entries.push({location, face, time});
        }

        this._dots.visible = paged;
        for (let p = 0; paged && p < this._pageCount; p++) {
            const dot = new St.Button({
                style_class: 'gn-page-dot',
                checked: p === this._page,
                can_focus: true,
                accessible_name: _('Page %d').format(p + 1),
                child: new St.Widget({style_class: 'gn-page-dot-mark'}),
            });
            dot.connect('clicked', () => {
                this._setPage(p);
                return Clutter.EVENT_STOP;
            });
            this._dots.add_child(dot);
        }

        this._updateTimes();
    }

    _updateTimes() {
        for (const {location, face, time} of this._entries) {
            const now = GLib.DateTime.new_now(location.get_timezone());
            time.text = formatTime(now, {timeOnly: true});
            face.setTime(now.get_hour(), now.get_minute());
        }
    }

    vfunc_scroll_event(event) {
        if (this._pageCount < 2)
            return Clutter.EVENT_PROPAGATE;

        let direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            this._scrollDelta = (this._scrollDelta ?? 0) + (Math.abs(dy) > Math.abs(dx) ? dy : dx);
            if (Math.abs(this._scrollDelta) < 1)
                return Clutter.EVENT_STOP;
            direction = this._scrollDelta > 0
                ? Clutter.ScrollDirection.DOWN
                : Clutter.ScrollDirection.UP;
            this._scrollDelta = 0;
        }
        if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.RIGHT)
            this._setPage(this._page + 1);
        else if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT)
            this._setPage(this._page - 1);
        return Clutter.EVENT_STOP;
    }

    vfunc_clicked() {
        const app = Shell.AppSystem.get_default().lookup_app('org.gnome.clocks.desktop');
        app?.activate();
        Main.overview.hide();
        Main.panel.closeCalendar();
    }
});
