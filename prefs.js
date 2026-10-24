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
            _('Add an edit button to add and remove quick settings'));
        quickSettings.add(customization);

        const a11y = switchRow(settings, 'hide-accessibility-menu',
            _('Hide Accessibility Menu'),
            _('Accessibility toggles can be added to Quick Settings instead'));
        customization.bind_property('active', a11y, 'sensitive',
            GObject.BindingFlags.SYNC_CREATE);
        quickSettings.add(a11y);

        const reset = new Adw.ActionRow({
            title: _('Default Layout'),
            subtitle: _('Restore the quick settings that were removed or added'),
        });
        const resetButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });
        resetButton.connect('clicked', () => {
            settings.reset('removed-toggles');
            settings.reset('added-toggles');
        });
        reset.add_suffix(resetButton);
        quickSettings.add(reset);

        quickSettings.add(switchRow(settings, 'pill-sliders',
            _('Pill Sliders'),
            _('Thick sliders with the icon inside the filled part')));

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
    }
}
