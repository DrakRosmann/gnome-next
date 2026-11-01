import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Widget, label, launchApp, placeholder, vbox} from './base.js';
import {Ring, ringWith} from './drawing.js';

const LIMITS = {small: 4, medium: 4, large: 6};

const KIND_ICONS = {
    [UPower.DeviceKind.MOUSE]: 'input-mouse-symbolic',
    [UPower.DeviceKind.KEYBOARD]: 'input-keyboard-symbolic',
    [UPower.DeviceKind.HEADSET]: 'audio-headset-symbolic',
    [UPower.DeviceKind.HEADPHONES]: 'audio-headphones-symbolic',
    [UPower.DeviceKind.PHONE]: 'phone-symbolic',
    [UPower.DeviceKind.TABLET]: 'input-tablet-symbolic',
    [UPower.DeviceKind.GAMING_INPUT]: 'input-gaming-symbolic',
    [UPower.DeviceKind.SPEAKERS]: 'audio-speakers-symbolic',
    [UPower.DeviceKind.TOUCHPAD]: 'input-touchpad-symbolic',
    [UPower.DeviceKind.PEN]: 'input-tablet-symbolic',
};

function isShown(device) {
    if (device.kind === UPower.DeviceKind.LINE_POWER || device.kind === UPower.DeviceKind.UNKNOWN)
        return false;
    if (!device.is_present && device.kind === UPower.DeviceKind.BATTERY)
        return false;
    return device.percentage > 0;
}

function deviceName(device) {
    if (device.kind === UPower.DeviceKind.BATTERY && device.power_supply)
        return _('This Computer');
    return device.model || device.vendor || _('Device');
}

function deviceIcon(device) {
    if (device.kind === UPower.DeviceKind.BATTERY)
        return 'computer-symbolic';
    return KIND_ICONS[device.kind] ?? 'battery-symbolic';
}

// Charge of the laptop battery and of connected devices (mouse, headset…)
export const BatteriesWidget = GObject.registerClass(
class GnBatteriesWidget extends Widget {
    constructor(size) {
        super(size, {accessible_name: _('Batteries')});
        this.add_style_class_name('gn-batteries-widget');
        this._devices = [];

        const box = vbox({x_expand: true, y_expand: true});
        this.child = box;
        this._grid = new St.Widget({
            style_class: 'gn-batteries-grid',
            layout_manager: new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true}),
            x_expand: true,
            y_expand: true,
        });
        box.add_child(this._grid);
        this._placeholder = placeholder('battery-symbolic', _('No batteries'));
        box.add_child(this._placeholder);

        this.empty = true;
        this._cancellable = new Gio.Cancellable();
        this.connect('destroy', () => {
            this._cancellable.cancel();
            this._client?.disconnectObject(this);
            this._devices.forEach(d => d.disconnectObject(this));
        });

        UPower.Client.new_async(this._cancellable, (_o, res) => {
            try {
                this._client = UPower.Client.new_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.debug(`GNOME Next: UPower unavailable: ${e.message}`);
                this._rebuild();
                return;
            }
            this._client.connectObject(
                'device-added', () => this._reload(),
                'device-removed', () => this._reload(),
                this);
            this._reload();
        });
    }

    _reload() {
        this._devices.forEach(d => d.disconnectObject(this));
        this._devices = this._client.get_devices();
        this._devices.forEach(d => d.connectObject('notify', () => this._queueRebuild(), this));
        this._rebuild();
    }

    _queueRebuild() {
        // Devices notify several properties at once
        this._rebuildPending ??= Promise.resolve().then(() => {
            this._rebuildPending = null;
            this._rebuild();
        });
    }

    _rebuild() {
        if (this._cancellable.is_cancelled())
            return;
        const devices = this._devices.filter(isShown)
            // The computer first, then by name
            .sort((a, b) => (b.power_supply - a.power_supply) || deviceName(a).localeCompare(deviceName(b)))
            .slice(0, LIMITS[this.widgetSize]);

        this.empty = devices.length === 0;
        this._placeholder.visible = this.empty;
        this._grid.visible = !this.empty;
        this._grid.destroy_all_children();

        const layout = this._grid.layout_manager;
        devices.forEach((device, i) => {
            const actor = this.large ? this._row(device) : this._cell(device);
            if (this.small)
                layout.attach(actor, i % 2, Math.floor(i / 2), 1, 1);
            else if (this.large)
                layout.attach(actor, 0, i, 1, 1);
            else
                layout.attach(actor, i, 0, 1, 1);
        });
    }

    _ring(device) {
        const ring = new Ring();
        ring.value = device.percentage / 100;
        if (device.percentage <= 20 && device.state !== UPower.DeviceState.CHARGING)
            ring.add_style_class_name('low');
        const charging = device.state === UPower.DeviceState.CHARGING;
        const icon = new St.Icon({
            icon_name: charging ? 'battery-level-100-charging-symbolic' : deviceIcon(device),
            style_class: 'gn-battery-icon',
        });
        return ringWith(ring, icon);
    }

    _cell(device) {
        const cell = vbox({style_class: 'gn-battery-cell', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        cell.add_child(this._ring(device));
        cell.add_child(new St.Label({
            style_class: 'gn-battery-percent',
            text: `${Math.round(device.percentage)}%`,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        return cell;
    }

    _row(device) {
        const row = new St.BoxLayout({style_class: 'gn-battery-row', x_expand: true});
        row.add_child(this._ring(device));
        row.add_child(label('gn-battery-name', {
            text: deviceName(device),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        row.add_child(new St.Label({
            style_class: 'gn-battery-percent',
            text: `${Math.round(device.percentage)}%`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return row;
    }

    activate() {
        launchApp(['gnome-power-panel.desktop', 'org.gnome.Settings.desktop']);
    }
});
