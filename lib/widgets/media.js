import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {mprisSource} from '../media.js';
import {addPressFeedback, springTo} from '../spring.js';
import {Widget, closeCalendar, label, placeholder, vbox} from './base.js';

// Now playing: cover, track and controls. Empty (left out of the board)
// while no player is running.
export const MediaWidget = GObject.registerClass(
class GnMediaWidget extends Widget {
    constructor(size) {
        super(size, {accessible_name: _('Now Playing')});
        this.add_style_class_name('gn-media-widget');
        this._player = null;

        const box = vbox({x_expand: true, y_expand: true});
        this.child = box;

        this._content = new St.BoxLayout({style_class: 'gn-media-widget-box', x_expand: true, y_expand: true});
        if (!this.medium)
            this._content.orientation = Clutter.Orientation.VERTICAL;
        box.add_child(this._content);
        this._placeholder = placeholder('folder-music-symbolic', _('Shows up when something plays'));
        box.add_child(this._placeholder);

        const top = new St.BoxLayout({x_expand: !this.medium});
        this._content.add_child(top);
        this._cover = new St.Icon({style_class: 'gn-media-widget-cover', y_align: Clutter.ActorAlign.START});
        top.add_child(this._cover);
        if (this.small) {
            this._appIcon = new St.Icon({
                style_class: 'gn-media-widget-app',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
            });
            top.add_child(this._appIcon);
        }

        const info = vbox({x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.END});
        this._content.add_child(info);
        this._title = label('gn-media-widget-title');
        info.add_child(this._title);
        this._artist = label('gn-widget-dim');
        info.add_child(this._artist);

        const controls = new St.BoxLayout({
            style_class: 'gn-media-widget-controls',
            x_align: this.small ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
            x_expand: !this.small,
        });
        info.add_child(controls);
        if (!this.small)
            this._prev = this._button(controls, 'media-skip-backward-symbolic', () => this._player?.previous());
        this._play = this._button(controls, 'media-playback-start-symbolic', () => this._player?.playPause());
        this._play.add_style_class_name('play');
        this._next = this._button(controls, 'media-skip-forward-symbolic', () => this._player?.next());

        this._source = mprisSource();
        this._source.connectObject(
            'player-added', () => this._pickPlayer(),
            'player-removed', (_s, player) => {
                player.disconnectObject(this);
                this._pickPlayer();
            }, this);
        this.connect('destroy', () => {
            this._source.disconnectObject(this);
            this._source.players.forEach(p => p.disconnectObject(this));
        });
        this._pickPlayer();
    }

    get medium() {
        return this.widgetSize === 'medium';
    }

    _button(box, iconName, callback) {
        const button = new St.Button({
            style_class: 'button gn-media-button',
            icon_name: iconName,
            can_focus: true,
        });
        button.connect('clicked', () => {
            callback();
            return Clutter.EVENT_STOP;
        });
        addPressFeedback(button, {scale: 0.86});
        box.add_child(button);
        return button;
    }

    _pickPlayer() {
        const players = this._source.players;
        players.forEach(p => {
            p.disconnectObject(this);
            p.connectObject('changed', () => {
                if (p !== this._player && p.status === 'Playing')
                    this._player = p;
                this._sync();
            }, this);
        });
        this._player = players.find(p => p.status === 'Playing') ?? players[0] ?? null;
        this._sync();
    }

    _sync() {
        const player = this._player;
        this.empty = !player;
        this._placeholder.visible = !player;
        this._content.visible = !!player;
        if (!player)
            return;

        if (player.trackCoverUrl) {
            this._cover.gicon = new Gio.FileIcon({file: Gio.File.new_for_uri(player.trackCoverUrl)});
            this._cover.remove_style_class_name('placeholder');
        } else {
            this._cover.gicon = new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
            this._cover.add_style_class_name('placeholder');
        }
        if (this._appIcon)
            this._appIcon.gicon = player.app?.get_icon() ?? null;

        this._title.text = player.trackTitle || player.app?.get_name() || '';
        this._artist.text = player.trackArtists.join(', ');

        const icon = player.status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        if (this._play.icon_name !== icon && this.mapped) {
            const child = this._play.get_child();
            child?.set_pivot_point(0.5, 0.5);
            child?.set({scale_x: 0.6, scale_y: 0.6});
            if (child)
                springTo(child, {scale_x: 1, scale_y: 1}, {preset: 'bouncy'});
        }
        this._play.icon_name = icon;
        if (this._prev)
            this._prev.reactive = player.canGoPrevious;
        this._next.reactive = player.canGoNext;
    }

    activate() {
        if (!this._player)
            return;
        this._player.raise();
        closeCalendar();
    }
});
