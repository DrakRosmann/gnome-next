import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class GnomeNextPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const quickSettings = new Adw.PreferencesGroup({
            title: _('Quick Settings'),
        });
        page.add(quickSettings);

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
        });
        reset.add_suffix(resetButton);
        quickSettings.add(reset);

        quickSettings.add(switchRow(settings, 'android-tiles',
            _('Android Style Tiles'),
            _('Taller rounded tiles with the icon in a rounded square, as on Android 16')));

        quickSettings.add(switchRow(settings, 'pill-sliders',
            _('Pill Sliders'),
            _('Thick sliders with the icon inside the filled part')));

        quickSettings.add(switchRow(settings, 'app-volume',
            _('Volume of Each App'),
            _('The menu of the volume slider lists the apps playing sound, each with a slider')));

        quickSettings.add(switchRow(settings, 'panel-shortcuts',
            _('Top Bar Shortcuts'),
            _('Middle-click the volume icon to mute; scroll over the battery icon to change the brightness')));

        quickSettings.add(switchRow(settings, 'dnd-menu',
            _('Do Not Disturb Durations'),
            _('Turn on Do Not Disturb for an hour, until the evening or until tomorrow')));

        quickSettings.add(switchRow(settings, 'enable-collapsible',
            _('Notifications in Quick Settings'),
            _('Quick Settings and notifications collapse into each other, with a media player')));

        const calendar = new Adw.PreferencesGroup({title: _('Calendar')});
        page.add(calendar);

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
        calendar.add(widgets);

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
        calendar.add(resetWidgets);

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
        calendar.add(stocks);
    }
}
