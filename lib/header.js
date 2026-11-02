import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {formatDateWithCFormatString, formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ZeroWidthLayout} from './layouts.js';
import {addPressFeedback} from './spring.js';

const SPACERS = 'gn-header-clock';

// Takes the width left over, and is as tall as the time and date are on
// one line each, whatever that width (asked for no width, the labels would
// report heights for a zero-width column)
const ClockSlotLayout = GObject.registerClass(
class GnClockSlotLayout extends ZeroWidthLayout {
    vfunc_get_preferred_height(container, _forWidth) {
        const child = container.get_first_child();
        return child ? child.get_preferred_height(-1) : [0, 0];
    }
});

// One UI style header: the time, large, and the date under it at the start of the
// Quick Settings system row, with its buttons gathered at the end. Clicking
// the time opens the calendar. On laptops the battery pill is left out, as
// on One UI: the top bar already shows it, and it would leave the time no room.
export class PanelHeader {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        const qs = Main.panel.statusArea.quickSettings;
        const item = qs._system._systemItem;
        const row = item.child;

        // The time, and the date under it
        const box = new St.BoxLayout({
            style_class: 'gn-header-box',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._time = new St.Label({style_class: 'gn-header-time', x_align: Clutter.ActorAlign.START});
        this._date = new St.Label({style_class: 'gn-header-date', x_align: Clutter.ActorAlign.START});
        // The time never shortens; the date gives way when room is short
        this._time.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._date.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._time);
        box.add_child(this._date);

        this._clock = new St.Button({
            style_class: 'gn-header-clock',
            child: box,
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Open Calendar'),
        });
        this._clock.connect('clicked', () => {
            Main.panel.closeQuickSettings();
            Main.panel.statusArea.dateMenu?.menu.open();
        });
        addPressFeedback(this._clock, {scale: 0.95});
        // It takes the room left by the buttons, so the panel keeps its width
        this._slot = new St.Widget({
            layout_manager: new ClockSlotLayout(),
            x_expand: true,
            clip_to_allocation: true,
        });
        this._slot.add_child(this._clock);
        // Text set before it is on the stage
        this._sync();
        row.insert_child_at_index(this._slot, 0);

        // The time takes the room the spacers had, so the buttons gather at
        // the end
        for (const spacer of [item._laptopSpacer, item._desktopSpacer])
            if (spacer)
                this._lock.hide(spacer, SPACERS);
        // The battery pill is taken out of the row rather than hidden: the
        // top bar shows the battery only while the pill is visible
        this._power = item.powerToggle;
        row.remove_child(this._power);

        this._wallClock = Main.panel.statusArea.dateMenu?._clock ?? null;
        this._wallClock?.connectObject('notify::clock', () => this._sync(), this);
        qs.menu.connectObject('open-state-changed', (_m, open) => open && this._sync(), this);
    }

    disable() {
        this._wallClock?.disconnectObject(this);
        Main.panel.statusArea.quickSettings.menu.disconnectObject(this);
        this._lock.releaseAll(SPACERS);
        this._slot.destroy();
        this._slot = null;
        this._clock = null;
        Main.panel.statusArea.quickSettings._system._systemItem.child.insert_child_at_index(this._power, 0);
        this._power = null;
    }

    _sync() {
        const now = new Date();
        this._time.text = formatTime(now, {timeOnly: true});
        /* Translators: the date next to the time in Quick Settings, see strftime(3) */
        const date = formatDateWithCFormatString(now, _('%a, %-d %b'));
        this._date.text = date.charAt(0).toLocaleUpperCase() + date.slice(1);
    }
}
