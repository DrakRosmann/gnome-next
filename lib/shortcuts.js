import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const APP_PREFIX = 'app:';
export const COMMAND_PREFIX = 'command:';

// Opens an app, as the app controls of iOS do: its icon and name, and a
// click brings it up (or starts it)
const AppToggle = GObject.registerClass(
class GnAppToggle extends QuickToggle {
    constructor(app) {
        super({title: app.get_name(), gicon: app.get_icon(), visible: true});
        this.add_style_class_name('gn-app-toggle');
        this._app = app;
        this.connect('clicked', () => {
            Main.panel.closeQuickSettings();
            this._app.activate();
        });
    }
});

// The apps the editor offers: the favorites of the dash and the ones
// already added. Returns extra toggle infos, see EXTRA_TOGGLES.
export function appShortcuts(added) {
    const appSystem = Shell.AppSystem.get_default();
    const favorites = global.settings.get_strv('favorite-apps');
    const ids = [...new Set([
        ...favorites,
        ...added.filter(id => id.startsWith(APP_PREFIX)).map(id => id.slice(APP_PREFIX.length)),
    ])];
    return ids.map(id => appSystem.lookup_app(id)).filter(Boolean).map(app => ({
        id: `${APP_PREFIX}${app.get_id()}`,
        category: 'apps',
        create: () => new AppToggle(app),
    }));
}

// Runs `command` in a shell; resolves to whether it succeeded, with what it
// printed on error
function run(command, cancellable) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(['/bin/sh', '-c', command],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ok: false, error: e.message});
            return;
        }
        proc.communicate_utf8_async(null, cancellable, (_p, res) => {
            try {
                const [, , stderr] = proc.communicate_utf8_finish(res);
                resolve({ok: proc.get_successful(), error: stderr?.trim() ?? ''});
            } catch (e) {
                resolve({ok: false, error: e.message});
            }
        });
    });
}

// A toggle that runs commands the user set in Preferences. With a command to
// turn it off it is an on/off switch; with a command to check the state it
// shows whether it is on (exit status 0) every time Quick Settings opens.
// Without either it is a button that runs its command.
const CommandToggle = GObject.registerClass(
class GnCommandToggle extends QuickToggle {
    constructor(config) {
        super({
            title: config.name || _('Command'),
            iconName: config.icon || 'utilities-terminal-symbolic',
            visible: true,
        });
        this._config = config;
        this._cancellable = new Gio.Cancellable();
        this._switch = Boolean(config.off?.trim());
        this.connect('clicked', () => this._activate().catch(logError));
        this.connect('destroy', () => this._cancellable.cancel());

        if (config.status?.trim()) {
            Main.panel.statusArea.quickSettings.menu.connectObject('open-state-changed',
                (_m, open) => open && this.refresh(), this);
            this.refresh();
        }
    }

    async refresh() {
        const {ok} = await run(this._config.status, this._cancellable);
        if (!this._cancellable.is_cancelled() && !this._busy)
            this.checked = ok;
    }

    async _activate() {
        if (this._busy)
            return;
        const turnOff = this._switch && this.checked;
        const command = turnOff ? this._config.off : this._config.on;
        if (!command?.trim())
            return;

        this._busy = true;
        if (this._switch)
            this.checked = !turnOff;
        else
            this.checked = true;
        const {ok, error} = await run(command, this._cancellable);
        this._busy = false;
        if (this._cancellable.is_cancelled())
            return;

        if (!ok) {
            Main.notifyError(_('“%s” failed').format(this.title), error || command);
            if (this._switch)
                this.checked = turnOff;
        }
        if (!this._switch)
            this.checked = false;
        else if (this._config.status?.trim())
            await this.refresh();
    }
});

// Commands set in Preferences, as extra toggle infos. Each entry is a JSON
// object {id, name, icon, on, off, status}.
export function commandToggles(entries) {
    const infos = [];
    for (const entry of entries) {
        let config;
        try {
            config = JSON.parse(entry);
        } catch {
            continue;
        }
        if (!config?.id)
            continue;
        infos.push({
            id: `${COMMAND_PREFIX}${config.id}`,
            category: 'commands',
            // Edited commands are rebuilt
            signature: entry,
            create: () => new CommandToggle(config),
        });
    }
    return infos;
}
