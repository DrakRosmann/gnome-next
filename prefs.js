import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Prefixes of the ids of app and command toggles, see lib/shortcuts.js
const APP_PREFIX = 'app:';
const COMMAND_PREFIX = 'command:';

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class GnomeNextPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: _('Quick Settings'),
            icon_name: 'view-grid-symbolic',
        });
        window.add(page);
        const calendarPage = new Adw.PreferencesPage({
            title: _('Calendar'),
            icon_name: 'x-office-calendar-symbolic',
        });
        window.add(calendarPage);
        window.set_default_size(620, 720);

        const quickSettings = new Adw.PreferencesGroup({
            title: _('Tiles'),
            description: _('Edit with the pencil in Quick Settings: drag to move, click to resize'),
        });
        page.add(quickSettings);
        const controls = new Adw.PreferencesGroup({title: _('Controls')});
        page.add(controls);
        const notifications = new Adw.PreferencesGroup({title: _('Notifications')});
        page.add(notifications);

        const customization = switchRow(settings, 'enable-customization',
            _('Customization'),
            _('Add an edit button to add, remove, move and resize quick settings'));
        quickSettings.add(customization);

        const a11y = switchRow(settings, 'hide-accessibility-menu',
            _('Hide Accessibility Menu'),
            _('Accessibility toggles can be added to Quick Settings instead'));
        customization.bind_property('active', a11y, 'sensitive',
            GObject.BindingFlags.SYNC_CREATE);
        quickSettings.add(a11y);

        const reset = new Adw.ActionRow({
            title: _('Default Layout'),
            subtitle: _('Restore the quick settings that were removed, added, moved or resized'),
        });
        const resetButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });
        resetButton.connect('clicked', () => {
            settings.reset('removed-toggles');
            settings.reset('added-toggles');
            settings.reset('toggle-order');
            settings.reset('small-toggles');
            settings.reset('control-sizes');
        });
        reset.add_suffix(resetButton);
        quickSettings.add(reset);

        quickSettings.add(switchRow(settings, 'android-tiles',
            _('Android Style Tiles'),
            _('Taller rounded tiles with the icon in a rounded square, as on Android 16')));

        controls.add(switchRow(settings, 'pill-sliders',
            _('Pill Sliders'),
            _('Thick sliders with the icon inside the filled part')));

        controls.add(switchRow(settings, 'app-volume',
            _('Volume of Each App'),
            _('The menu of the volume slider lists the apps playing sound, each with a slider')));

        controls.add(switchRow(settings, 'panel-shortcuts',
            _('Top Bar Shortcuts'),
            _('Middle-click the volume icon to mute; scroll over the battery icon to change the brightness')));

        controls.add(switchRow(settings, 'dnd-menu',
            _('Do Not Disturb Durations'),
            _('Turn on Do Not Disturb for an hour, until the evening or until tomorrow')));

        controls.add(switchRow(settings, 'toggle-subtitles',
            _('Connection Details'),
            _('Show the wired speed and the Bluetooth battery under the toggle names')));

        controls.add(switchRow(settings, 'live-activities',
            _('Live Activities'),
            _('Timers, screen recordings and downloads in an island in the top bar and in Quick Settings')));

        const apps = new Adw.PreferencesGroup({
            title: _('App Shortcuts'),
            description: _('Apps that open from Quick Settings; your favorite apps are also offered in the editor'),
        });
        page.add(apps);
        this._fillApps(window, settings, apps);

        const commands = new Adw.PreferencesGroup({
            title: _('Custom Commands'),
            description: _('Toggles that run your commands, e.g. to start a VPN or a server'),
        });
        page.add(commands);
        this._fillCommands(window, settings, commands);

        notifications.add(switchRow(settings, 'enable-collapsible',
            _('Notifications in Quick Settings'),
            _('Quick Settings and notifications collapse into each other, with a media player')));

        const calendar = new Adw.PreferencesGroup({title: _('Calendar')});
        calendarPage.add(calendar);
        const widgetsGroup = new Adw.PreferencesGroup({
            title: _('Widgets'),
            description: _('Click Edit Widgets under the calendar to add, move and resize them'),
        });
        calendarPage.add(widgetsGroup);

        const popover = switchRow(settings, 'enable-calendar',
            _('Adaptive Calendar'),
            _('A calendar popover that scales with events, world clocks and weather'));
        calendar.add(popover);

        const layouts = ['adaptive', 'two-columns'];
        const layout = new Adw.ComboRow({
            title: _('Layout'),
            subtitle: _('Two columns always shows the date, weather and events next to the calendar'),
            model: Gtk.StringList.new([_('Adaptive'), _('Two Columns')]),
        });
        const syncLayout = () => {
            layout.selected = Math.max(0, layouts.indexOf(settings.get_string('calendar-layout')));
        };
        settings.connect('changed::calendar-layout', syncLayout);
        syncLayout();
        layout.connect('notify::selected', () => {
            const value = layouts[layout.selected];
            if (value && value !== settings.get_string('calendar-layout'))
                settings.set_string('calendar-layout', value);
        });
        popover.bind_property('active', layout, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        calendar.add(layout);

        const events = switchRow(settings, 'show-events',
            _('Show Events'),
            _('Show the remaining events of the day next to the calendar'));
        popover.bind_property('active', events, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        calendar.add(events);

        const widgets = switchRow(settings, 'enable-widgets',
            _('Widgets'),
            _('Weather, world clocks, events, media and more under the calendar'));
        popover.bind_property('active', widgets, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        widgetsGroup.add(widgets);

        const resetWidgets = new Adw.ActionRow({
            title: _('Default Widgets'),
            subtitle: _('Restore the widgets that were added, removed or resized'),
        });
        const resetWidgetsButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });
        resetWidgetsButton.connect('clicked', () => settings.reset('widgets'));
        resetWidgets.add_suffix(resetWidgetsButton);
        const syncResetWidgets = () => {
            resetWidgets.sensitive = popover.active && widgets.active;
        };
        popover.connect('notify::active', syncResetWidgets);
        widgets.connect('notify::active', syncResetWidgets);
        syncResetWidgets();
        widgetsGroup.add(resetWidgets);

        // Shows the symbols the widget uses; stays unset until edited
        const stocks = new Adw.EntryRow({
            title: _('Stock Symbols (comma separated, e.g. PETR4.SA, AAPL, BTC-USD)'),
            show_apply_button: true,
        });
        const symbolsText = () => settings.get_strv('stock-symbols').join(', ');
        stocks.text = settings.get_user_value('stock-symbols') ? symbolsText() : '';
        stocks.connect('apply', () => {
            const symbols = stocks.text.split(/[,\s]+/).map(t => t.trim().toUpperCase()).filter(Boolean);
            if (symbols.length)
                settings.set_strv('stock-symbols', symbols);
            else
                settings.reset('stock-symbols');
        });
        widgets.bind_property('active', stocks, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        widgetsGroup.add(stocks);
    }

    // Adds `id` to Quick Settings, after the others
    _addToQuickSettings(settings, id) {
        const added = settings.get_strv('added-toggles');
        if (!added.includes(id))
            settings.set_strv('added-toggles', [...added, id]);
        const order = settings.get_strv('toggle-order');
        if (order.length > 0 && !order.includes(id))
            settings.set_strv('toggle-order', [...order, id]);
    }

    _removeFromQuickSettings(settings, id) {
        settings.set_strv('added-toggles', settings.get_strv('added-toggles').filter(a => a !== id));
        settings.set_strv('toggle-order', settings.get_strv('toggle-order').filter(a => a !== id));
    }

    _fillApps(window, settings, group) {
        let rows = [];
        const addRow = new Adw.ButtonRow({title: _('Add App…'), start_icon_name: 'list-add-symbolic'});
        addRow.connect('activated', () => this._pickApp(window, app =>
            this._addToQuickSettings(settings, `${APP_PREFIX}${app.get_id()}`)));

        const sync = () => {
            rows.forEach(row => group.remove(row));
            group.remove(addRow);
            rows = settings.get_strv('added-toggles')
                .filter(id => id.startsWith(APP_PREFIX))
                .map(id => [id, Gio.DesktopAppInfo.new(id.slice(APP_PREFIX.length))])
                .filter(([, app]) => app)
                .map(([id, app]) => {
                    const row = new Adw.ActionRow({title: app.get_name(), use_markup: false});
                    row.add_prefix(new Gtk.Image({gicon: app.get_icon(), pixel_size: 32}));
                    const remove = new Gtk.Button({
                        icon_name: 'user-trash-symbolic',
                        tooltip_text: _('Remove'),
                        valign: Gtk.Align.CENTER,
                        css_classes: ['flat'],
                    });
                    remove.connect('clicked', () => this._removeFromQuickSettings(settings, id));
                    row.add_suffix(remove);
                    return row;
                });
            rows.forEach(row => group.add(row));
            group.add(addRow);
        };
        settings.connect('changed::added-toggles', sync);
        sync();
    }

    // A searchable list of the installed apps
    _pickApp(window, callback) {
        const dialog = new Adw.Dialog({title: _('Add App'), content_width: 420, content_height: 560});
        const view = new Adw.ToolbarView();
        view.add_top_bar(new Adw.HeaderBar());
        const search = new Gtk.SearchEntry({placeholder_text: _('Search apps'), hexpand: true});
        const searchBar = new Gtk.Box({margin_start: 12, margin_end: 12, margin_bottom: 6});
        searchBar.append(search);
        view.add_top_bar(searchBar);

        const list = new Gtk.ListBox({
            css_classes: ['boxed-list'],
            selection_mode: Gtk.SelectionMode.NONE,
            margin_start: 12,
            margin_end: 12,
            margin_top: 6,
            margin_bottom: 12,
            valign: Gtk.Align.START,
        });
        const apps = Gio.AppInfo.get_all()
            .filter(app => app.should_show())
            .sort((a, b) => a.get_name().localeCompare(b.get_name()));
        for (const app of apps) {
            const row = new Adw.ActionRow({title: app.get_name(), activatable: true, use_markup: false});
            row.add_prefix(new Gtk.Image({gicon: app.get_icon(), pixel_size: 32}));
            row._app = app;
            row.connect('activated', () => {
                callback(app);
                dialog.close();
            });
            list.append(row);
        }
        list.set_filter_func(row => {
            const text = search.text.trim().toLowerCase();
            return !text || row._app.get_name().toLowerCase().includes(text) ||
                row._app.get_id().toLowerCase().includes(text);
        });
        search.connect('search-changed', () => list.invalidate_filter());
        search.connect('activate', () => {
            for (let row = list.get_first_child(); row; row = row.get_next_sibling()) {
                if (row.get_child_visible()) {
                    row.emit('activated');
                    return;
                }
            }
        });

        view.content = new Gtk.ScrolledWindow({
            child: list,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vexpand: true,
        });
        dialog.child = view;
        dialog.present(window);
        search.grab_focus();
    }

    _readCommands(settings) {
        return settings.get_strv('command-toggles').map(entry => {
            try {
                return JSON.parse(entry);
            } catch {
                return null;
            }
        }).filter(c => c?.id);
    }

    _writeCommands(settings, commands) {
        settings.set_strv('command-toggles', commands.map(c => JSON.stringify(c)));
    }

    _fillCommands(window, settings, group) {
        let rows = [];
        const addRow = new Adw.ButtonRow({title: _('Add Command…'), start_icon_name: 'list-add-symbolic'});
        addRow.connect('activated', () => this._editCommand(window, null, config => {
            this._writeCommands(settings, [...this._readCommands(settings), config]);
            this._addToQuickSettings(settings, `${COMMAND_PREFIX}${config.id}`);
        }));

        const sync = () => {
            rows.forEach(row => group.remove(row));
            group.remove(addRow);
            rows = this._readCommands(settings).map(config => {
                const row = new Adw.ActionRow({
                    title: config.name || _('Command'),
                    subtitle: config.on ?? '',
                    subtitle_lines: 1,
                    use_markup: false,
                });
                row.add_prefix(new Gtk.Image({icon_name: config.icon || 'utilities-terminal-symbolic'}));
                const edit = new Gtk.Button({
                    icon_name: 'document-edit-symbolic',
                    tooltip_text: _('Edit'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                edit.connect('clicked', () => this._editCommand(window, config, changed =>
                    this._writeCommands(settings, this._readCommands(settings)
                        .map(c => (c.id === changed.id ? changed : c)))));
                row.add_suffix(edit);
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: _('Remove'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => {
                    this._writeCommands(settings, this._readCommands(settings).filter(c => c.id !== config.id));
                    this._removeFromQuickSettings(settings, `${COMMAND_PREFIX}${config.id}`);
                });
                row.add_suffix(remove);
                return row;
            });
            rows.forEach(row => group.add(row));
            group.add(addRow);
        };
        settings.connect('changed::command-toggles', sync);
        sync();
    }

    // `config` null for a new command
    _editCommand(window, config, callback) {
        const dialog = new Adw.Dialog({
            title: config ? _('Edit Command') : _('New Command'),
            content_width: 480,
        });
        const view = new Adw.ToolbarView();
        const header = new Adw.HeaderBar({show_end_title_buttons: false, show_start_title_buttons: false});
        const cancel = new Gtk.Button({label: _('Cancel')});
        cancel.connect('clicked', () => dialog.close());
        header.pack_start(cancel);
        const save = new Gtk.Button({label: _('Save'), css_classes: ['suggested-action']});
        header.pack_end(save);
        view.add_top_bar(header);

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            description: _('Commands run with /bin/sh. Without a command to turn it off, the toggle is a button.'),
        });
        page.add(group);
        const entry = (title, value) => {
            const row = new Adw.EntryRow({title, text: value ?? ''});
            group.add(row);
            return row;
        };
        const name = entry(_('Name'), config?.name);
        const icon = entry(_('Icon Name (e.g. network-vpn-symbolic)'), config?.icon);
        const on = entry(_('Command to Turn On or Run'), config?.on);
        const off = entry(_('Command to Turn Off (optional)'), config?.off);
        const status = entry(_('Command to Check if On (optional, exit status 0 = on)'), config?.status);

        const preview = new Gtk.Image({icon_name: config?.icon || 'utilities-terminal-symbolic'});
        icon.add_suffix(preview);
        icon.connect('changed', () => (preview.icon_name = icon.text.trim() || 'utilities-terminal-symbolic'));

        const valid = () => name.text.trim() && on.text.trim();
        const syncSave = () => (save.sensitive = Boolean(valid()));
        name.connect('changed', syncSave);
        on.connect('changed', syncSave);
        syncSave();

        save.connect('clicked', () => {
            if (!valid())
                return;
            callback({
                id: config?.id ?? GLib.uuid_string_random().slice(0, 8),
                name: name.text.trim(),
                icon: icon.text.trim(),
                on: on.text.trim(),
                off: off.text.trim(),
                status: status.text.trim(),
            });
            dialog.close();
        });

        view.content = page;
        dialog.child = view;
        dialog.present(window);
    }
}
