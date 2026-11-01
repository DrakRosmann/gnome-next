import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Mpris from 'resource:///org/gnome/shell/ui/mpris.js';

import {addPressFeedback, springTo} from './spring.js';

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const POSITION_INTERVAL = 1; // seconds

// MprisSource has no way to stop watching the bus, so a new one per enable
// (the extension is re-enabled after every unlock) would leak its D-Bus
// subscriptions. Share the one the shell's message list already keeps.
let fallbackSource = null;
export function mprisSource() {
    const shellSource = Main.panel.statusArea.dateMenu?._messageList?._messageView?._mediaSource;
    if (shellSource instanceof Mpris.MprisSource)
        return shellSource;
    fallbackSource ??= new Mpris.MprisSource();
    return fallbackSource;
}

// Media player card. "full" is the Quick Settings layout with transport
// controls under the track and a progress bar, "compact" is the single row
// shown while notifications are expanded.
export const MediaCard = GObject.registerClass(
class GnMediaCard extends St.Button {
    constructor() {
        super({
            style_class: 'message gn-media',
            can_focus: true,
            x_expand: true,
            visible: false,
        });

        this._player = null;
        this._compact = false;
        this._positionId = 0;
        this._cancellable = new Gio.Cancellable();

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.child = box;

        const row = new St.BoxLayout({style_class: 'gn-media-row', x_expand: true});
        box.add_child(row);

        this._cover = new St.Icon({
            style_class: 'gn-media-cover',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(this._cover);

        const info = new St.BoxLayout({
            style_class: 'gn-media-info',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(info);

        this._title = new St.Label({style_class: 'gn-media-title'});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        info.add_child(this._title);

        this._artist = new St.Label({style_class: 'gn-media-artist'});
        this._artist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        info.add_child(this._artist);

        this._fullControls = new St.BoxLayout({style_class: 'gn-media-controls'});
        info.add_child(this._fullControls);
        this._prevButton = this._addControl(this._fullControls,
            'media-skip-backward-symbolic', () => this._player?.previous());
        this._playButton = this._addControl(this._fullControls,
            'media-playback-start-symbolic', () => this._player?.playPause());
        this._playButton.add_style_class_name('play');
        this._nextButton = this._addControl(this._fullControls,
            'media-skip-forward-symbolic', () => this._player?.next());

        this._compactControls = new St.BoxLayout({
            style_class: 'gn-media-controls compact',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(this._compactControls);
        this._compactPlayButton = this._addControl(this._compactControls,
            'media-playback-start-symbolic', () => this._player?.playPause());
        this._compactNextButton = this._addControl(this._compactControls,
            'media-skip-forward-symbolic', () => this._player?.next());

        this._progress = new St.Widget({
            style_class: 'gn-media-progress',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        this._progressFill = new St.Widget({
            style_class: 'gn-media-progress-fill',
            x_align: Clutter.ActorAlign.START,
            width: 0,
        });
        this._progress.add_child(this._progressFill);
        this._progress.connect('notify::allocation', () => {
            // Only a new track width; allocations caused by the fill moving
            // must not cut its easing short
            const width = this._progress.get_allocation_box().get_width();
            if (width !== this._progressWidth) {
                this._progressWidth = width;
                this._syncProgress();
            }
        });
        box.add_child(this._progress);
        this._fraction = 0;

        this._source = mprisSource();
        this._source.connectObject(
            'player-added', () => this._pickPlayer(),
            'player-removed', (_source, player) => {
                player.disconnectObject(this);
                this._pickPlayer();
            },
            this);

        this.connect('notify::mapped', () => this._syncPositionPolling());
        addPressFeedback(this, {scale: 0.98});
        this.connect('destroy', () => this._onDestroy());

        this.setCompact(false);
        this._pickPlayer();
    }

    _addControl(box, iconName, callback) {
        const button = new St.Button({
            style_class: 'button gn-media-button',
            icon_name: iconName,
            can_focus: true,
        });
        button.connect('clicked', () => {
            callback();
            return Clutter.EVENT_STOP;
        });
        box.add_child(button);
        addPressFeedback(button, {scale: 0.86});
        return button;
    }

    setCompact(compact) {
        this._compact = compact;
        if (compact)
            this.add_style_class_name('compact');
        else
            this.remove_style_class_name('compact');
        this._fullControls.visible = !compact;
        this._compactControls.visible = compact;
        this._syncProgress();
    }

    _pickPlayer() {
        const players = this._source.players;
        const player = players.find(p => p.status === 'Playing') ?? players[0] ?? null;

        // Follow whichever player starts playing
        players.forEach(p => {
            p.disconnectObject(this);
            p.connectObject('changed', () => {
                if (p !== this._player && p.status === 'Playing')
                    this._setPlayer(p);
                else if (p === this._player)
                    this._update();
            }, this);
        });

        this._setPlayer(player);
    }

    _setPlayer(player) {
        this._player = player;
        this._fraction = 0;
        this._update();
    }

    _update() {
        const player = this._player;
        this.visible = !!player;
        if (!player) {
            this._syncPositionPolling();
            return;
        }

        // A new track: the cover fades and springs in
        const trackKey = `${player.trackCoverUrl}|${player.trackTitle}`;
        if (this._trackKey !== undefined && trackKey !== this._trackKey && this.mapped) {
            this._cover.set_pivot_point(0.5, 0.5);
            this._cover.set({opacity: 0, scale_x: 0.85, scale_y: 0.85});
            this._cover.ease({opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            springTo(this._cover, {scale_x: 1, scale_y: 1}, {preset: 'bouncy'});
        }
        this._trackKey = trackKey;

        if (player.trackCoverUrl) {
            this._cover.gicon = new Gio.FileIcon({
                file: Gio.File.new_for_uri(player.trackCoverUrl),
            });
            this._cover.remove_style_class_name('placeholder');
        } else {
            this._cover.gicon = new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
            this._cover.add_style_class_name('placeholder');
        }

        this._title.text = player.trackTitle || player.app?.get_name() || '';
        this._artist.text = player.trackArtists.join(', ');
        this._artist.visible = this._artist.text.length > 0;

        const playing = player.status === 'Playing';
        const icon = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        // Play/pause swaps its icon with a little pop
        if (this._playButton.icon_name !== icon && this.mapped) {
            [this._playButton, this._compactPlayButton].forEach(button => {
                const child = button.get_child();
                child?.set_pivot_point(0.5, 0.5);
                child?.set({scale_x: 0.6, scale_y: 0.6});
                if (child)
                    springTo(child, {scale_x: 1, scale_y: 1}, {preset: 'bouncy'});
            });
        }
        this._playButton.icon_name = icon;
        this._compactPlayButton.icon_name = icon;

        this._prevButton.reactive = player.canGoPrevious;
        this._nextButton.reactive = player.canGoNext;
        this._compactNextButton.reactive = player.canGoNext;

        this._syncPositionPolling();
        this._queryPosition();
    }

    _trackLength() {
        // MprisPlayer does not expose the metadata, read it from its proxy
        const length = this._player?._playerProxy?.Metadata?.['mpris:length'];
        try {
            return length ? Number(length.deepUnpack()) : 0;
        } catch {
            return 0;
        }
    }

    _syncPositionPolling() {
        const wanted = this.mapped && this._player?.status === 'Playing';
        if (wanted && !this._positionId) {
            this._positionId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                POSITION_INTERVAL, () => {
                    this._queryPosition();
                    return GLib.SOURCE_CONTINUE;
                });
        } else if (!wanted && this._positionId) {
            GLib.source_remove(this._positionId);
            this._positionId = 0;
        }
    }

    _queryPosition() {
        const busName = this._player?._busName;
        const length = this._trackLength();
        if (!busName || length <= 0) {
            this._fraction = 0;
            this._progress.visible = false;
            return;
        }

        Gio.DBus.session.call(busName, MPRIS_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [MPRIS_PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1,
            this._cancellable, (conn, res) => {
                try {
                    const [position] = conn.call_finish(res).deepUnpack();
                    this._fraction = Math.clamp(Number(position.deepUnpack()) / length, 0, 1);
                    this._progress.visible = true;
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    this._fraction = 0;
                    this._progress.visible = false;
                }
                this._syncProgress(true);
            });
    }

    // `animate`: glide to the new position over the polling interval, so the
    // bar moves continuously while playing instead of jumping every second
    _syncProgress(animate = false) {
        if (this._compact)
            this._progress.hide();
        else if (this._fraction > 0)
            this._progress.show();
        if (!this._progress.has_allocation())
            return;

        const width = Math.round(this._progress.get_allocation_box().get_width() * this._fraction);
        this._progressFill.remove_transition('width');
        const delta = width - this._progressFill.width;
        // Seeking or a new track jumps instead of crawling backwards
        if (animate && this.mapped && this._player?.status === 'Playing' && delta > 0 && delta < 40) {
            this._progressFill.ease({
                width,
                duration: POSITION_INTERVAL * 1000,
                mode: Clutter.AnimationMode.LINEAR,
            });
        } else {
            this._progressFill.width = width;
        }
    }

    vfunc_clicked() {
        if (!this._player)
            return;
        this._player.raise();
        Main.panel.closeQuickSettings();
    }

    _onDestroy() {
        this._cancellable.cancel();
        if (this._positionId)
            GLib.source_remove(this._positionId);
        this._positionId = 0;
        this._source.disconnectObject(this);
        this._source.players.forEach(p => p.disconnectObject(this));
    }
});
