import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {addPressFeedback} from '../spring.js';

// Grid cells a widget takes: [columns, rows]
export const SPANS = {
    small: [1, 1],
    medium: [2, 1],
    large: [2, 2],
};

// Base class for widgets: a card that knows its size and whether it has
// anything to show. Empty widgets are left out of the board (but still shown,
// with their placeholder, while editing).
export const Widget = GObject.registerClass({
    Properties: {
        'empty': GObject.ParamSpec.boolean('empty', null, null,
            GObject.ParamFlags.READWRITE, false),
    },
}, class GnWidget extends St.Button {
    constructor(size, params = {}) {
        super({
            style_class: `gn-widget world-clocks-button ${size}`,
            can_focus: true,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            ...params,
        });
        this.widgetSize = size;
        this._empty = false;
        this._pressFeedback = addPressFeedback(this, {scale: 0.97});
    }

    get empty() {
        return this._empty;
    }

    set empty(empty) {
        if (this._empty === empty)
            return;
        this._empty = empty;
        this.notify('empty');
    }

    get large() {
        return this.widgetSize === 'large';
    }

    get small() {
        return this.widgetSize === 'small';
    }

    // Calls `callback` now and every `seconds` while the widget is on screen
    poll(seconds, callback) {
        let id = 0;
        const sync = () => {
            if (this.mapped && !id) {
                callback();
                id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                    callback();
                    return GLib.SOURCE_CONTINUE;
                });
            } else if (!this.mapped && id) {
                GLib.source_remove(id);
                id = 0;
            }
        };
        this.connect('notify::mapped', sync);
        this.connect('destroy', () => {
            if (id)
                GLib.source_remove(id);
            id = 0;
        });
        sync();
    }

    vfunc_clicked() {
        this.activate?.();
    }
});

export function label(styleClass, params = {}) {
    const actor = new St.Label({style_class: styleClass, ...params});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

export function vbox(params = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, ...params});
}

// Centered icon and text for a widget with nothing to show
export function placeholder(iconName, text) {
    const box = vbox({
        style_class: 'gn-widget-placeholder',
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    box.add_child(new St.Icon({
        icon_name: iconName,
        style_class: 'gn-widget-placeholder-icon',
        x_align: Clutter.ActorAlign.CENTER,
    }));
    const text_ = new St.Label({
        text,
        style_class: 'gn-widget-placeholder-text',
        x_align: Clutter.ActorAlign.CENTER,
    });
    text_.clutter_text.set({
        line_wrap: true,
        line_wrap_mode: Pango.WrapMode.WORD_CHAR,
        ellipsize: Pango.EllipsizeMode.NONE,
        line_alignment: Pango.Alignment.CENTER,
    });
    box.add_child(text_);
    return box;
}

export function closeCalendar() {
    Main.overview.hide();
    Main.panel.closeCalendar();
}

// Opens the first of `ids` that is installed
export function launchApp(ids) {
    const appSystem = Shell.AppSystem.get_default();
    const app = ids.map(id => appSystem.lookup_app(id)).find(Boolean);
    if (!app)
        return false;
    app.activate();
    closeCalendar();
    return true;
}

export function openCalendarApp() {
    closeCalendar();
    const app = Gio.AppInfo.get_default_for_type('text/calendar', false);
    if (!app)
        return;
    const context = global.create_app_launch_context(0, -1);
    if (app.get_id() === 'org.gnome.Evolution.desktop')
        app.launch_action('calendar', context);
    else
        app.launch([], context);
}

export function capitalize(text) {
    return text ? text[0].toLocaleUpperCase() + text.slice(1) : text;
}
