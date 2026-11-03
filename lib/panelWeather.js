import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// The shell only fetches the weather when the calendar opens
const REFRESH_SECONDS = 30 * 60;

// The weather (icon and temperature) next to the date in the top bar, from
// the same locations as the calendar's weather.
export class PanelWeather {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        const dm = Main.panel.statusArea.dateMenu;
        this._client = dm?._weatherItem?._weatherClient ?? null;
        if (!this._client)
            return;

        this._box = new St.BoxLayout({style_class: 'gn-panel-weather', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'system-status-icon gn-panel-weather-icon'});
        this._temp = new St.Label({style_class: 'gn-panel-weather-temp', y_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._icon);
        this._box.add_child(this._temp);
        dm._clockDisplay.get_parent().insert_child_below(this._box, dm._clockDisplay);

        this._client.connectObject('changed', () => this._sync(), this);
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, REFRESH_SECONDS, () => {
            this._client.update();
            return GLib.SOURCE_CONTINUE;
        });
        this._client.update();
        this._sync();
    }

    disable() {
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
        this._client?.disconnectObject(this);
        this._client = null;
        this._box?.destroy();
        this._box = null;
    }

    _sync() {
        const client = this._client;
        const info = client.info;
        const valid = client.available && client.hasLocation && !client.loading && info.is_valid();
        const [hasTemp, temp] = valid ? info.get_value_temp(GWeather.TemperatureUnit.DEFAULT) : [false, 0];
        // While it reloads the last weather stays
        if (client.loading && this._box.visible)
            return;
        this._box.visible = hasTemp;
        if (!hasTemp)
            return;
        this._icon.icon_name = info.get_symbolic_icon_name();
        this._temp.text = `${Math.round(temp)}°`;
    }
}
