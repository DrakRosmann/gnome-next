import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

export const TIMER_ICON = 'alarm-symbolic';
export const STOPWATCH_ICON = 'preferences-system-time-symbolic';

// Minutes offered in the timer menu
const PRESETS = [1, 3, 5, 10, 15, 25, 30, 60];
const DEFAULT_MINUTES = 5;

const now = () => GLib.get_real_time() / 1000; // ms

// "4:05", "1:02:03"
export function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const seconds = String(total % 60).padStart(2, '0');
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
        : `${minutes}:${seconds}`;
}

function minutesText(minutes) {
    return ngettext('%d minute', '%d minutes', minutes).format(minutes);
}

// One timer and one stopwatch, kept in the settings so they go on through a
// lock (the extension is disabled meanwhile) and a restart of the shell.
// Emits 'changed' whenever one starts, pauses or stops.
//
// The state is a JSON object: {last (minutes), timer: {duration, end} or
// {duration, left} while paused, stopwatch: {start} or {elapsed} while
// paused}, times in ms.
export class Timers extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._timeoutId = 0;
        this._source = null;
    }

    enable() {
        this._read();
        this._settings.connectObject('changed::timer-state', () => {
            this._read();
            this.emit('changed');
        }, this);
        this._schedule();
    }

    disable() {
        this._settings.disconnectObject(this);
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._source?.destroy();
        this._source = null;
    }

    _read() {
        try {
            this._state = JSON.parse(this._settings.get_string('timer-state')) ?? {};
        } catch {
            this._state = {};
        }
    }

    _write() {
        this._settings.set_string('timer-state', JSON.stringify(this._state));
        this._schedule();
    }

    get lastMinutes() {
        return this._state.last ?? DEFAULT_MINUTES;
    }

    // {duration, left, paused} or null
    get timer() {
        const timer = this._state.timer;
        if (!timer)
            return null;
        const paused = timer.end === undefined;
        return {duration: timer.duration, paused, left: paused ? timer.left : timer.end - now()};
    }

    // {elapsed, paused} or null
    get stopwatch() {
        const stopwatch = this._state.stopwatch;
        if (!stopwatch)
            return null;
        const paused = stopwatch.start === undefined;
        return {paused, elapsed: paused ? stopwatch.elapsed : now() - stopwatch.start};
    }

    startTimer(minutes = this.lastMinutes) {
        const duration = minutes * 60000;
        this._state.last = minutes;
        this._state.timer = {duration, end: now() + duration};
        this._write();
    }

    pauseTimer() {
        const timer = this.timer;
        if (!timer || timer.paused)
            return;
        this._state.timer = {duration: timer.duration, left: timer.left};
        this._write();
    }

    resumeTimer() {
        const timer = this.timer;
        if (!timer?.paused)
            return;
        this._state.timer = {duration: timer.duration, end: now() + timer.left};
        this._write();
    }

    addMinute() {
        const timer = this._state.timer;
        if (!timer)
            return;
        timer.duration += 60000;
        if (timer.end !== undefined)
            timer.end += 60000;
        else
            timer.left += 60000;
        this._write();
    }

    stopTimer() {
        delete this._state.timer;
        this._write();
    }

    startStopwatch() {
        this._state.stopwatch = {start: now()};
        this._write();
    }

    pauseStopwatch() {
        const stopwatch = this.stopwatch;
        if (!stopwatch || stopwatch.paused)
            return;
        this._state.stopwatch = {elapsed: stopwatch.elapsed};
        this._write();
    }

    resumeStopwatch() {
        const stopwatch = this.stopwatch;
        if (!stopwatch?.paused)
            return;
        this._state.stopwatch = {start: now() - stopwatch.elapsed};
        this._write();
    }

    stopStopwatch() {
        delete this._state.stopwatch;
        this._write();
    }

    // Notifies when the timer is up, also for one that ran out while locked
    _schedule() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;

        const timer = this.timer;
        if (!timer || timer.paused)
            return;
        if (timer.left <= 0) {
            this._finish(timer);
            return;
        }
        // Timeouts stop while suspended, so do not wait long at once
        const wait = Math.min(timer.left, 60000);
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait), () => {
            this._timeoutId = 0;
            this._schedule();
            return GLib.SOURCE_REMOVE;
        });
    }

    _finish(timer) {
        delete this._state.timer;
        this._write();
        this.emit('changed');

        if (!this._source) {
            this._source = new MessageTray.Source({title: _('Timer'), iconName: TIMER_ICON});
            this._source.connect('destroy', () => (this._source = null));
            Main.messageTray.add(this._source);
        }
        const minutes = Math.round(timer.duration / 60000);
        const notification = new MessageTray.Notification({
            source: this._source,
            title: _('Time’s up'),
            body: minutesText(minutes),
            urgency: MessageTray.Urgency.CRITICAL,
            sound: new MessageTray.Sound(null, 'alarm-clock-elapsed'),
        });
        notification.addAction(_('Restart'), () => this.startTimer(minutes));
        this._source.addNotification(notification);
    }
}

let instance = null;

export function setTimers(timers) {
    instance = timers;
}

export function timers() {
    return instance;
}

// Quick Settings toggle: on while the timer runs, with the time left as its
// subtitle. Clicking starts the last duration or stops it; the menu has the
// durations and the stopwatch.
const TimerToggle = GObject.registerClass(
class GnTimerToggle extends QuickMenuToggle {
    constructor() {
        super({title: _('Timer'), iconName: TIMER_ICON, visible: true});
        this._timers = timers();
        this.menu.setHeader(TIMER_ICON, _('Timer'));

        const section = new PopupMenu.PopupMenuSection();
        for (const minutes of PRESETS) {
            section.addAction(minutesText(minutes), () => {
                this._timers.startTimer(minutes);
                this.menu.close();
            });
        }
        this.menu.addMenuItem(section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._stopwatchItem = this.menu.addAction('', () => {
            if (this._timers.stopwatch)
                this._timers.stopStopwatch();
            else
                this._timers.startStopwatch();
        });

        this.connect('clicked', () => {
            if (this._timers.timer)
                this._timers.stopTimer();
            else
                this._timers.startTimer();
        });
        this._timers.connectObject('changed', () => this._sync(), this);
        this.connect('notify::mapped', () => this._sync());
        this.connect('destroy', () => {
            this._timers.disconnectObject(this);
            this._stopTicking();
        });
        this._sync();
    }

    _sync() {
        const timer = this._timers.timer;
        this.checked = !!timer;
        this.subtitle = timer
            ? formatDuration(timer.left) + (timer.paused ? ` · ${_('Paused')}` : '')
            : minutesText(this._timers.lastMinutes);
        this._stopwatchItem.label.text = this._timers.stopwatch
            ? _('Stop Stopwatch')
            : _('Start Stopwatch');

        if (timer && !timer.paused && this.mapped) {
            this._tickId ??= GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._tickId = null;
                this._sync();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _stopTicking() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = null;
    }
});

export function createTimerToggle() {
    return timers() ? new TimerToggle() : null;
}
