import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const REPLACED = 'gn-dnd-replaced';
const MAX_WAIT = 60; // seconds; timeouts stop while suspended, so check often
const EVENING_HOUR = 19;
const MORNING_HOUR = 8;
const ICON = 'notifications-disabled-symbolic';

function now() {
    return GLib.DateTime.new_now_local();
}

function at(day, hour) {
    return GLib.DateTime.new_local(day.get_year(), day.get_month(), day.get_day_of_month(), hour, 0, 0);
}

function timeOf(unix) {
    return formatTime(GLib.DateTime.new_from_unix_local(unix), {timeOnly: true});
}

// "Until 19:00", "Until tomorrow, 08:00"
function untilText(unix) {
    const end = GLib.DateTime.new_from_unix_local(unix);
    const today = now();
    if (end.get_day_of_year() === today.get_day_of_year() && end.get_year() === today.get_year())
        return _('Until %s').format(timeOf(unix));
    return _('Until tomorrow, %s').format(timeOf(unix));
}

// The Do Not Disturb toggle with a menu to turn it on for a while. The end
// time lives in the extension settings, so it survives logging out.
const DndToggle = GObject.registerClass(
class GnDndToggle extends QuickMenuToggle {
    constructor(settings, title) {
        super({
            title,
            iconName: ICON,
            toggleMode: true,
        });
        this._settings = settings;

        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._notifications.bind('show-banners', this, 'checked', Gio.SettingsBindFlags.INVERT_BOOLEAN);
        this._notifications.bind_writable('show-banners', this, 'reactive', false);

        this.menu.setHeader(ICON, title);
        this._options = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._options);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._buildOptions();
        });

        // Turned on from the toggle itself (or elsewhere): until turned off
        this.connect('notify::checked', () => {
            if (!this._starting)
                this._settings.set_int64('dnd-until', 0);
            this._sync();
        });
        settings.connectObject('changed::dnd-until', () => this._sync(), this);
        this.connect('destroy', () => settings.disconnectObject(this));
        this._sync();
    }

    _buildOptions() {
        this._options.removeAll();
        const time = now();
        const options = [
            {label: _('For 1 Hour'), until: time.add_hours(1)},
        ];
        if (time.get_hour() < EVENING_HOUR - 1) {
            const evening = at(time, EVENING_HOUR);
            options.push({label: _('Until This Evening (%s)').format(timeOf(evening.to_unix())), until: evening});
        }
        const morning = at(time.add_days(1), MORNING_HOUR);
        options.push(
            {label: _('Until Tomorrow (%s)').format(timeOf(morning.to_unix())), until: morning},
            {label: _('Until I Turn It Off'), until: null});

        const current = this.checked ? this._settings.get_int64('dnd-until') : -1;
        for (const {label, until} of options) {
            const item = new PopupMenu.PopupMenuItem(label);
            const value = until?.to_unix() ?? 0;
            // Only "until I turn it off" can be the current choice; a timed
            // one shows its end in the subtitle
            item.setOrnament(current === 0 && value === 0
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NO_DOT);
            item.connect('activate', () => this._start(value));
            this._options.addMenuItem(item);
        }
    }

    _start(until) {
        // On first: the end time is dropped while Do Not Disturb is off
        this._starting = true;
        try {
            this.checked = true;
        } finally {
            this._starting = false;
        }
        this._settings.set_int64('dnd-until', until);
        this._sync();
    }

    _sync() {
        const until = this._settings.get_int64('dnd-until');
        this.subtitle = this.checked && until > 0 ? untilText(until) : null;
    }
});

// Puts the toggle in the place of the shell's own Do Not Disturb toggle, and
// turns Do Not Disturb off when its time is up
export class DndMenu {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._notifications.connectObject('changed::show-banners', () => this._check(), this);
        this._settings.connectObject('changed::dnd-until', () => this._check(), this);
        this._check();

        const menu = Main.panel.statusArea.quickSettings.menu;
        this._grid = menu._grid;
        this._native = [...this._grid].find(c => c.constructor.name === 'DoNotDisturbToggle') ?? null;

        // The shell's title, translated by the shell
        this._toggle = new DndToggle(this._settings, this._native?.title || _('Do Not Disturb'));
        // The editor and the removed-toggles setting treat it as the original
        this._toggle._gnIdAs = 'DoNotDisturbToggle';
        this._toggle._gnCategory = 'personalization';
        if (this._native) {
            menu.insertItemBefore(this._toggle, this._native, 1);
            this._native._gnReplacedBy = this._toggle;
            this._lock.hide(this._native, REPLACED);
        } else {
            menu.addItem(this._toggle, 1);
        }
    }

    disable() {
        this._notifications.disconnectObject(this);
        this._settings.disconnectObject(this);
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;

        if (this._native) {
            delete this._native._gnReplacedBy;
            this._lock.release(this._native, REPLACED);
        }
        this._native = null;
        // The menu lives in the Quick Settings overlay, not in the toggle
        this._toggle.menu.destroy();
        this._toggle.destroy();
        this._toggle = null;
        this._notifications = null;
    }

    _check() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;

        const until = this._settings.get_int64('dnd-until');
        if (until <= 0)
            return;
        // Turned off meanwhile: forget the end time
        if (this._notifications.get_boolean('show-banners')) {
            this._settings.set_int64('dnd-until', 0);
            return;
        }

        const left = until - now().to_unix();
        if (left <= 0) {
            this._settings.set_int64('dnd-until', 0);
            this._notifications.set_boolean('show-banners', true);
            return;
        }
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.min(left, MAX_WAIT), () => {
            this._timeoutId = 0;
            this._check();
            return GLib.SOURCE_REMOVE;
        });
    }
}
