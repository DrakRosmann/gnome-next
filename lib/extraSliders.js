import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import Gvc from 'gi://Gvc';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const COLOR_SCHEMA = 'org.gnome.settings-daemon.plugins.color';
// The range the Settings app offers, warmest last
const WARM = 1700;
const COOL = 4700;

// Night Light warmth: further right is warmer. Clicking the icon turns
// Night Light on or off; moving the slider turns it on.
const NightLightSlider = GObject.registerClass(
class GnNightLightSlider extends QuickSlider {
    constructor() {
        super({iconName: 'night-light-symbolic', iconReactive: true});
        this.slider.accessible_name = _('Night Light Warmth');
        this.iconLabel = _('Night Light');
        // A change, so the arrow the slider starts with goes away
        this.menuEnabled = true;
        this.menuEnabled = false;

        this._settings = new Gio.Settings({schema_id: COLOR_SCHEMA});
        this._settings.connectObject(
            'changed::night-light-temperature', () => this._sync(),
            'changed::night-light-enabled', () => this._sync(),
            this);
        this._changedId = this.slider.connect('notify::value', () => this._onSliderChanged());
        this.connect('icon-clicked', () => {
            const enabled = this._settings.get_boolean('night-light-enabled');
            this._settings.set_boolean('night-light-enabled', !enabled);
        });
        this.connect('destroy', () => this._settings.disconnectObject(this));
        this._sync();
    }

    _sync() {
        const temperature = this._settings.get_uint('night-light-temperature');
        this.slider.block_signal_handler(this._changedId);
        this.slider.value = Math.clamp((COOL - temperature) / (COOL - WARM), 0, 1);
        this.slider.unblock_signal_handler(this._changedId);
        // Dimmed while Night Light is off
        this.slider.opacity = this._settings.get_boolean('night-light-enabled') ? 255 : 128;
    }

    _onSliderChanged() {
        const temperature = Math.round(COOL - this.slider.value * (COOL - WARM));
        this._settings.set_uint('night-light-temperature', temperature);
        if (!this._settings.get_boolean('night-light-enabled'))
            this._settings.set_boolean('night-light-enabled', true);
    }
});

const POWER_BUS = 'org.gnome.SettingsDaemon.Power';
const POWER_PATH = '/org/gnome/SettingsDaemon/Power';
const KEYBOARD_IFACE = 'org.gnome.SettingsDaemon.Power.Keyboard';

// Keyboard backlight as a slider; hidden on keyboards without one
const KeyboardSlider = GObject.registerClass(
class GnKeyboardSlider extends QuickSlider {
    constructor() {
        super({iconName: 'keyboard-brightness-symbolic', iconReactive: true, visible: false});
        this.slider.accessible_name = _('Keyboard Brightness');
        this.iconLabel = _('Keyboard Brightness');
        // A change, so the arrow the slider starts with goes away
        this.menuEnabled = true;
        this.menuEnabled = false;
        this._last = 100;

        this._cancellable = new Gio.Cancellable();
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
            POWER_BUS, POWER_PATH, KEYBOARD_IFACE, this._cancellable, (_o, res) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch {
                    return;
                }
                this._proxy.connectObject('g-properties-changed', () => this._sync(), this);
                this._sync();
            });
        this._changedId = this.slider.connect('notify::value', () =>
            this._set(Math.round(this.slider.value * 100)));
        this.connect('icon-clicked', () => {
            const value = this._brightness();
            if (value > 0)
                this._last = value;
            this._set(value > 0 ? 0 : this._last);
        });
        this.connect('destroy', () => {
            this._cancellable.cancel();
            this._proxy?.disconnectObject(this);
        });
    }

    _brightness() {
        return this._proxy?.get_cached_property('Brightness')?.unpack() ?? -1;
    }

    _sync() {
        const brightness = this._brightness();
        this.visible = Number.isInteger(brightness) && brightness >= 0;
        if (!this.visible)
            return;
        this.slider.block_signal_handler(this._changedId);
        this.slider.value = brightness / 100;
        this.slider.unblock_signal_handler(this._changedId);
    }

    _set(value) {
        this._proxy?.call('org.freedesktop.DBus.Properties.Set',
            new GLib.Variant('(ssv)', [KEYBOARD_IFACE, 'Brightness', new GLib.Variant('i', value)]),
            Gio.DBusCallFlags.NONE, -1, null, null);
    }
});

let MicrophoneSlider = null;

// The shell's microphone slider only shows while an app records; this one
// stays, like the volume slider. It keeps the shell's menu of inputs.
function createMicrophoneSlider() {
    const shellSlider = Main.panel.statusArea.quickSettings?._volumeInput?.quickSettingsItems?.[0];
    if (!shellSlider)
        return null;
    MicrophoneSlider ??= GObject.registerClass({
        GTypeName: 'GnMicrophoneSlider',
    }, class GnMicrophoneSlider extends shellSlider.constructor {
        _shouldBeVisible() {
            return this._stream !== null && this._stream !== undefined;
        }
    });

    const control = getMixerControl();
    const slider = new MicrophoneSlider(control);
    const read = () => {
        if (control.get_state() === Gvc.MixerControlState.READY)
            slider.stream = control.get_default_source();
    };
    control.connectObject(
        'state-changed', read,
        'default-source-changed', read,
        slider);
    read();
    return slider;
}

// Sliders the editor can add, see EXTRA_TOGGLES
export const EXTRA_SLIDERS = [
    {id: 'microphone-slider', create: createMicrophoneSlider},
    {id: 'night-light-slider', create: () => new NightLightSlider()},
    {id: 'keyboard-slider', create: () => new KeyboardSlider()},
];
