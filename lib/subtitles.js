import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {gridToggles} from './toggles.js';

const SUBTITLED = ['NMWiredToggle', 'NMWirelessToggle', 'BluetoothToggle'];

// The NetworkManager device state for a working connection
const NM_DEVICE_STATE_ACTIVATED = 100;

function speedText(mbits) {
    if (!mbits || mbits <= 0)
        return null;
    return mbits >= 1000
        ? _('%s Gb/s').format((mbits / 1000).toLocaleString(undefined, {maximumFractionDigits: 1}))
        : _('%d Mb/s').format(mbits);
}

// What a toggle says under its title, given what the shell would say
// (`shell`); undefined leaves the shell's
function subtitleFor(toggle, shell) {
    switch (toggle.constructor.name) {
    case 'NMWiredToggle': {
        if (shell)
            return undefined;
        const device = toggle._nmDevices?.[0];
        if (!device)
            return undefined;
        if (device.get_state() !== NM_DEVICE_STATE_ACTIVATED)
            return _('Disconnected');
        const speed = speedText(device.get_speed?.());
        return speed ? `${_('Connected')} · ${speed}` : _('Connected');
    }
    case 'NMWirelessToggle':
        return shell || !toggle.checked ? undefined : _('Not Connected');
    case 'BluetoothToggle': {
        if (!toggle.checked)
            return undefined;
        if (!shell)
            return _('No Devices');
        // One device: its battery, when it reports it
        const devices = [...toggle._client?.getDevices?.() ?? []];
        const connected = devices.filter(d => d.connected);
        const battery = connected.length === 1 ? connected[0].battery_percentage : -1;
        return battery > 0 ? `${shell} · ${Math.round(battery)}%` : undefined;
    }
    default:
        return undefined;
    }
}

// One UI style subtitles: what each connection toggle is connected to. The
// shell already names the Wi-Fi network and the Bluetooth device; this adds
// the speed of a wired connection, the battery of the Bluetooth device and
// what is going on when nothing is connected.
export class ToggleSubtitles {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        this._grid = Main.panel.statusArea.quickSettings.menu._grid;
        this._toggles = new Map(); // toggle -> {shell subtitle}
        this._grid.connectObject('child-added', () => this._queueAttach(), this);
        Main.panel.statusArea.quickSettings.menu.connectObject('open-state-changed',
            (_m, open) => open && this._refreshAll(), this);
        this._attach();
    }

    disable() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._grid.disconnectObject(this);
        Main.panel.statusArea.quickSettings.menu.disconnectObject(this);
        for (const [toggle, state] of this._toggles) {
            toggle.disconnectObject(this);
            this._set(toggle, state.shell);
        }
        this._toggles = null;
    }

    _queueAttach() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._attach();
            return GLib.SOURCE_REMOVE;
        });
    }

    _attach() {
        for (const toggle of gridToggles(this._grid)) {
            if (this._toggles.has(toggle) || !SUBTITLED.includes(toggle.constructor.name))
                continue;
            const state = {shell: toggle.subtitle ?? null};
            this._toggles.set(toggle, state);
            toggle.connectObject(
                'notify::subtitle', () => {
                    if (this._setting)
                        return;
                    state.shell = toggle.subtitle ?? null;
                    this._refresh(toggle);
                },
                'notify::checked', () => this._refresh(toggle),
                'destroy', () => this._toggles?.delete(toggle),
                this);
            this._refresh(toggle);
        }
    }

    _refreshAll() {
        this._toggles.forEach((_s, toggle) => this._refresh(toggle));
    }

    _refresh(toggle) {
        const state = this._toggles.get(toggle);
        const subtitle = subtitleFor(toggle, state.shell);
        this._set(toggle, subtitle === undefined ? state.shell : subtitle);
    }

    _set(toggle, subtitle) {
        if ((toggle.subtitle ?? null) === subtitle)
            return;
        this._setting = true;
        try {
            toggle.subtitle = subtitle;
        } finally {
            this._setting = false;
        }
    }
}
