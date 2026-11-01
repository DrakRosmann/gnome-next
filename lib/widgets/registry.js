import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {BatteriesWidget} from './batteries.js';
import {CitiesWidget, clearPlaces} from './cities.js';
import {ClocksWidget} from './clocks.js';
import {ControlsWidget} from './controls.js';
import {EventsWidget} from './events.js';
import {MediaWidget} from './media.js';
import {NotesWidget} from './notes.js';
import {PhotoWidget, clearPhotoLibrary} from './photo.js';
import {RemindersWidget} from './reminders.js';
import {StocksWidget, clearQuotes} from './stocks.js';
import {SystemWidget} from './system.js';
import {WeatherWidget} from './weather.js';

// Widgets in gallery order. Titles are functions: gettext is not ready at
// import time.
export const WIDGETS = [
    {
        id: 'weather',
        title: () => _('Weather'),
        description: () => _('Current conditions and the forecast'),
        icon: 'weather-few-clouds-symbolic',
        sizes: ['small', 'medium', 'large'],
        Widget: WeatherWidget,
    },
    {
        id: 'weather-cities',
        title: () => _('Weather in Other Cities'),
        description: () => _('The places saved in Weather, side by side'),
        icon: 'mark-location-symbolic',
        sizes: ['small', 'medium', 'large'],
        Widget: CitiesWidget,
    },
    {
        id: 'world-clocks',
        title: () => _('World Clocks'),
        description: () => _('The time in the cities from Clocks'),
        icon: 'preferences-system-time-symbolic',
        sizes: ['small', 'medium', 'large'],
        Widget: ClocksWidget,
    },
    {
        id: 'up-next',
        title: () => _('Up Next'),
        description: () => _('Your upcoming events'),
        icon: 'x-office-calendar-symbolic',
        sizes: ['small', 'medium', 'large'],
        Widget: EventsWidget,
    },
    {
        id: 'reminders',
        title: () => _('Reminders'),
        description: () => _('Add a time like “tomorrow 9am” to be notified; check to complete'),
        icon: 'checkbox-checked-symbolic',
        sizes: ['small', 'medium', 'large'],
        Widget: RemindersWidget,
    },
    {
        id: 'media',
        title: () => _('Now Playing'),
        description: () => _('Control the music or video that is playing'),
        icon: 'folder-music-symbolic',
        sizes: ['small', 'medium'],
        Widget: MediaWidget,
    },
    {
        id: 'stocks',
        title: () => _('Stocks'),
        description: () => _('Prices from Yahoo Finance (uses the internet); choose the symbols in Preferences'),
        icon: 'x-office-spreadsheet-symbolic',
        sizes: ['small', 'medium', 'large'],
        Widget: StocksWidget,
    },
    {
        id: 'controls',
        title: () => _('Controls'),
        description: () => _('Your Quick Settings toggles, at hand'),
        icon: 'emblem-system-symbolic',
        sizes: ['small', 'medium', 'large'],
        Widget: ControlsWidget,
    },
    {
        id: 'system',
        title: () => _('System Monitor'),
        description: () => _('Processor, memory, disk and network use'),
        icon: 'utilities-system-monitor-symbolic',
        sizes: ['small', 'medium', 'large'],
        Widget: SystemWidget,
    },
    {
        id: 'batteries',
        title: () => _('Batteries'),
        description: () => _('Charge of this computer and connected devices'),
        icon: 'battery-good-symbolic',
        sizes: ['small', 'medium', 'large'],
        Widget: BatteriesWidget,
    },
    {
        id: 'note',
        title: () => _('Note'),
        description: () => _('Keep a quick note at hand'),
        icon: 'document-edit-symbolic',
        sizes: ['small', 'medium', 'large'],
        Widget: NotesWidget,
    },
    {
        id: 'photo',
        title: () => _('Photo'),
        description: () => _('A picture from your Pictures folder'),
        icon: 'image-x-generic-symbolic',
        sizes: ['small', 'medium', 'large'],
        Widget: PhotoWidget,
    },
];

// Data shared between widgets (places, quotes, the picture list)
export function clearWidgetCaches() {
    clearPlaces();
    clearQuotes();
    clearPhotoLibrary();
}

export function findWidget(id) {
    return WIDGETS.find(w => w.id === id) ?? null;
}

// Settings store "id:size" strings in board order
export function parseWidgets(strv) {
    const seen = new Set();
    const result = [];
    for (const entry of strv) {
        const [id, size] = entry.split(':');
        const info = findWidget(id);
        if (!info || seen.has(id))
            continue;
        seen.add(id);
        result.push({id, size: info.sizes.includes(size) ? size : info.sizes[0]});
    }
    return result;
}

export function serializeWidgets(list) {
    return list.map(({id, size}) => `${id}:${size}`);
}
