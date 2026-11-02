import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {NowPlaying, ProgressBar, rgba} from './live.js';
import {addPressFeedback, springTo} from './spring.js';

const HIDDEN = 'gn-lock-player';

// A large player under the lock screen clock, as on iOS, in place of the
// small one the shell lists among the notifications: the cover, title and
// artist, a bar that can be dragged, and previous, play/pause and next. It
// takes the color of the cover. Only this runs while the screen is locked.
export class LockScreenPlayer {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        this._source = new NowPlaying();
        this._source.connectObject('changed', () => this._sync(), this);
        // There is no lock screen without a display manager
        Main.screenShield?.connectObject(
            'lock-screen-shown', () => this._attach(),
            'active-changed', () => this._attach(),
            this);
        this._attach();
    }

    disable() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        Main.screenShield?.disconnectObject(this);
        this._source.disconnectObject(this);
        this._source.destroy();
        this._source = null;
        this._detach();
    }

    _attach() {
        const dialog = Main.screenShield?._dialog;
        const clock = dialog?._clock;
        if (!clock || dialog === this._dialog)
            return;
        this._detach();
        this._dialog = dialog;
        dialog.connectObject('destroy', () => {
            // The card went with it
            this._card = null;
            this._detach();
        }, this);

        this._card = this._build();
        clock.add_child(this._card);

        // The shell's own player among the notifications goes
        const box = dialog._notificationsBox;
        if (box?._players) {
            const hideAll = () => {
                for (const message of box._players.values())
                    this._lock.hide(message, HIDDEN);
                box._updateVisibility?.();
            };
            box._mediaSource?.connectObject('player-added', hideAll, this);
            hideAll();
            this._box = box;
        }
        this._sync();
    }

    _detach() {
        this._box?._mediaSource?.disconnectObject(this);
        this._lock.releaseAll(HIDDEN);
        this._box?._updateVisibility?.();
        this._box = null;
        this._dialog?.disconnectObject(this);
        this._dialog = null;
        this._card?.destroy();
        this._card = null;
    }

    _build() {
        const card = new St.BoxLayout({
            style_class: 'gn-lock-player',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        const row = new St.BoxLayout({style_class: 'gn-lock-player-row'});
        card.add_child(row);
        this._art = new St.Widget({style_class: 'gn-lock-player-art', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(this._art);
        this._icon = new St.Icon({style_class: 'gn-lock-player-icon', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(this._icon);
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(text);
        this._title = new St.Label({style_class: 'gn-lock-player-title'});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._title);
        this._artist = new St.Label({style_class: 'gn-lock-player-artist'});
        this._artist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._artist);

        this._progress = new ProgressBar();
        this._progress.add_style_class_name('gn-lock-player-progress');
        card.add_child(this._progress);
        const times = new St.BoxLayout({style_class: 'gn-lock-player-times'});
        this._elapsed = new St.Label({style_class: 'gn-lock-player-time', x_expand: true});
        this._left = new St.Label({style_class: 'gn-lock-player-time'});
        times.add_child(this._elapsed);
        times.add_child(this._left);
        card.add_child(times);
        this._times = times;

        this._controls = new St.BoxLayout({
            style_class: 'gn-lock-player-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });
        card.add_child(this._controls);
        return card;
    }

    _sync() {
        if (!this._card)
            return;
        const media = this._source.activities()[0] ?? null;
        const wasVisible = this._card.visible;
        this._card.visible = !!media;
        if (!media)
            return;

        this._art.visible = !!media.art;
        this._icon.visible = !media.art;
        if (media.art && media.art !== this._artUrl) {
            this._artUrl = media.art;
            this._art.style = `background-image: url("${media.art.replaceAll('"', '%22')}");`;
        }
        if (!media.art)
            this._icon.gicon = media.gicon;
        this._title.text = media.title;
        this._artist.text = media.detail ?? '';

        const accent = media.accent;
        this._card.style = accent
            ? `background-gradient-direction: vertical; background-gradient-start: ${rgba(accent, 0.38)}; background-gradient-end: ${rgba(accent, 0.12)};`
            : null;
        this._progress.style = accent ? `color: ${rgba(accent)};` : null;

        this._progress.visible = media.progress !== null && media.progress !== undefined;
        this._times.visible = this._progress.visible && !!media.times;
        if (this._progress.visible) {
            this._progress.fraction = media.progress;
            this._progress.seek = media.seek ?? null;
        }
        if (this._times.visible)
            [this._elapsed.text, this._left.text] = media.times;

        // Buttons only change with play and pause
        const key = media.actions.map(a => a.icon).join();
        if (key !== this._actionsKey) {
            this._actionsKey = key;
            this._controls.destroy_all_children();
            media.actions.forEach((action, i) => {
                const button = new St.Button({
                    style_class: `button gn-lock-player-button${i === 1 ? ' main' : ''}`,
                    icon_name: action.icon,
                    accessible_name: action.label,
                    can_focus: true,
                });
                button.connect('clicked', () => {
                    this._source.activities()[0]?.actions[i]?.run();
                    return Clutter.EVENT_STOP;
                });
                addPressFeedback(button, {scale: 0.85});
                this._controls.add_child(button);
            });
        }

        if (!wasVisible && this._card.mapped) {
            this._card.set_pivot_point(0.5, 0);
            this._card.set({opacity: 0, scale_x: 0.94, scale_y: 0.94});
            this._card.ease({opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            springTo(this._card, {scale_x: 1, scale_y: 1}, {preset: 'smooth'});
        }

        // The position moves every second while it plays
        if (media.refresh && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._tickId = 0;
                this._sync();
                return GLib.SOURCE_REMOVE;
            });
        }
    }
}
