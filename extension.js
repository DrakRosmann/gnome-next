import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CalendarPopover} from './lib/calendar.js';
import {Collapsible} from './lib/collapsible.js';
import {Customization} from './lib/customization.js';
import {DndMenu} from './lib/dnd.js';
import {ReminderScheduler} from './lib/reminders.js';
import {PillSliders} from './lib/sliders.js';
import {VisibilityLock} from './lib/visibility.js';

// Order matters: the editor hides whatever Collapsible added to the menu
const FEATURES = [
    {key: 'enable-collapsible', Feature: Collapsible},
    {key: 'enable-customization', Feature: Customization},
    {key: 'enable-calendar', Feature: CalendarPopover},
    {key: 'pill-sliders', Feature: PillSliders},
    {key: 'dnd-menu', Feature: DndMenu},
];

const READY_POLL_MS = 100;

export default class GnomeNextExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._lock = new VisibilityLock();
        this._active = new Map();
        this._reminders = new ReminderScheduler(this._settings);
        this._reminders.enable();

        // Quick Settings indicators are set up asynchronously at startup
        const ready = () => Boolean(Main.panel.statusArea.quickSettings?._system);
        if (ready()) {
            this._start();
        } else {
            this._readyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, READY_POLL_MS, () => {
                if (!ready())
                    return GLib.SOURCE_CONTINUE;
                this._readyId = 0;
                this._start();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    disable() {
        if (this._readyId)
            GLib.source_remove(this._readyId);
        this._readyId = 0;

        this._settings.disconnectObject(this);

        // Tear down in reverse order of creation
        [...this._active.keys()].reverse().forEach(key => this._stopFeature(key));
        this._active = null;

        this._reminders.disable();
        this._reminders = null;
        this._lock.destroy();
        this._lock = null;
        this._settings = null;
    }

    _start() {
        for (const {key} of FEATURES)
            this._settings.connectObject(`changed::${key}`, () => this._sync(), this);
        this._sync();
    }

    _sync() {
        // Restart everything after the changed feature so the stacking order
        // inside the menu stays the same
        const wanted = FEATURES.map(({key}) => this._settings.get_boolean(key));
        const firstChange = FEATURES.findIndex(({key}, i) => wanted[i] !== this._active.has(key));
        if (firstChange < 0)
            return;

        FEATURES.slice(firstChange).reverse().forEach(({key}) => this._stopFeature(key));
        FEATURES.slice(firstChange).forEach(({key, Feature}, i) => {
            if (wanted[firstChange + i])
                this._startFeature(key, Feature);
        });
    }

    _startFeature(key, Feature) {
        const feature = new Feature(this._settings, this._lock);
        try {
            feature.enable();
            this._active.set(key, feature);
        } catch (e) {
            logError(e, `GNOME Next: Failed to enable ${key}`);
            try {
                feature.disable();
            } catch {}
        }
    }

    _stopFeature(key) {
        const feature = this._active.get(key);
        if (!feature)
            return;
        this._active.delete(key);
        try {
            feature.disable();
        } catch (e) {
            logError(e, `GNOME Next: Failed to disable ${key}`);
        }
    }
}
