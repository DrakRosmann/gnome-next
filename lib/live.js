import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {animateResize} from './animation.js';
import {addPressFeedback, springTo} from './spring.js';
import {STOPWATCH_ICON, TIMER_ICON, formatDuration, timers} from './timers.js';

const HIDDEN = 'gn-live-activities';
const LAUNCHER_IFACE = 'com.canonical.Unity.LauncherEntry';
// Progress an app stopped reporting without saying it is done
const STALE_TIME = 10 * 60 * 1000; // ms

const now = () => GLib.get_monotonic_time() / 1000; // ms

// Progress apps report for their launcher icon (downloads in browsers, file
// copies, torrents), through the Unity LauncherEntry API that docks read too
class LauncherProgress extends EventEmitter {
    constructor() {
        super();
        this._entries = new Map(); // app id -> {progress, sender, time}
        this._watches = new Map(); // sender -> watch id
        this._signalId = Gio.DBus.session.signal_subscribe(null, LAUNCHER_IFACE, 'Update',
            null, null, Gio.DBusSignalFlags.NONE,
            (_c, sender, _path, _iface, _signal, params) => this._onUpdate(sender, params));
    }

    destroy() {
        Gio.DBus.session.signal_unsubscribe(this._signalId);
        this._watches.forEach(id => Gio.bus_unwatch_name(id));
        this._watches.clear();
        this._entries.clear();
    }

    _onUpdate(sender, params) {
        const [uri, props] = params.deepUnpack();
        const appId = uri.replace(/^application:\/\//, '');
        const value = key => props[key]?.deepUnpack();
        const entry = this._entries.get(appId) ?? {progress: 0, visible: false};
        if (value('progress') !== undefined)
            entry.progress = Math.clamp(value('progress'), 0, 1);
        if (value('progress-visible') !== undefined)
            entry.visible = value('progress-visible');
        entry.sender = sender;
        entry.time = now();

        if (entry.visible)
            this._entries.set(appId, entry);
        else
            this._entries.delete(appId);

        // Drop what an app reported once it quits
        if (entry.visible && !this._watches.has(sender)) {
            this._watches.set(sender, Gio.bus_watch_name(Gio.BusType.SESSION, sender,
                Gio.BusNameWatcherFlags.NONE, null, () => {
                    Gio.bus_unwatch_name(this._watches.get(sender));
                    this._watches.delete(sender);
                    for (const [id, e] of this._entries) {
                        if (e.sender === sender)
                            this._entries.delete(id);
                    }
                    this.emit('changed');
                }));
        }
        this.emit('changed');
    }

    activities() {
        const appSystem = Shell.AppSystem.get_default();
        const result = [];
        for (const [appId, entry] of this._entries) {
            if (now() - entry.time > STALE_TIME) {
                this._entries.delete(appId);
                continue;
            }
            const app = appSystem.lookup_app(appId);
            result.push({
                id: `progress:${appId}`,
                gicon: app?.get_icon() ?? new Gio.ThemedIcon({name: 'folder-download-symbolic'}),
                title: app?.get_name() ?? _('In Progress'),
                detail: `${Math.round(entry.progress * 100)}%`,
                short: `${Math.round(entry.progress * 100)}%`,
                progress: entry.progress,
                activate: app ? () => app.activate() : null,
                actions: [],
            });
        }
        return result;
    }
}

// The screen recording the shell is making
class ScreenRecording extends EventEmitter {
    constructor() {
        super();
        this._ui = Main.screenshotUI;
        this._start = 0;
        this._ui?.connectObject('notify::screencast-in-progress', () => {
            this._start = this._recording ? now() : 0;
            this.emit('changed');
        }, this);
        if (this._recording)
            this._start = now();
    }

    destroy() {
        this._ui?.disconnectObject(this);
    }

    get _recording() {
        return !!this._ui?.screencast_in_progress;
    }

    activities() {
        if (!this._recording)
            return [];
        const elapsed = formatDuration(now() - this._start);
        return [{
            id: 'screencast',
            icon: 'media-record-symbolic',
            tone: 'recording',
            title: _('Screen Recording'),
            detail: elapsed,
            short: elapsed,
            ticking: true,
            actions: [{
                icon: 'media-playback-stop-symbolic',
                label: _('Stop Recording'),
                run: () => this._ui.stopScreencast(),
            }],
        }];
    }
}

// The extension's own timer and stopwatch
class TimerActivities extends EventEmitter {
    constructor() {
        super();
        this._timers = timers();
        this._timers?.connectObject('changed', () => this.emit('changed'), this);
    }

    destroy() {
        this._timers?.disconnectObject(this);
    }

    activities() {
        const t = this._timers;
        const result = [];
        const timer = t?.timer;
        if (timer) {
            const left = formatDuration(timer.left);
            result.push({
                id: 'timer',
                icon: TIMER_ICON,
                title: _('Timer'),
                detail: timer.paused ? `${left} · ${_('Paused')}` : left,
                short: left,
                progress: timer.duration > 0 ? 1 - timer.left / timer.duration : null,
                ticking: !timer.paused,
                actions: [
                    {icon: 'list-add-symbolic', label: _('Add a Minute'), run: () => t.addMinute()},
                    timer.paused
                        ? {icon: 'media-playback-start-symbolic', label: _('Resume'), run: () => t.resumeTimer()}
                        : {icon: 'media-playback-pause-symbolic', label: _('Pause'), run: () => t.pauseTimer()},
                    {icon: 'window-close-symbolic', label: _('Stop'), run: () => t.stopTimer()},
                ],
            });
        }
        const stopwatch = t?.stopwatch;
        if (stopwatch) {
            const elapsed = formatDuration(stopwatch.elapsed);
            result.push({
                id: 'stopwatch',
                icon: STOPWATCH_ICON,
                title: _('Stopwatch'),
                detail: stopwatch.paused ? `${elapsed} · ${_('Paused')}` : elapsed,
                short: elapsed,
                ticking: !stopwatch.paused,
                actions: [
                    stopwatch.paused
                        ? {icon: 'media-playback-start-symbolic', label: _('Resume'), run: () => t.resumeStopwatch()}
                        : {icon: 'media-playback-pause-symbolic', label: _('Pause'), run: () => t.pauseStopwatch()},
                    {icon: 'window-close-symbolic', label: _('Stop'), run: () => t.stopStopwatch()},
                ],
            });
        }
        return result;
    }
}

// A thin rounded bar: the theme `color` for the done part, `-gn-track-color`
// for the rest
const ProgressBar = GObject.registerClass(
class GnLiveProgress extends St.DrawingArea {
    constructor() {
        super({style_class: 'gn-live-progress', x_expand: true});
        this._fraction = 0;
    }

    set fraction(fraction) {
        fraction = Math.clamp(fraction, 0, 1);
        if (Math.abs(fraction - this._fraction) < 0.001)
            return;
        this._fraction = fraction;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const node = this.get_theme_node();
        const done = node.get_foreground_color();
        const [, track] = node.lookup_color('-gn-track-color', false);
        const pill = (x, w, color) => {
            const r = height / 2;
            cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
            cr.newSubPath();
            cr.arc(x + r, r, r, Math.PI / 2, Math.PI * 3 / 2);
            cr.arc(x + w - r, r, r, -Math.PI / 2, Math.PI / 2);
            cr.closePath();
            cr.fill();
        };
        pill(0, width, track);
        const rtl = this.text_direction === Clutter.TextDirection.RTL;
        const w = Math.max(height, width * this._fraction);
        if (this._fraction > 0)
            pill(rtl ? width - w : 0, w, done);
        cr.$dispose();
    }
});

// An activity: icon, title, what is going on, its buttons and progress
const ActivityCard = GObject.registerClass(
class GnActivityCard extends St.Button {
    constructor(activity) {
        super({style_class: 'gn-live-card', can_focus: true, x_expand: true});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.child = box;

        const row = new St.BoxLayout({style_class: 'gn-live-row', x_expand: true});
        box.add_child(row);
        this._icon = new St.Icon({style_class: 'gn-live-icon', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(this._icon);
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(text);
        this._title = new St.Label({style_class: 'gn-live-title'});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._title);
        this._detail = new St.Label({style_class: 'gn-live-detail'});
        text.add_child(this._detail);
        this._actions = new St.BoxLayout({style_class: 'gn-live-actions', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(this._actions);

        this._progress = new ProgressBar();
        box.add_child(this._progress);

        addPressFeedback(this, {scale: 0.98});
        this.update(activity);
    }

    update(activity) {
        this._activity = activity;
        if (activity.gicon)
            this._icon.gicon = activity.gicon;
        else
            this._icon.icon_name = activity.icon;
        this._icon.style_class = `gn-live-icon${activity.gicon ? ' app' : ''}${activity.tone ? ` ${activity.tone}` : ''}`;
        this._title.text = activity.title;
        this._detail.text = activity.detail ?? '';
        this._progress.visible = activity.progress !== null && activity.progress !== undefined;
        if (this._progress.visible)
            this._progress.fraction = activity.progress;

        // Buttons are rebuilt only when they change, so a press is not lost
        const key = activity.actions.map(a => a.icon).join();
        if (key !== this._actionsKey) {
            this._actionsKey = key;
            this._actions.destroy_all_children();
            for (const action of activity.actions) {
                const button = new St.Button({
                    style_class: 'button gn-live-action',
                    icon_name: action.icon,
                    accessible_name: action.label,
                    can_focus: true,
                });
                button.connect('clicked', () => this._activity.actions
                    .find(a => a.icon === action.icon)?.run());
                addPressFeedback(button, {scale: 0.85});
                this._actions.add_child(button);
            }
        }
    }

    vfunc_clicked() {
        if (!this._activity.activate)
            return;
        Main.panel.closeQuickSettings();
        this._activity.activate();
    }
});

// A list of activity cards, kept in step with the activities
const ActivityList = GObject.registerClass(
class GnActivityList extends St.BoxLayout {
    constructor(params) {
        super({orientation: Clutter.Orientation.VERTICAL, ...params});
        this._cards = new Map();
    }

    sync(activities) {
        const ids = activities.map(a => a.id);
        for (const [id, card] of this._cards) {
            if (!ids.includes(id)) {
                card.destroy();
                this._cards.delete(id);
            }
        }
        activities.forEach((activity, i) => {
            let card = this._cards.get(activity.id);
            if (card) {
                card.update(activity);
            } else {
                card = new ActivityCard(activity);
                this._cards.set(activity.id, card);
                this.add_child(card);
                if (this.mapped) {
                    card.set_pivot_point(0.5, 0);
                    card.set({opacity: 0, scale_y: 0.8});
                    card.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                    springTo(card, {scale_y: 1}, {preset: 'smooth'});
                }
            }
            this.set_child_at_index(card, i);
        });
        this.visible = activities.length > 0;
    }
});

// The island in the middle of the top bar: the first activity in short, how
// many more there are, and a menu with all of them
const Island = GObject.registerClass(
class GnIsland extends PanelMenu.Button {
    constructor() {
        super(0.5, _('Live Activities'));
        this.add_style_class_name('gn-island-button');

        this._box = new St.BoxLayout({style_class: 'gn-island', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._box);
        this._icon = new St.Icon({style_class: 'gn-island-icon', y_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._icon);
        this._label = new St.Label({style_class: 'gn-island-label', y_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._label);
        this._more = new St.Label({style_class: 'gn-island-more', y_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._more);

        this.menu.box.add_style_class_name('gn-island-menu');
        this._list = new ActivityList({style_class: 'gn-live-list'});
        this.menu.box.add_child(this._list);
        this.visible = false;
    }

    sync(activities) {
        this._list.sync(activities);
        const first = activities[0];
        const wasVisible = this.visible;
        this.visible = !!first;
        if (!first) {
            this.menu.close();
            return;
        }

        const change = () => {
            if (first.gicon)
                this._icon.gicon = first.gicon;
            else
                this._icon.icon_name = first.icon;
            this._label.text = first.short ?? first.title;
            this._more.text = activities.length > 1 ? `+${activities.length - 1}` : '';
            this._more.visible = activities.length > 1;
        };
        this._box.style_class = `gn-island${first.tone ? ` ${first.tone}` : ''}`;

        // It grows out of the clock when the first activity starts, and eases
        // to a new width when what it shows changes
        if (!wasVisible && this.mapped) {
            change();
            this._box.set_pivot_point(0.5, 0.5);
            this._box.set({scale_x: 0.4, scale_y: 0.6, opacity: 0});
            this._box.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            springTo(this._box, {scale_x: 1, scale_y: 1}, {preset: 'bouncy'});
        } else if (first.id !== this._firstId || activities.length !== this._count) {
            animateResize(this._box, change, {width: true});
        } else {
            change();
        }
        this._firstId = first.id;
        this._count = activities.length;
    }
});

// "Live Activities" (iOS) and live updates (Android 16): timers, the
// stopwatch, screen recordings and the progress of downloads and copies show
// in an island in the top bar and at the top of Quick Settings while they
// last
export class LiveActivities {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        this._sources = [new ScreenRecording(), new TimerActivities(), new LauncherProgress()];
        this._sources.forEach(source => source.connectObject('changed', () => this._queueSync(), this));

        this._island = new Island();
        Main.panel.addToStatusArea('gn-live-activities', this._island, 1, 'center');

        const menu = Main.panel.statusArea.quickSettings.menu;
        this._section = new ActivityList({style_class: 'gn-live-section', x_expand: true});
        menu.box.insert_child_below(this._section, menu._grid);
        this._section.connect('notify::mapped', () => this._sync());

        // The island shows the recording instead
        const recording = Main.panel.statusArea.screenRecording;
        if (recording)
            this._lock.hide(recording, HIDDEN);

        this._sync();
    }

    disable() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;

        this._lock.releaseAll(HIDDEN);
        this._sources.forEach(source => {
            source.disconnectObject(this);
            source.destroy();
        });
        this._sources = null;
        this._island.destroy();
        this._island = null;
        this._section.destroy();
        this._section = null;
    }

    _queueSync() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const activities = this._sources.flatMap(source => source.activities());
        this._island.sync(activities);
        this._section.sync(activities);

        // Clocks move every second while they are on screen
        const ticking = activities.some(a => a.ticking);
        if (ticking && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000 - Date.now() % 1000 + 5, () => {
                this._tickId = 0;
                this._sync();
                return GLib.SOURCE_REMOVE;
            });
        }
    }
}
