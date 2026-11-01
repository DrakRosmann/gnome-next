import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Widget, label, launchApp, vbox} from './base.js';
import {Ring, Sparkline, ringWith} from './drawing.js';

const INTERVAL = 2; // seconds
const decoder = new TextDecoder();

function read(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return decoder.decode(bytes);
    } catch {
        return '';
    }
}

function cpuTimes() {
    const fields = read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 4)
        return null;
    const idle = fields[3] + (fields[4] ?? 0);
    const total = fields.slice(0, 8).reduce((a, b) => a + b, 0);
    return {idle, total};
}

function memory() {
    const info = {};
    for (const line of read('/proc/meminfo').split('\n')) {
        const [key, value] = line.split(':');
        if (value)
            info[key] = parseInt(value) * 1024;
    }
    const total = info.MemTotal ?? 0;
    const used = total - (info.MemAvailable ?? info.MemFree ?? 0);
    return {total, used};
}

function disk() {
    try {
        const info = Gio.File.new_for_path('/').query_filesystem_info('filesystem::size,filesystem::free', null);
        const size = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        return {total: size, used: size - free};
    } catch {
        return {total: 0, used: 0};
    }
}

function networkBytes() {
    let rx = 0, tx = 0;
    for (const line of read('/proc/net/dev').split('\n').slice(2)) {
        const [name, data] = line.split(':');
        if (!data || name.trim() === 'lo')
            continue;
        const fields = data.trim().split(/\s+/).map(Number);
        rx += fields[0];
        tx += fields[8];
    }
    return {rx, tx};
}

function formatRate(bytesPerSecond) {
    /* Translators: network speed, e.g. "1.2 MB/s" */
    return _('%s/s').format(GLib.format_size(Math.max(0, Math.round(bytesPerSecond))));
}

export const SystemWidget = GObject.registerClass(
class GnSystemWidget extends Widget {
    constructor(size) {
        super(size, {accessible_name: _('System Monitor')});
        this.add_style_class_name('gn-system-widget');

        const box = vbox({x_expand: true, y_expand: true});
        this.child = box;

        box.add_child(label('gn-widget-title', {text: _('System')}));

        const rings = new St.BoxLayout({
            style_class: 'gn-system-rings',
            x_expand: true,
            y_expand: true,
        });
        box.add_child(rings);

        this._meters = {};
        const kinds = this.small ? ['cpu', 'memory'] : ['cpu', 'memory', 'disk'];
        const titles = {cpu: _('CPU'), memory: _('Memory'), disk: _('Disk')};
        for (const kind of kinds) {
            const column = vbox({style_class: 'gn-system-meter', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const ring = new Ring();
            const value = new St.Label({style_class: 'gn-system-value'});
            column.add_child(ringWith(ring, value));
            column.add_child(new St.Label({
                style_class: 'gn-widget-dim gn-system-name',
                text: titles[kind],
                x_align: Clutter.ActorAlign.CENTER,
            }));
            rings.add_child(column);
            this._meters[kind] = {ring, value};
        }

        if (!this.small) {
            const network = vbox({style_class: 'gn-system-network', y_align: Clutter.ActorAlign.CENTER});
            this._down = label('gn-system-rate');
            this._up = label('gn-system-rate');
            network.add_child(this._rateRow('go-down-symbolic', this._down));
            network.add_child(this._rateRow('go-up-symbolic', this._up));
            rings.add_child(network);
        }

        if (this.large) {
            box.add_child(label('gn-widget-dim gn-system-section', {text: _('CPU history')}));
            this._history = new Sparkline({x_expand: true});
            box.add_child(this._history);
            this._details = label('gn-widget-dim gn-system-details');
            box.add_child(this._details);
        }

        // A first reading, so that the first update already has a CPU delta
        this._cpu = cpuTimes();
        this.poll(INTERVAL, () => this._sample());
    }

    _rateRow(iconName, rateLabel) {
        const row = new St.BoxLayout({style_class: 'gn-system-rate-row'});
        row.add_child(new St.Icon({icon_name: iconName, style_class: 'gn-system-rate-icon'}));
        row.add_child(rateLabel);
        return row;
    }

    _setMeter(kind, fraction) {
        const meter = this._meters[kind];
        if (!meter)
            return;
        meter.ring.value = fraction;
        meter.value.text = `${Math.round(fraction * 100)}%`;
    }

    _sample() {
        const time = GLib.get_monotonic_time() / 1e6;

        const cpu = cpuTimes();
        if (cpu && this._cpu) {
            const total = cpu.total - this._cpu.total;
            const busy = total > 0 ? 1 - (cpu.idle - this._cpu.idle) / total : 0;
            this._setMeter('cpu', busy);
            this._history?.push(busy);
        }
        this._cpu = cpu;

        const mem = memory();
        this._setMeter('memory', mem.total ? mem.used / mem.total : 0);
        const root = disk();
        if (this._meters.disk)
            this._setMeter('disk', root.total ? root.used / root.total : 0);

        if (this._down) {
            const net = networkBytes();
            if (this._net) {
                const seconds = Math.max(0.1, time - this._time);
                this._down.text = formatRate((net.rx - this._net.rx) / seconds);
                this._up.text = formatRate((net.tx - this._net.tx) / seconds);
            } else {
                this._down.text = this._up.text = formatRate(0);
            }
            this._net = net;
        }
        this._time = time;

        if (this._details) {
            const uptime = parseFloat(read('/proc/uptime')) || 0;
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor(uptime / 60) % 60;
            this._details.text = [
                _('Memory: %s of %s').format(GLib.format_size(mem.used), GLib.format_size(mem.total)),
                _('Up %d h %d min').format(hours, minutes),
            ].join('  ·  ');
        }
    }

    activate() {
        launchApp([
            'org.gnome.SystemMonitor.desktop',
            'gnome-system-monitor.desktop',
            'net.nokyan.Resources.desktop',
            'io.missioncenter.MissionCenter.desktop',
        ]);
    }
});
