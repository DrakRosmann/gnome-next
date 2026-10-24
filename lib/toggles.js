import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as A11y from 'resource:///org/gnome/shell/ui/status/accessibility.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {QuickToggle, QuickMenuToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Visibility lock reason for toggles removed in the editor
export const REMOVED_REASON = 'gn-removed';

// Category titles are translated lazily: gettext is not ready at import time
export const CATEGORIES = [
    {id: 'connectivity', title: () => _('Connectivity')},
    {id: 'device', title: () => _('Device')},
    {id: 'personalization', title: () => _('Personalization')},
    {id: 'privacy', title: () => _('Privacy')},
    {id: 'accessibility', title: () => _('Accessibility')},
    {id: 'other', title: () => _('Extensions')},
];

const SHELL_CATEGORIES = {
    NMWirelessToggle: 'connectivity',
    NMWiredToggle: 'connectivity',
    NMBluetoothToggle: 'connectivity',
    NMModemToggle: 'connectivity',
    NMVpnToggle: 'connectivity',
    BluetoothToggle: 'connectivity',
    RfkillToggle: 'connectivity',
    PowerProfilesToggle: 'device',
    KeyboardBrightnessToggle: 'device',
    RotationToggle: 'device',
    DarkModeToggle: 'personalization',
    NightLightToggle: 'personalization',
    DoNotDisturbToggle: 'personalization',
};

const SettingsToggle = GObject.registerClass(
class GnSettingsToggle extends QuickToggle {
    constructor({title, iconName, schema, key, invert = false}) {
        super({title, iconName, toggleMode: true, visible: true});

        this._settings = new Gio.Settings({schemaId: schema});
        this._settings.bind(key, this, 'checked', invert
            ? Gio.SettingsBindFlags.INVERT_BOOLEAN
            : Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind_writable(key, this, 'reactive', false);
    }
});

const ScreenshotToggle = GObject.registerClass(
class GnScreenshotToggle extends QuickToggle {
    constructor() {
        super({
            title: _('Screenshot'),
            iconName: 'screenshooter-symbolic',
            visible: !Main.sessionMode.isGreeter,
        });

        this.connect('clicked', () => {
            const laters = global.compositor.get_laters();
            laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
                Main.screenshotUI.open().catch(logError);
                return GLib.SOURCE_REMOVE;
            });
            Main.panel.statusArea.quickSettings.menu.close(PopupAnimation.NONE);
        });
    }
});

const UPOWER_BUS = 'org.freedesktop.UPower';
const UPOWER_DEVICE_IFACE = 'org.freedesktop.UPower.Device';
const UPOWER_DEVICE_TYPE_BATTERY = 2;

// Limits charging to preserve battery health, when the battery supports it
const BatteryHealthToggle = GObject.registerClass(
class GnBatteryHealthToggle extends QuickToggle {
    constructor() {
        super({
            title: _('Battery Health'),
            iconName: 'battery-level-80-symbolic',
            visible: false,
        });

        this._proxy = null;
        this._cancellable = new Gio.Cancellable();

        this.connect('clicked', () => this._toggle());
        this.connect('destroy', () => this._cancellable.cancel());

        Gio.DBus.system.call(UPOWER_BUS, '/org/freedesktop/UPower',
            UPOWER_BUS, 'EnumerateDevices', null,
            new GLib.VariantType('(ao)'), Gio.DBusCallFlags.NONE, -1,
            this._cancellable, (conn, res) => {
                try {
                    const [paths] = conn.call_finish(res).deepUnpack();
                    paths.forEach(path => this._probe(path));
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.debug(`GNOME Next: UPower unavailable: ${e.message}`);
                }
            });
    }

    _probe(path) {
        Gio.DBusProxy.new(Gio.DBus.system, Gio.DBusProxyFlags.NONE, null,
            UPOWER_BUS, path, UPOWER_DEVICE_IFACE, this._cancellable,
            (_o, res) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_finish(res);
                } catch {
                    return;
                }

                const get = name => proxy.get_cached_property(name)?.unpack();
                if (this._proxy ||
                    get('Type') !== UPOWER_DEVICE_TYPE_BATTERY ||
                    !get('PowerSupply') ||
                    !get('ChargeThresholdSupported'))
                    return;

                this._proxy = proxy;
                proxy.connectObject('g-properties-changed', () => this._sync(), this);
                this._sync();
            });
    }

    _sync() {
        const enabled = this._proxy.get_cached_property('ChargeThresholdEnabled')?.unpack();
        this.set({visible: true, checked: !!enabled});
    }

    _toggle() {
        this._proxy?.call('EnableChargeThreshold',
            new GLib.Variant('(b)', [!this.checked]),
            Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
                try {
                    proxy.call_finish(res);
                } catch (e) {
                    logError(e, 'GNOME Next: Failed to change the charge threshold');
                }
            });
    }
});

// Actors start hidden until they get a parent, and these are created before
// being added to the grid (or never, while they only show in the catalog)
const a11yToggle = name => () => {
    if (!A11y[name])
        return null;
    const toggle = new A11y[name]();
    toggle.show();
    return toggle;
};

// Toggles provided by this extension, in catalog order
export const EXTRA_TOGGLES = [
    {id: 'screenshot', category: 'device', create: () => new ScreenshotToggle()},
    {id: 'battery-health', category: 'device', create: () => new BatteryHealthToggle()},
    {
        id: 'camera', category: 'privacy', create: () => new SettingsToggle({
            title: _('Camera'),
            iconName: 'camera-web-symbolic',
            schema: 'org.gnome.desktop.privacy',
            key: 'disable-camera',
            invert: true,
        }),
    },
    {
        id: 'location', category: 'privacy', create: () => new SettingsToggle({
            title: _('Location'),
            iconName: 'location-services-active-symbolic',
            schema: 'org.gnome.system.location',
            key: 'enabled',
        }),
    },
    {
        id: 'screen-lock', category: 'privacy', create: () => new SettingsToggle({
            title: _('Screen Lock'),
            iconName: 'system-lock-screen-symbolic',
            schema: 'org.gnome.desktop.screensaver',
            key: 'lock-enabled',
        }),
    },
    {
        id: 'microphone', category: 'privacy', create: () => new SettingsToggle({
            title: _('Microphone'),
            iconName: 'audio-input-microphone-symbolic',
            schema: 'org.gnome.desktop.privacy',
            key: 'disable-microphone',
            invert: true,
        }),
    },
    {id: 'zoom', category: 'accessibility', create: a11yToggle('MagnifierToggle')},
    {id: 'high-contrast', category: 'accessibility', create: a11yToggle('HighContrastToggle')},
    {id: 'large-text', category: 'accessibility', create: a11yToggle('LargeTextToggle')},
    {id: 'visual-alerts', category: 'accessibility', create: a11yToggle('VisualBellToggle')},
    {id: 'screen-keyboard', category: 'accessibility', create: a11yToggle('ScreenKeyboardToggle')},
    {id: 'screen-reader', category: 'accessibility', create: a11yToggle('ScreenReaderToggle')},
    {id: 'sticky-keys', category: 'accessibility', create: a11yToggle('StickyKeysToggle')},
    {id: 'mouse-keys', category: 'accessibility', create: a11yToggle('MouseKeysToggle')},
    {id: 'bounce-keys', category: 'accessibility', create: a11yToggle('BounceKeysToggle')},
    {id: 'slow-keys', category: 'accessibility', create: a11yToggle('SlowKeysToggle')},
];

export function isToggle(item) {
    return item instanceof QuickToggle || item instanceof QuickMenuToggle;
}

export function columnSpan(grid, child) {
    return grid.layout_manager.get_child_meta(grid, child).column_span;
}

// Single-column toggles in grid order (sliders and the system row excluded)
export function gridToggles(grid) {
    return [...grid].filter(c => isToggle(c) && columnSpan(grid, c) === 1);
}

export function toggleId(grid, item) {
    if (item._gnExtraId)
        return item._gnExtraId;

    const name = item.constructor.name;
    const index = gridToggles(grid)
        .filter(c => !c._gnExtraId && c.constructor.name === name)
        .indexOf(item);
    return index > 0 ? `${name}#${index}` : name;
}

export function toggleCategory(item) {
    return item._gnCategory ?? SHELL_CATEGORIES[item.constructor.name] ?? 'other';
}

// The St.Icon a toggle shows. QuickMenuToggle only forwards the icon to the
// QuickToggle inside it, so its own gicon stays empty when set by name.
export function toggleIcon(item) {
    if (item instanceof QuickMenuToggle)
        return item._box.get_first_child()?._icon ?? null;
    return item._icon ?? null;
}

// The title label of a toggle, see toggleIcon()
export function toggleTitle(item) {
    if (item instanceof QuickMenuToggle)
        return item._box.get_first_child()?._title ?? null;
    return item._title ?? null;
}

// Press a toggle as if its main button was clicked
export function activateToggle(item) {
    if (item.toggle_mode)
        item.checked = !item.checked;
    item.emit('clicked', Clutter.BUTTON_PRIMARY);
}
