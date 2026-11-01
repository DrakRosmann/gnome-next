import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const FALLBACK_ICON = 'audio-x-generic-symbolic';

// The app a stream comes from, for its name and icon
function lookupApp(stream) {
    const appSystem = Shell.AppSystem.get_default();
    const id = stream.get_application_id();
    if (id) {
        const app = appSystem.lookup_app(`${id}.desktop`) ??
            appSystem.lookup_desktop_wmclass(id);
        if (app)
            return app;
    }
    const name = stream.get_name();
    return name ? appSystem.lookup_desktop_wmclass(name) : null;
}

// One app playing sound: its icon (click to mute) and a volume slider
const AppStreamItem = GObject.registerClass(
class GnAppStreamItem extends PopupMenu.PopupBaseMenuItem {
    constructor(control, stream) {
        super({activate: false, style_class: 'gn-app-volume'});
        this._control = control;
        this._stream = stream;

        const app = lookupApp(stream);
        const name = app?.get_name() || stream.get_name() || stream.get_description() || _('Unknown App');

        this._mute = new St.Button({
            style_class: 'button gn-app-volume-icon',
            can_focus: true,
            toggle_mode: true,
            child: new St.Icon({
                gicon: app?.get_icon() ??
                    (stream.get_icon_name() ? Gio.ThemedIcon.new(stream.get_icon_name()) : null),
                fallback_icon_name: FALLBACK_ICON,
            }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._mute.connect('clicked', () => stream.change_is_muted(!stream.is_muted));
        this.add_child(this._mute);

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'gn-app-volume-box',
        });
        box.add_child(new St.Label({style_class: 'gn-app-volume-name', text: name}));
        this._slider = new Slider(0);
        this._slider.accessible_name = _('Volume of %s').format(name);
        this._slider.connect('notify::value', () => this._onSliderChanged());
        box.add_child(this._slider);
        this.add_child(box);

        stream.connectObject(
            'notify::volume', () => this._sync(),
            'notify::is-muted', () => this._sync(),
            this);
        this.connect('destroy', () => stream.disconnectObject(this));
        this._sync();
    }

    _sync() {
        const muted = this._stream.is_muted;
        this._mute.checked = muted;
        this._mute.accessible_name = muted ? _('Unmute') : _('Mute');
        this.opacity = muted ? 140 : 255;
        if (this._changing)
            return;
        this._syncing = true;
        this._slider.value = Math.min(1, this._stream.volume / this._control.get_vol_max_norm());
        this._syncing = false;
    }

    _onSliderChanged() {
        if (this._syncing)
            return;
        this._changing = true;
        const volume = this._slider.value * this._control.get_vol_max_norm();
        this._stream.volume = volume;
        this._stream.push_volume();
        if (this._stream.is_muted && volume > 0)
            this._stream.change_is_muted(false);
        this._changing = false;
    }
});

// Per-app volume, as in the Windows mixer and the COSMIC applet: the menu of
// the output volume slider lists every app playing sound with its own slider.
export class AppVolume {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        const output = Main.panel.statusArea.quickSettings._volumeOutput?._output;
        if (!output?.menu)
            throw new Error('No volume slider');
        this._menu = output.menu;
        this._control = getMixerControl();
        this._items = new Map();

        this._section = new PopupMenu.PopupMenuSection();
        this._separator = new PopupMenu.PopupSeparatorMenuItem(_('Apps'));
        this._section.addMenuItem(this._separator);
        // Right after the list of outputs
        const position = this._menu._getMenuItems().indexOf(output._deviceSection) + 1;
        this._menu.addMenuItem(this._section, position);

        this._control.connectObject(
            'stream-added', (_c, id) => this._add(id),
            'stream-removed', (_c, id) => this._remove(id),
            'state-changed', () => this._reload(),
            this);
        this._reload();
    }

    disable() {
        this._control.disconnectObject(this);
        this._section.destroy();
        this._section = null;
        this._items = null;
        this._menu = null;
    }

    _reload() {
        [...this._items.keys()].forEach(id => this._remove(id));
        if (this._control.get_state() === Gvc.MixerControlState.READY)
            this._control.get_sink_inputs().forEach(stream => this._add(stream.id));
    }

    _add(id) {
        if (this._items.has(id))
            return;
        const stream = this._control.lookup_stream_id(id);
        if (!(stream instanceof Gvc.MixerSinkInput) || stream.is_event_stream)
            return;
        // Volume Control and the like are not apps playing sound
        if (stream.get_application_id() === 'org.gnome.VolumeControl')
            return;

        const item = new AppStreamItem(this._control, stream);
        this._items.set(id, item);
        this._section.addMenuItem(item);
        this._sync();
    }

    _remove(id) {
        this._items.get(id)?.destroy();
        this._items.delete(id);
        this._sync();
    }

    _sync() {
        this._section.actor.visible = this._items.size > 0;
    }
}
