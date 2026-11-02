import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {animateResize} from './animation.js';
import {mprisSource} from './media.js';
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

const coverColors = new Map();

// The color of a cover, as Android and iOS tint the player with it: the
// average of its pixels, the colorful ones counting more, made bright and
// colorful enough to read on black. [r, g, b] or null.
function coverColor(url) {
    if (!url?.startsWith('file://'))
        return null;
    if (coverColors.has(url))
        return coverColors.get(url);

    let color = null;
    try {
        const path = Gio.File.new_for_uri(url).get_path();
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 16, 16, false);
        const pixels = pixbuf.get_pixels();
        const channels = pixbuf.get_n_channels();
        const stride = pixbuf.get_rowstride();
        let [r, g, b, total] = [0, 0, 0, 0];
        for (let y = 0; y < pixbuf.get_height(); y++) {
            for (let x = 0; x < pixbuf.get_width(); x++) {
                const i = y * stride + x * channels;
                const [pr, pg, pb] = [pixels[i], pixels[i + 1], pixels[i + 2]];
                const weight = 0.15 + (Math.max(pr, pg, pb) - Math.min(pr, pg, pb)) / 255;
                r += pr * weight;
                g += pg * weight;
                b += pb * weight;
                total += weight;
            }
        }
        color = vivid([r / total, g / total, b / total]);
    } catch {}

    if (coverColors.size > 40)
        coverColors.clear();
    coverColors.set(url, color);
    return color;
}

// The same hue, at least somewhat saturated and light enough for black
function vivid([r, g, b]) {
    [r, g, b] = [r / 255, g / 255, b / 255];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r)
            h = ((g - b) / d + 6) % 6;
        else if (max === g)
            h = (b - r) / d + 2;
        else
            h = (r - g) / d + 4;
    }
    const lightness = (max + min) / 2;
    const saturation = d === 0 ? 0 : d / (1 - Math.abs(2 * lightness - 1));
    // Grays stay gray, only brighter
    const s = saturation < 0.08 ? 0 : Math.max(saturation, 0.55);
    const l = Math.clamp(lightness, 0.6, 0.7);
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(h % 2 - 1));
    const m = l - c / 2;
    const [r1, g1, b1] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6];
    return [r1 + m, g1 + m, b1 + m].map(v => Math.round(v * 255));
}

export function rgba([r, g, b], alpha = 1) {
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Time a paused player stays in the island, as on iOS
const PAUSED_TIME = 60 * 1000; // ms
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
// How often the position is asked; it is moved on locally in between
const POSITION_REFRESH = 4000; // ms

// The music or video playing (MPRIS): its cover, title and artist, with
// previous, play/pause and next. A paused player goes away after a minute.
class NowPlaying extends EventEmitter {
    constructor() {
        super();
        this._source = mprisSource();
        this._cancellable = new Gio.Cancellable();
        this._position = null; // {key, us, at, fetched}
        this._pausedAt = new Map(); // player -> when it paused
        this._source.connectObject(
            'player-added', () => this._watch(),
            'player-removed', (_s, player) => {
                player.disconnectObject(this);
                this._pausedAt.delete(player);
                this.emit('changed');
            },
            this);
        this._watch();
    }

    destroy() {
        this._cancellable.cancel();
        if (this._expireId)
            GLib.source_remove(this._expireId);
        this._expireId = 0;
        this._source.disconnectObject(this);
        this._source.players.forEach(p => p.disconnectObject(this));
    }

    _watch() {
        for (const player of this._source.players) {
            player.disconnectObject(this);
            player.connectObject('changed', () => {
                // Playing, paused or a new track: ask where it is again
                if (this._position)
                    this._position.fetched = 0;
                if (player.status === 'Playing')
                    this._pausedAt.delete(player);
                else if (!this._pausedAt.has(player))
                    this._pausedAt.set(player, now());
                this._scheduleExpiry();
                this.emit('changed');
            }, this);
            if (player.status !== 'Playing' && !this._pausedAt.has(player))
                this._pausedAt.set(player, now() - PAUSED_TIME);
        }
        this.emit('changed');
    }

    // Comes back when the last paused player should leave
    _scheduleExpiry() {
        if (this._expireId)
            GLib.source_remove(this._expireId);
        this._expireId = 0;
        const left = Math.max(0, ...[...this._pausedAt.values()].map(t => t + PAUSED_TIME - now()));
        if (left <= 0)
            return;
        this._expireId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(left) + 50, () => {
            this._expireId = 0;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    _player() {
        const players = this._source.players;
        return players.find(p => p.status === 'Playing') ??
            players.find(p => this._pausedAt.has(p) && now() - this._pausedAt.get(p) < PAUSED_TIME) ??
            null;
    }

    _length(player) {
        // MprisPlayer does not expose the metadata, read it from its proxy
        try {
            return Number(player._playerProxy?.Metadata?.['mpris:length']?.deepUnpack() ?? 0);
        } catch {
            return 0;
        }
    }

    // Where the track is, in µs: the last answer of the player, moved on by
    // the time since while it plays. Asks again every few seconds.
    _positionOf(player, length) {
        const key = `${player._busName}|${player.trackTitle}|${length}`;
        const cache = this._position;
        if (!cache || cache.key !== key || now() - cache.fetched > POSITION_REFRESH)
            this._fetchPosition(player, key);
        if (cache?.key !== key)
            return null;
        const moving = player.status === 'Playing' ? (now() - cache.at) * 1000 : 0;
        return Math.clamp(cache.us + moving, 0, length);
    }

    _fetchPosition(player, key) {
        if (this._fetching || !player._busName)
            return;
        this._fetching = true;
        Gio.DBus.session.call(player._busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [MPRIS_PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                this._fetching = false;
                let us = 0;
                try {
                    const [position] = conn.call_finish(res).deepUnpack();
                    us = Number(position.deepUnpack());
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                }
                this._position = {key, us, at: now(), fetched: now()};
                this.emit('changed');
            });
    }

    _seek(player, length, fraction) {
        let trackId;
        try {
            trackId = player._playerProxy?.Metadata?.['mpris:trackid']?.deepUnpack();
        } catch {}
        if (!trackId || !player._busName)
            return;
        const us = Math.round(Math.clamp(fraction, 0, 1) * length);
        Gio.DBus.session.call(player._busName, MPRIS_PATH, MPRIS_PLAYER_IFACE, 'SetPosition',
            new GLib.Variant('(ox)', [trackId, us]), null, Gio.DBusCallFlags.NONE, -1, null, null);
        // Show it there right away; the player confirms on the next ask
        if (this._position) {
            Object.assign(this._position, {us, at: now()});
            this._position.fetched = now() - POSITION_REFRESH + 1000;
        }
        this.emit('changed');
    }

    activities() {
        const player = this._player();
        if (!player)
            return [];
        const playing = player.status === 'Playing';
        const length = this._length(player);
        const position = length > 0 ? this._positionOf(player, length) : null;
        const title = player.trackTitle || player.app?.get_name() || _('Media');
        const cover = player.trackCoverUrl
            ? new Gio.FileIcon({file: Gio.File.new_for_uri(player.trackCoverUrl)})
            : null;
        return [{
            id: 'media',
            kind: 'media',
            art: player.trackCoverUrl?.startsWith('file://') ? player.trackCoverUrl : null,
            accent: coverColor(player.trackCoverUrl),
            gicon: cover ?? player.app?.get_icon() ?? new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'}),
            title,
            detail: player.trackArtists.join(', ') || player.app?.get_name() || '',
            short: title,
            playing,
            // Moves while it plays, so cards follow it every second
            refresh: playing && length > 0,
            progress: position !== null ? position / length : null,
            times: position !== null
                ? [formatDuration(position / 1000), `-${formatDuration((length - position) / 1000)}`]
                : null,
            seek: length > 0 ? fraction => this._seek(player, length, fraction) : null,
            activate: () => player.raise(),
            actions: [
                {icon: 'media-skip-backward-symbolic', label: _('Previous'), run: () => player.previous()},
                playing
                    ? {icon: 'media-playback-pause-symbolic', label: _('Pause'), run: () => player.playPause()}
                    : {icon: 'media-playback-start-symbolic', label: _('Play'), run: () => player.playPause()},
                {icon: 'media-skip-forward-symbolic', label: _('Next'), run: () => player.next()},
            ],
        }];
    }
}

const UPOWER_BUS = 'org.freedesktop.UPower';
const UPOWER_DEVICE_IFACE = 'org.freedesktop.UPower.Device';
const BATTERY_CHARGING = 1;
const BATTERY_FULL = 4;
// Apps that show the input level and would always count as recording
const LEVEL_APPS = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];

// Quick indicators, as on iOS: an orange dot while an app uses the
// microphone and a green one for the camera, and short notices in the
// island when Do Not Disturb turns on or off and when a charger is plugged
// in or the battery is full. Emits 'changed' for the dots and 'notice' with
// {icon, title, detail, tone}.
class StatusIndicators extends EventEmitter {
    constructor() {
        super();
        this._cancellable = new Gio.Cancellable();

        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._notifications.connectObject('changed::show-banners', () => {
            const on = !this._notifications.get_boolean('show-banners');
            this.emit('notice', {
                icon: on ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic',
                title: _('Do Not Disturb'),
                detail: on ? _('On') : _('Off'),
                tone: on ? 'dnd' : null,
            });
        }, this);

        this._cameras = Main.panel.statusArea.quickSettings?._camera?._cameraMonitor ?? null;
        this._cameras?.connectObject('notify::cameras-in-use', () => this.emit('changed'), this);

        this._mixer = getMixerControl();
        this._mixer.connectObject(
            'stream-added', () => this.emit('changed'),
            'stream-removed', () => this.emit('changed'),
            'stream-changed', () => this.emit('changed'),
            'state-changed', () => this.emit('changed'),
            this);

        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null, UPOWER_BUS,
            '/org/freedesktop/UPower/devices/DisplayDevice', UPOWER_DEVICE_IFACE, this._cancellable,
            (_o, res) => {
                try {
                    this._battery = Gio.DBusProxy.new_for_bus_finish(res);
                } catch {
                    return;
                }
                this._batteryState = this._batteryValue('State');
                this._battery.connectObject('g-properties-changed', () => this._onBatteryChanged(), this);
            });
    }

    destroy() {
        this._cancellable.cancel();
        this._notifications.disconnectObject(this);
        this._cameras?.disconnectObject(this);
        this._mixer.disconnectObject(this);
        this._battery?.disconnectObject(this);
    }

    _batteryValue(name) {
        return this._battery?.get_cached_property(name)?.unpack();
    }

    _onBatteryChanged() {
        const state = this._batteryValue('State');
        if (state === this._batteryState || !this._batteryValue('IsPresent'))
            return;
        this._batteryState = state;
        const percentage = Math.round(this._batteryValue('Percentage') ?? 0);
        if (state === BATTERY_CHARGING) {
            this.emit('notice', {
                icon: 'battery-level-50-charging-symbolic',
                title: _('Charging'),
                detail: `${percentage}%`,
                tone: 'charging',
            });
        } else if (state === BATTERY_FULL) {
            this.emit('notice', {
                icon: 'battery-level-100-charged-symbolic',
                title: _('Fully Charged'),
                tone: 'charging',
            });
        }
    }

    _microphoneInUse() {
        if (this._mixer.get_state() !== Gvc.MixerControlState.READY)
            return false;
        const source = this._mixer.get_default_source();
        if (!source || source.is_muted)
            return false;
        return this._mixer.get_sources().some(s => s.state === Gvc.MixerStreamState.RUNNING) &&
            this._mixer.get_source_outputs().some(o => !LEVEL_APPS.includes(o.get_application_id()));
    }

    dots() {
        const dots = [];
        if (this._cameras?.cameras_in_use)
            dots.push({id: 'camera', tone: 'camera', label: _('Camera in use')});
        if (this._microphoneInUse())
            dots.push({id: 'microphone', tone: 'microphone', label: _('Microphone in use')});
        return dots;
    }
}

// Equalizer bars that dance while music plays and rest while paused
const Bars = GObject.registerClass(
class GnIslandBars extends St.DrawingArea {
    constructor() {
        super({style_class: 'gn-island-bars', y_align: Clutter.ActorAlign.CENTER});
        this._playing = false;
        this._level = 0; // how far the bars move, eased
        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        this.connect('notify::mapped', () => this._sync());
        this.connect('destroy', () => this._timeline.stop());
    }

    set playing(playing) {
        if (this._playing === playing)
            return;
        this._playing = playing;
        this._sync();
    }

    _sync() {
        const run = this.mapped && (this._playing || this._level > 0);
        if (run && !this._timeline.is_playing())
            this._timeline.start();
        else if (!run && this._timeline.is_playing())
            this._timeline.stop();
        this.queue_repaint();
    }

    _tick() {
        const target = this._playing ? 1 : 0;
        this._level += (target - this._level) * 0.12;
        if (Math.abs(target - this._level) < 0.01)
            this._level = target;
        this.queue_repaint();
        if (!this._playing && this._level === 0)
            this._sync();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const {red, green, blue, alpha} = this.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(red / 255, green / 255, blue / 255, alpha / 255);
        const n = 4;
        const bar = width / (n * 2 - 1);
        const t = GLib.get_monotonic_time() / 1e6;
        const rest = 0.25;
        for (let i = 0; i < n; i++) {
            const wave = 0.5 + 0.5 * Math.sin(t * (5 + i * 1.7) + i * 1.9);
            const h = height * (rest + (1 - rest) * wave * this._level);
            const x = i * bar * 2;
            const y = (height - h) / 2;
            const r = bar / 2;
            cr.newSubPath();
            cr.arc(x + r, y + r, r, Math.PI, 0);
            cr.arc(x + r, y + h - r, r, 0, Math.PI);
            cr.closePath();
            cr.fill();
        }
        cr.$dispose();
    }
});

// A thin rounded bar: the theme `color` for the done part, `-gn-track-color`
// for the rest. With `seek` set it can be dragged, showing a knob.
const ProgressBar = GObject.registerClass(
class GnLiveProgress extends St.DrawingArea {
    constructor() {
        super({style_class: 'gn-live-progress', x_expand: true, track_hover: true});
        this._fraction = 0;
        this._seek = null;
        this._dragging = false;
        // 0 to 1: how far the bar has grown, under the pointer
        this._grow = 0;
        this._growTo = 0;
        this._growTimeline = new Clutter.Timeline({actor: this, duration: 160});
        this._growTimeline.connect('new-frame', (timeline, elapsed) => {
            const t = elapsed / timeline.duration;
            const eased = 1 - (1 - t) ** 3;
            this._grow = this._growFrom + (this._growTo - this._growFrom) * eased;
            this.queue_repaint();
        });
        this.connect('notify::hover', () => this._syncGrow());
        this.connect('destroy', () => {
            this._growTimeline.stop();
            this._endDrag();
        });
    }

    _syncGrow() {
        const target = this._seek && (this.hover || this._dragging) ? 1 : 0;
        if (target === this._growTo)
            return;
        this._growFrom = this._grow;
        this._growTo = target;
        this._growTimeline.stop();
        if (this.mapped) {
            this._growTimeline.start();
        } else {
            this._grow = target;
            this.queue_repaint();
        }
    }

    set fraction(fraction) {
        fraction = Math.clamp(fraction, 0, 1);
        if (this._dragging || Math.abs(fraction - this._fraction) < 0.001)
            return;
        this._fraction = fraction;
        this.queue_repaint();
    }

    set seek(seek) {
        this._seek = seek;
        this.reactive = !!seek;
        if (seek)
            this.add_style_class_name('seekable');
        else
            this.remove_style_class_name('seekable');
    }

    _fractionAt(event) {
        const [x, y] = event.get_coords();
        const [, localX] = this.transform_stage_point(x, y);
        const fraction = Math.clamp(localX / Math.max(1, this.width), 0, 1);
        return this.text_direction === Clutter.TextDirection.RTL ? 1 - fraction : fraction;
    }

    vfunc_button_press_event(event) {
        if (!this._seek || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._dragging = true;
        this._grab = global.stage.grab(this);
        this._syncGrow();
        this._fraction = this._fractionAt(event);
        this.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;
        this._fraction = this._fractionAt(event);
        this.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;
        this._fraction = this._fractionAt(event);
        this._endDrag();
        this._seek?.(this._fraction);
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        this._dragging = false;
        this._grab?.dismiss();
        this._grab = null;
        if (this.get_stage())
            this._syncGrow();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const node = this.get_theme_node();
        const done = node.get_foreground_color();
        const [, track] = node.lookup_color('-gn-track-color', false);
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const thickness = Math.min(height, (6 + 4 * this._grow) * scaleFactor);
        const top = (height - thickness) / 2;
        const setColor = color =>
            cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
        const pill = (x, w, color) => {
            const r = thickness / 2;
            setColor(color);
            cr.newSubPath();
            cr.arc(x + r, top + r, r, Math.PI / 2, Math.PI * 3 / 2);
            cr.arc(x + w - r, top + r, r, -Math.PI / 2, Math.PI / 2);
            cr.closePath();
            cr.fill();
        };
        pill(0, width, track);
        const rtl = this.text_direction === Clutter.TextDirection.RTL;
        const w = Math.max(thickness, width * this._fraction);
        if (this._fraction > 0)
            pill(rtl ? width - w : 0, w, done);

        // A knob grows while it can be dragged and the pointer is on it
        if (this._seek && this._grow > 0.01) {
            const knob = Math.min(height / 2, thickness * 0.9) * this._grow;
            const x = Math.clamp(rtl ? width - w + thickness / 2 : w - thickness / 2, knob, width - knob);
            setColor(done);
            cr.arc(x, height / 2, knob, 0, 2 * Math.PI);
            cr.fill();
        }
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
        // A cover, with rounded corners an icon cannot have
        this._art = new St.Widget({style_class: 'gn-live-art', y_align: Clutter.ActorAlign.CENTER, visible: false});
        row.add_child(this._art);
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
        // Elapsed and left, under the bar of a song
        this._times = new St.BoxLayout({style_class: 'gn-live-times', x_expand: true});
        this._elapsed = new St.Label({style_class: 'gn-live-time', x_expand: true});
        this._left = new St.Label({style_class: 'gn-live-time'});
        this._times.add_child(this._elapsed);
        this._times.add_child(this._left);
        box.add_child(this._times);

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
        this.style_class = `gn-live-card${activity.kind ? ` ${activity.kind}` : ''}`;
        this._art.visible = !!activity.art;
        this._icon.visible = !activity.art;
        if (activity.art && activity.art !== this._artUrl) {
            this._artUrl = activity.art;
            this._art.style = `background-image: url("${activity.art.replaceAll('"', '%22')}");`;
            // A new song: its cover springs in
            if (this.mapped) {
                this._art.set_pivot_point(0.5, 0.5);
                this._art.set({scale_x: 0.8, scale_y: 0.8, opacity: 0});
                this._art.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                springTo(this._art, {scale_x: 1, scale_y: 1}, {preset: 'bouncy'});
            }
        }
        // Tinted with the color of the cover
        const accent = activity.accent ?? null;
        if (String(accent) !== this._accentKey) {
            this._accentKey = String(accent);
            this.style = accent
                ? `background-gradient-direction: horizontal; background-gradient-start: ${rgba(accent, 0.3)}; background-gradient-end: ${rgba(accent, 0.07)};`
                : null;
            this._progress.style = accent ? `color: ${rgba(accent)};` : null;
        }
        this._title.text = activity.title;
        this._detail.text = activity.detail ?? '';
        this._progress.visible = activity.progress !== null && activity.progress !== undefined;
        if (this._progress.visible)
            this._progress.fraction = activity.progress;
        this._progress.seek = activity.seek ?? null;
        this._times.visible = !!activity.times && this._progress.visible;
        if (this._times.visible)
            [this._elapsed.text, this._left.text] = activity.times;

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
        const animate = this.mapped;
        for (const [id, card] of this._cards) {
            if (ids.includes(id))
                continue;
            this._cards.delete(id);
            if (!animate) {
                card.destroy();
                continue;
            }
            // Fades and shrinks away, then the others close the gap
            card.reactive = false;
            card.set_pivot_point(0.5, 0.5);
            card.ease({
                opacity: 0,
                scale_x: 0.92,
                scale_y: 0.92,
                duration: 160,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => animateResize(this, () => card.destroy()),
            });
        }

        const added = activities.filter(a => !this._cards.has(a.id));
        const place = () => {
            activities.forEach((activity, i) => {
                let card = this._cards.get(activity.id);
                if (card) {
                    card.update(activity);
                } else {
                    card = new ActivityCard(activity);
                    this._cards.set(activity.id, card);
                    this.add_child(card);
                }
                this.set_child_at_index(card, i);
            });
        };
        if (animate && added.length > 0) {
            // Room opens up, and the new cards rise into it
            animateResize(this, place);
            added.forEach((activity, i) => {
                const card = this._cards.get(activity.id);
                card.set_pivot_point(0.5, 0);
                card.set({opacity: 0, scale_x: 0.94, scale_y: 0.94, translation_y: -8});
                card.ease({opacity: 255, delay: 60 + i * 40, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                springTo(card, {scale_x: 1, scale_y: 1, translation_y: 0}, {preset: 'bouncy', delay: 60 + i * 40});
            });
        } else {
            place();
        }
        this.visible = activities.length > 0;
    }
});

const NOTICE_TIME = 2200; // ms a notice stays in the island

// The island in the middle of the top bar: the first activity in short, how
// many more there are, the privacy dots, and a menu with all the activities.
// Notices take its place for a moment.
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
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._box.add_child(this._label);
        this._bars = new Bars();
        this._box.add_child(this._bars);
        this._more = new St.Label({style_class: 'gn-island-more', y_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._more);
        this._dots = new St.BoxLayout({style_class: 'gn-island-dots', y_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._dots);

        this.menu.box.add_style_class_name('gn-island-menu');
        this.menu.actor.add_style_class_name('gn-island-popover');
        this._list = new ActivityList({style_class: 'gn-live-list'});
        this.menu.box.add_child(this._list);
        this._expandFromIsland();

        this._activities = [];
        this._dotList = [];
        this._notice = null;
        this.visible = false;
        this.connect('destroy', () => {
            if (this._noticeId)
                GLib.source_remove(this._noticeId);
            this._noticeId = 0;
        });
    }

    // The menu is the island grown into a card, as the Dynamic Island
    // expands: it opens from the island's shape and place, the island giving
    // way to it, and shrinks back into it when it closes
    _expandFromIsland() {
        const pointer = this.menu._boxPointer;
        const open = pointer.open.bind(pointer);
        const close = pointer.close.bind(pointer);

        pointer.open = (animate, onComplete) => {
            pointer.remove_all_transitions();
            open(PopupAnimation.NONE, onComplete);
            if (!(animate & PopupAnimation.FULL) || !this.mapped)
                return;
            const grow = () => {
                const from = this._shapeFor(pointer);
                if (!from)
                    return;
                pointer.set_pivot_point(0.5, 0);
                pointer.set(from);
                springTo(pointer, {
                    scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0,
                }, {preset: 'bouncy'});
                this._list.set({opacity: 0});
                this._list.ease({opacity: 255, delay: 70, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            };
            // Its place is only known once it is laid out
            if (pointer.has_allocation())
                grow();
            const id = pointer.connect('notify::allocation', () => {
                pointer.disconnect(id);
                grow();
            });
            this._box.ease({opacity: 0, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        };

        pointer.close = (animate, onComplete) => {
            const done = () => {
                close(PopupAnimation.NONE, onComplete);
                pointer.set({scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0});
                this._list.opacity = 255;
                this._box.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                this.bump();
            };
            const to = animate & PopupAnimation.FULL && pointer.mapped ? this._shapeFor(pointer) : null;
            if (!to) {
                done();
                return;
            }
            pointer.set_pivot_point(0.5, 0);
            this._list.ease({opacity: 0, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            pointer.ease({
                ...to,
                duration: 220,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onStopped: done,
            });
        };
    }

    // Scale and offset that put the menu over the island, from its top
    // center
    _shapeFor(pointer) {
        const [ix, iy] = this._box.get_transformed_position();
        const [iw, ih] = this._box.get_transformed_size();
        const [px, py] = pointer.get_transformed_position();
        const [pw, ph] = pointer.get_transformed_size();
        if (!pw || !ph || !iw)
            return null;
        // The transformed size includes any scale already applied
        const scale = pointer.scale_x || 1;
        const width = pw / scale, height = ph / (pointer.scale_y || 1);
        const left = px - pointer.translation_x - width * (1 - scale) / 2;
        return {
            scale_x: Math.clamp(iw / width, 0.05, 1),
            scale_y: Math.clamp(ih / height, 0.05, 1),
            translation_x: ix + iw / 2 - (left + width / 2),
            translation_y: iy - (py - pointer.translation_y),
        };
    }

    sync(activities, dots) {
        this._list.sync(activities);
        this._activities = activities;
        this._dotList = dots;
        this._render();
    }

    notice(notice) {
        this._notice = notice;
        if (this._noticeId)
            GLib.source_remove(this._noticeId);
        this._noticeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NOTICE_TIME, () => {
            this._noticeId = 0;
            this._notice = null;
            this._render();
            return GLib.SOURCE_REMOVE;
        });
        this._render();
    }

    // A little jump, when a notification comes out of it or goes back in
    bump() {
        if (!this.visible || !this.mapped)
            return;
        this._box.set_pivot_point(0.5, 0.5);
        this._box.set({scale_x: 1.12, scale_y: 1.12});
        springTo(this._box, {scale_x: 1, scale_y: 1}, {preset: 'bouncy'});
    }

    // Where a notification comes out of: the island, or the clock while it
    // is hidden
    get origin() {
        if (this.visible && this.mapped)
            return this._box;
        return Main.panel.statusArea.dateMenu ?? null;
    }

    _render() {
        const activities = this._activities;
        const notice = this._notice;
        const first = notice ?? activities[0] ?? null;
        const dots = this._dotList;
        const wasVisible = this.visible;

        this.visible = !!first || dots.length > 0;
        // Nothing to open with only dots or a notice
        this.setSensitive(activities.length > 0);
        if (activities.length === 0)
            this.menu.close();
        if (!this.visible)
            return;

        const more = notice ? 0 : activities.length - 1;
        const change = () => {
            this._icon.visible = this._label.visible = !!first;
            if (first?.gicon)
                this._icon.gicon = first.gicon;
            else if (first)
                this._icon.icon_name = first.icon;
            if (notice)
                this._label.text = notice.detail ? `${notice.title} · ${notice.detail}` : notice.title;
            else if (first)
                this._label.text = first.short ?? first.title;
            this._bars.visible = !notice && first?.kind === 'media';
            this._bars.playing = !!first?.playing;
            this._bars.style = !notice && first?.accent ? `color: ${rgba(first.accent)};` : null;
            this._more.text = `+${more}`;
            this._more.visible = more > 0;
            this._dots.destroy_all_children();
            for (const dot of dots) {
                this._dots.add_child(new St.Widget({
                    style_class: `gn-island-dot ${dot.tone}`,
                    accessible_name: dot.label,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            this._dots.visible = dots.length > 0 && !notice;
            this._box.style_class = ['gn-island', first?.tone, first?.kind, notice ? 'notice' : null,
                first ? null : 'dots-only'].filter(Boolean).join(' ');
        };

        // It grows out of the clock when it appears, and eases to a new
        // width when what it shows changes
        const key = [notice?.title, notice?.detail, activities[0]?.id,
            activities[0]?.ticking ? '' : activities[0]?.short, more, dots.map(d => d.id).join()].join('|');
        if (!wasVisible && this.mapped) {
            change();
            this._box.set_pivot_point(0.5, 0.5);
            this._box.set({scale_x: 0.4, scale_y: 0.6, opacity: 0});
            this._box.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            springTo(this._box, {scale_x: 1, scale_y: 1}, {preset: 'bouncy'});
        } else if (key !== this._key && this.mapped) {
            // The new content fades in while the island takes its width
            animateResize(this._box, change, {width: true});
            for (const actor of this._box) {
                if (!actor.visible)
                    continue;
                actor.remove_transition('opacity');
                actor.opacity = 0;
                actor.ease({opacity: 255, delay: 80, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        } else {
            change();
        }
        this._key = key;
    }
});

// Notification banners come out of the island and go back into it, as on
// iOS, instead of sliding down from the top. The message tray's show and
// hide steps are replaced on the instance; they do what the shell's do,
// with another motion.
class BannerMorph {
    constructor(island) {
        this._island = island;
        this._tray = Main.messageTray;
    }

    enable() {
        const morph = this;
        this._tray._updateShowingNotification = function () {
            morph._show(this);
        };
        this._tray._hideNotification = function (animate) {
            morph._hide(this, animate);
        };
    }

    disable() {
        delete this._tray._updateShowingNotification;
        delete this._tray._hideNotification;
    }

    // The scale and offset that put the banner over the island, from its
    // top center
    _origin(tray) {
        const source = this._island.origin;
        const banner = tray._banner;
        if (!source || !banner)
            return null;
        const [sx, sy] = source.get_transformed_position();
        const [sw, sh] = source.get_transformed_size();
        const [, width] = banner.get_preferred_width(-1);
        const [, height] = banner.get_preferred_height(width);
        const [tx, ty] = tray.get_transformed_position();
        const [tw] = tray.get_transformed_size();
        if (!width || !height || !tw)
            return null;
        return {
            scale_x: Math.clamp(sw / width, 0.1, 1),
            scale_y: Math.clamp(sh / height, 0.05, 1),
            translation_x: sx + sw / 2 - (tx + tw / 2),
            translation_y: sy - ty,
        };
    }

    _show(tray) {
        const notification = tray._notification;
        notification.acknowledged = true;
        notification.playSound();
        if (notification.urgency === MessageTray.Urgency.CRITICAL ||
            notification.source.policy.forceExpanded)
            tray._expandBanner(true);

        const bin = tray._bannerBin;
        // A new banner, or one coming back while it hid
        const fresh = tray._notificationState !== MessageTray.State.SHOWN;
        tray._notificationState = MessageTray.State.SHOWING;
        bin.remove_all_transitions();
        bin.y = 0;
        bin.set_pivot_point(0.5, 0);

        const origin = fresh ? this._origin(tray) : null;
        if (origin)
            bin.set({...origin, opacity: 0});
        else if (fresh)
            bin.set({translation_y: -bin.height, opacity: 0});
        else
            bin.set({scale_x: 0.96, scale_y: 0.96});

        // The banner shows once it has room, so squeezed text is not seen
        bin.ease({opacity: 255, delay: fresh ? 70 : 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        bin.ease({
            translation_x: 0,
            translation_y: 0,
            duration: 420,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        });
        bin.ease({
            scale_x: 1,
            scale_y: 1,
            duration: 420,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
            onComplete: () => {
                tray._notificationState = MessageTray.State.SHOWN;
                tray._showNotificationCompleted();
                tray._updateState();
            },
        });
        if (fresh)
            this._island.bump();
    }

    _hide(tray, animate) {
        tray._notificationFocusGrabber.ungrabFocus();
        tray._banner.disconnectObject(tray);
        tray._resetNotificationLeftTimeout();

        const bin = tray._bannerBin;
        bin.remove_all_transitions();
        tray._notificationState = MessageTray.State.HIDING;

        const duration = animate ? 300 : 0;
        const origin = animate ? this._origin(tray) : null;
        const finish = () => {
            bin.set({scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0});
            tray._notificationState = MessageTray.State.HIDDEN;
            tray._hideNotificationCompleted();
            // Hiding at once happens inside the tray's own update, which
            // would skip showing the next notification
            if (tray._updatingState) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    tray._updateState();
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                tray._updateState();
            }
        };

        bin.set_pivot_point(0.5, 0);
        bin.ease({
            opacity: 0,
            delay: duration * 0.25,
            duration: duration * 0.55,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
        bin.ease({
            ...origin ?? {translation_y: -bin.height},
            duration,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onStopped: () => {
                finish();
                if (origin)
                    this._island.bump();
            },
        });
    }
}

// "Live Activities" (iOS) and live updates (Android 16): timers, the
// stopwatch, screen recordings, the progress of downloads and copies and the
// music playing show
// in an island in the top bar and at the top of Quick Settings while they
// last
export class LiveActivities {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        this._sources = [new ScreenRecording(), new TimerActivities(), new LauncherProgress(), new NowPlaying()];
        this._sources.forEach(source => source.connectObject('changed', () => this._queueSync(), this));

        this._status = new StatusIndicators();
        this._status.connectObject(
            'changed', () => this._queueSync(),
            'notice', (_s, notice) => this._island.notice(notice),
            this);

        this._island = new Island();
        Main.panel.addToStatusArea('gn-live-activities', this._island, 1, 'center');

        this._settings.connectObject('changed::island-notifications', () => this._syncMorph(), this);
        this._syncMorph();

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

        this._settings.disconnectObject(this);
        this._morph?.disable();
        this._morph = null;
        this._status.disconnectObject(this);
        this._status.destroy();
        this._status = null;

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

    _syncMorph() {
        const wanted = this._settings.get_boolean('island-notifications');
        if (wanted && !this._morph) {
            this._morph = new BannerMorph(this._island);
            this._morph.enable();
        } else if (!wanted && this._morph) {
            this._morph.disable();
            this._morph = null;
        }
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
        this._island.sync(activities, this._status.dots());
        // Quick Settings has its own player when notifications are in it
        const hasPlayer = !!Main.panel.statusArea.quickSettings.menu._gnMedia;
        this._section.sync(activities.filter(a => a.kind !== 'media' || !hasPlayer));

        // Clocks move every second while they are on screen
        const ticking = activities.some(a => a.ticking || a.refresh);
        if (ticking && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000 - Date.now() % 1000 + 5, () => {
                this._tickId = 0;
                this._sync();
                return GLib.SOURCE_REMOVE;
            });
        }
    }
}
