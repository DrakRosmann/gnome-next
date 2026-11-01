import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const PENDING_TIMEOUT = 1000000; // µs

// Top bar shortcuts from the COSMIC applet: the middle button on the volume
// icon mutes, scrolling over the battery icon changes the screen brightness.
export class PanelShortcuts {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        const qs = Main.panel.statusArea.quickSettings;
        this._undo = [];

        const volume = qs._volumeOutput;
        const volumeIcon = volume?._indicator;
        if (volumeIcon) {
            // The sound server confirms a change a moment later: until then
            // `is_muted` is stale, and a quick second click must undo the
            // first, not repeat it
            let pending = null;
            const id = volumeIcon.connect('button-press-event', (_a, event) => {
                const stream = volume._output?.stream;
                if (event.get_button() !== Clutter.BUTTON_MIDDLE || !stream)
                    return Clutter.EVENT_PROPAGATE;
                const now = GLib.get_monotonic_time();
                if (pending?.stream !== stream || now - pending.time > PENDING_TIMEOUT)
                    pending = null;
                const muted = !(pending?.muted ?? stream.is_muted);
                pending = {stream, muted, time: now};
                stream.change_is_muted(muted);
                const confirmed = stream.connect('notify::is-muted', () => {
                    stream.disconnect(confirmed);
                    if (pending?.stream === stream && pending.muted === stream.is_muted)
                        pending = null;
                });
                return Clutter.EVENT_STOP;
            });
            this._undo.push(() => volumeIcon.disconnect(id));
        }

        const batteryIcon = qs._system?._indicator;
        const brightness = qs._brightness?.quickSettingsItems[0];
        if (batteryIcon && brightness) {
            const reactive = batteryIcon.reactive;
            batteryIcon.reactive = true;
            const scroll = new Clutter.ScrollController({
                flags: Clutter.ScrollControllerFlags.SCROLL_VERTICAL |
                    Clutter.ScrollControllerFlags.PHYSICAL_DIRECTION,
            });
            scroll.connect('scroll', (_c, _sprite, _source, _dx, dy) => {
                if (!brightness.visible || !brightness.slider.step(-dy))
                    return;
                Main.osdWindowManager.showAll(
                    new Gio.ThemedIcon({name: 'display-brightness-symbolic'}),
                    null, brightness.slider.value, 1);
            });
            batteryIcon.add_action(scroll);
            this._undo.push(() => {
                batteryIcon.remove_action(scroll);
                batteryIcon.reactive = reactive;
            });
        }
    }

    disable() {
        this._undo.forEach(undo => undo());
        this._undo = null;
    }
}
