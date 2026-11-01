import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GWeather from 'gi://GWeather';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {formatDateWithCFormatString, formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {animateResize, fadeIn, slideFrom} from './animation.js';
import {ClocksCard} from './clocks.js';
import {ZeroWidthLayout} from './layouts.js';
import {addPressFeedback} from './spring.js';
import {WidgetBoard, spanSize} from './widgets/board.js';
import {WidgetGallery} from './widgets/gallery.js';
import {clearWidgetCaches} from './widgets/registry.js';

const HIDDEN = 'gn-calendar';
// Popover border, padding and arrow, and the edit button under the widgets
const POPOVER_CHROME = 80;
const EDIT_BUTTON_HEIGHT = 44;

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
}

function capitalize(text) {
    return text ? text[0].toLocaleUpperCase() + text.slice(1) : text;
}

const WeatherCard = GObject.registerClass(
class GnWeatherCard extends St.Button {
    constructor(client) {
        super({
            style_class: 'gn-weather weather-button',
            can_focus: true,
            x_expand: true,
            visible: false,
        });

        this._client = client;

        const box = new St.BoxLayout({style_class: 'gn-weather-box', x_expand: true});
        this.child = box;

        this._icon = new St.Icon({
            style_class: 'gn-weather-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._icon);

        const labels = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        box.add_child(labels);

        this._summary = new St.Label({style_class: 'gn-weather-summary'});
        this._summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        labels.add_child(this._summary);

        this._temps = new St.Label({style_class: 'gn-weather-temps'});
        labels.add_child(this._temps);

        client.connectObject('changed', () => this._sync(), this);
        addPressFeedback(this, {scale: 0.98});
        this.connect('destroy', () => client.disconnectObject(this));
        this._sync();
    }

    setFlat(flat) {
        if (flat) {
            this.remove_style_class_name('weather-button');
            this.add_style_class_name('flat');
        } else {
            this.add_style_class_name('weather-button');
            this.remove_style_class_name('flat');
        }
    }

    _todayRange(info) {
        const now = GLib.DateTime.new_now_local();
        const temps = [];
        const [ok, current] = info.get_value_temp(GWeather.TemperatureUnit.DEFAULT);
        if (ok)
            temps.push(current);

        for (const forecast of info.get_forecast_list()) {
            const [valid, timestamp] = forecast.get_value_update();
            if (!valid || timestamp === 0)
                continue;
            const time = GLib.DateTime.new_from_unix_local(timestamp);
            if (time.get_day_of_year() !== now.get_day_of_year() ||
                time.get_year() !== now.get_year())
                continue;
            const [hasTemp, temp] = forecast.get_value_temp(GWeather.TemperatureUnit.DEFAULT);
            if (hasTemp)
                temps.push(temp);
        }
        return temps.length ? [Math.max(...temps), Math.min(...temps)] : null;
    }

    _sync() {
        const client = this._client;
        const info = client.info;
        this.visible = client.available && client.hasLocation && !client.loading && info.is_valid();
        if (!this.visible)
            return;

        const iconName = info.get_symbolic_icon_name();
        this._icon.icon_name = iconName;
        if (iconName.startsWith('weather-clear') || iconName.startsWith('weather-few-clouds'))
            this._icon.add_style_class_name('sunny');
        else
            this._icon.remove_style_class_name('sunny');

        const conditions = info.get_conditions();
        this._summary.text = capitalize(conditions && conditions !== '-'
            ? conditions
            : info.get_sky());

        const range = this._todayRange(info);
        this._temps.text = range
            ? `${Math.round(range[0])}° ${Math.round(range[1])}°`
            : info.get_temp_summary();
    }

    vfunc_clicked() {
        this._client.activateApp();
        Main.overview.hide();
        Main.panel.closeCalendar();
    }
});

// Left column (events) only takes part in the width: the popover height is
// determined by the calendar and clocks on the right, and the events scroll.
// While editing widgets the gallery on the left counts too.
const PopoverLayout = GObject.registerClass(
class GnPopoverLayout extends Clutter.LayoutManager {
    constructor(left, right) {
        super();
        this._left = left;
        this._right = right;
        this.editing = false;
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        const [rightMin, rightNat] = this._right.get_preferred_width(-1);
        if (!this._left.visible)
            return [rightMin, rightNat];

        const [leftMin, leftNat] = this._left.get_preferred_width(-1);
        return [leftMin + rightMin, leftNat + rightNat];
    }

    vfunc_get_preferred_height(_container, _forWidth) {
        const [, rightWidth] = this._right.get_preferred_width(-1);
        const right = this._right.get_preferred_height(rightWidth);
        if (!this.editing || !this._left.visible)
            return right;
        const [, leftWidth] = this._left.get_preferred_width(-1);
        const left = this._left.get_preferred_height(leftWidth);
        return [Math.max(left[0], right[0]), Math.max(left[1], right[1])];
    }

    vfunc_allocate(container, box) {
        const [, rightWidth] = this._right.get_preferred_width(-1);
        const rtl = container.text_direction === Clutter.TextDirection.RTL;
        const {x1, y1, x2, y2} = box;

        if (!this._left.visible) {
            // While shrinking back to one column, keep the calendar at its
            // size and where it was (the side the events column leaves)
            const width = Math.min(rightWidth, x2 - x1);
            this._right.allocate(rtl
                ? Clutter.ActorBox.new(x1, y1, x1 + width, y2)
                : Clutter.ActorBox.new(x2 - width, y1, x2, y2));
            return;
        }

        const split = rtl ? x1 + rightWidth : x2 - rightWidth;
        const leftBox = rtl
            ? Clutter.ActorBox.new(split, y1, x2, y2)
            : Clutter.ActorBox.new(x1, y1, split, y2);
        const rightBox = rtl
            ? Clutter.ActorBox.new(x1, y1, split, y2)
            : Clutter.ActorBox.new(split, y1, x2, y2);
        this._left.allocate(leftBox);
        this._right.allocate(rightBox);
    }
});

// "Calendar menu concept" mockup: a calendar popover without notifications
// whose layout scales with its content.
export class CalendarPopover {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        const dm = Main.panel.statusArea.dateMenu;
        this._dm = dm;
        this._calendar = dm._calendar;

        this._calendarParent = this._calendar.get_parent();
        this._calendarIndex = this._calendarParent.get_children().indexOf(this._calendar);
        this._calendarArea = this._calendarParent.get_parent();
        this._bin = this._calendarArea.get_parent();

        this._selectedDate = new Date();

        this._left = new St.BoxLayout({
            style_class: 'gn-cal-left',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });
        this._right = new St.BoxLayout({
            style_class: 'gn-cal-right',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._layout = new PopoverLayout(this._left, this._right);
        this._root = new St.Widget({
            style_class: 'gn-calendar-popover',
            layout_manager: this._layout,
        });
        this._root.add_child(this._left);
        this._root.add_child(this._right);

        // Left column: date header, weather and the day's events
        this._header = new St.Button({
            style_class: 'gn-cal-header',
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
            accessible_name: _('Go to today'),
        });
        const headerBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this._weekdayLabel = new St.Label({style_class: 'gn-cal-weekday'});
        this._dateLabel = new St.Label({style_class: 'gn-cal-date'});
        this._dateLabel.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.NONE,
        });
        headerBox.add_child(this._weekdayLabel);
        headerBox.add_child(this._dateLabel);
        this._header.child = headerBox;
        this._header.connect('clicked', () => this._calendar.setDate(new Date()));
        this._left.add_child(this._header);

        this._leftWeatherSlot = new St.Bin({x_expand: true, x_align: Clutter.ActorAlign.FILL});
        this._left.add_child(this._leftWeatherSlot);

        this._events = new St.BoxLayout({
            style_class: 'gn-events',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._eventsScroll = new St.ScrollView({
            style_class: 'gn-events-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._events,
        });
        this._left.add_child(this._eventsScroll);

        // Right column: calendar, world clocks and (without events) weather
        this._calendarParent.remove_child(this._calendar);
        this._calendarCard = new St.Bin({
            style_class: 'world-clocks-button gn-calendar-card',
            x_expand: true,
            child: this._calendar,
        });
        this._right.add_child(this._calendarCard);

        this._weatherClient = dm._weatherItem?._weatherClient ?? null;
        this._buildExtras();

        this._lock.hide(this._calendarArea, HIDDEN);
        this._bin.add_child(this._root);

        this._calendar.connectObject('selected-date-changed', (_cal, datetime) => {
            this._selectedDate = new Date(datetime.to_unix() * 1000);
            this._animateMonthChange();
            // The shell freezes the popover size while browsing other days;
            // here the layout depends on the selected day's events
            this._bin.layout_manager.frozen = false;
            this._reloadEvents();
        }, this);

        dm.menu.connectObject('open-state-changed', (_menu, open) => {
            if (!open) {
                this._shownMonth = null;
                return;
            }
            this._selectedDate = new Date();
            this._weatherClient?.update();
            this._reloadEvents();
            this._syncHeights();
            this._board?.scrollToTop();
        }, this);
        dm.menu.connectObject('menu-closed', () => this._board?.setEditing(false), this);

        Main.sessionMode.connectObject('updated', () => this._connectEventSource(), this);
        this._settings.connectObject(
            'changed::show-events', () => this._reloadEvents(),
            'changed::calendar-layout', () => this._reloadEvents(),
            'changed::enable-widgets', () => {
                this._destroyExtras();
                this._buildExtras();
                this._reloadEvents();
            },
            this);

        this._connectEventSource();
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._dm.menu.disconnectObject(this);
        this._calendar.disconnectObject(this);
        this._eventSource?.disconnectObject(this);
        this._eventSource = null;

        this._calendarCard.child = null;
        this._calendarParent.insert_child_at_index(this._calendar, this._calendarIndex);

        this._destroyExtras();
        this._root.destroy();
        this._root = null;
        clearWidgetCaches();

        this._lock.release(this._calendarArea, HIDDEN);
    }

    // Under the calendar: either the widget board, or the world clocks and
    // weather cards
    _buildExtras() {
        // The calendar sets the column width; what is under it follows
        const bin = () => {
            const actor = new St.Widget({layout_manager: new ZeroWidthLayout(), x_expand: true});
            this._right.add_child(actor);
            this._extras.push(actor);
            return actor;
        };
        this._extras = [];

        if (this._settings.get_boolean('enable-widgets')) {
            this._board = new WidgetBoard(this._settings, {
                weatherClient: this._weatherClient,
                wallClock: this._dm._clock,
                eventSource: () => this._dm._eventSource ?? null,
            });
            this._board.connectObject('editing-changed', () => this._onEditingChanged(), this);
            bin().add_child(this._board);
            this._syncHeights();
            return;
        }

        this._clocks = new ClocksCard(this._dm._clock);
        this._clocks.connectObject('changed', () => this._syncLayout(), this);
        const clocksBin = bin();
        clocksBin.add_child(this._clocks);
        this._clocks.bind_property('visible', clocksBin, 'visible', GObject.BindingFlags.SYNC_CREATE);

        this._rightWeatherSlot = new St.Bin({x_expand: true, x_align: Clutter.ActorAlign.FILL});
        bin().add_child(this._rightWeatherSlot);
        if (this._weatherClient)
            this._weather = new WeatherCard(this._weatherClient);
    }

    _destroyExtras() {
        if (this._board?.editing)
            this._board.setEditing(false);
        this._leftWeatherSlot.child = null;
        this._weather?.destroy();
        this._weather = null;
        this._extras.forEach(a => a.destroy());
        this._extras = [];
        this._board = null;
        this._clocks = null;
        this._rightWeatherSlot = null;
    }

    // Edit mode: the gallery takes the place of the date and events on the
    // left, and the widgets the whole right column
    _onEditingChanged() {
        const editing = this._board.editing;
        animateResize(this._root, () => {
            this._editing = editing;
            this._layout.editing = editing;
            if (editing) {
                // Keep the column as wide as the calendar made it
                this._right.width = this._right.get_width();
                this._calendarCard.hide();
                this._gallery = new WidgetGallery(this._board);
                this._left.add_child(this._gallery);
                // Room for a medium preview, the list and column padding
                this._left.style = `width: ${spanSize('medium', this._board.cell)[0] + 32}px;`;
                this._root.add_style_class_name('editing');
            } else {
                this._gallery?.destroy();
                this._gallery = null;
                this._left.style = null;
                this._calendarCard.show();
                this._right.width = -1;
                this._root.remove_style_class_name('editing');
            }
            [this._header, this._leftWeatherSlot, this._eventsScroll].forEach(a => (a.visible = !editing));
            this._syncHeights();
            this._applyLayout(editing || this._hasEvents || this._alwaysTwoColumns);
        }, {width: true});
        if (this._gallery)
            fadeIn(this._gallery);
    }

    // The widgets scroll once the popover would not fit on the screen
    _syncHeights() {
        // Theme nodes (and so sizes) only exist once the popover is on stage
        if (!this._board || !this._root.get_stage())
            return;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const available = Math.floor(workArea.height / scaleFactor) - POPOVER_CHROME;
        if (this._editing) {
            this._board.setMaxHeight(available - EDIT_BUTTON_HEIGHT);
            this._gallery?.setMaxHeight(available - 70);
            return;
        }
        const [, width] = this._calendarCard.get_preferred_width(-1);
        const [, calendarHeight] = this._calendarCard.get_preferred_height(width);
        this._board.setMaxHeight(available - calendarHeight - EDIT_BUTTON_HEIGHT);
    }

    // The shell rebuilds the day grid right after emitting the date change;
    // slide the new month in from the side we are moving to
    _animateMonthChange() {
        const date = this._selectedDate;
        const month = date.getFullYear() * 12 + date.getMonth();
        const previous = this._shownMonth;
        this._shownMonth = month;
        if (previous == null || previous === month || !this._root.mapped)
            return;

        const direction = month > previous ? 1 : -1;
        const laters = global.compositor.get_laters();
        laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            const calendar = this._calendar;
            if (!this._root)
                return GLib.SOURCE_REMOVE;
            calendar.get_children()
                .slice(calendar._firstDayIndex ?? 0)
                .forEach(day => slideFrom(day, direction, {distance: 28, duration: 260}));
            if (calendar._monthLabel)
                slideFrom(calendar._monthLabel, direction, {distance: 12, duration: 260});
            return GLib.SOURCE_REMOVE;
        });
    }

    _connectEventSource() {
        const source = this._dm._eventSource ?? null;
        if (source !== this._eventSource) {
            this._eventSource?.disconnectObject(this);
            this._eventSource = source;
            source?.connectObject('changed', () => this._reloadEvents(), this);
        }
        this._reloadEvents();
    }

    _formatEventTime(event, dayStart, dayEnd) {
        const allDay = event.date <= dayStart && event.end >= dayEnd;
        if (allDay)
            return C_('event list time', 'All Day');
        if (event.date < dayStart)
            return _('Until %s').format(formatTime(event.end, {timeOnly: true}));
        return formatTime(event.date, {timeOnly: true});
    }

    _reloadEvents() {
        const date = this._selectedDate;
        const now = new Date();
        const dayStart = startOfDay(date);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        this._weekdayLabel.text = capitalize(formatDateWithCFormatString(date, '%A'));
        /* Translators: date in the calendar popover header, see strftime(3) */
        this._dateLabel.text = formatDateWithCFormatString(date, _('%-d %B %Y'));

        let events = [];
        if (this._settings.get_boolean('show-events') && this._eventSource)
            events = this._eventSource.getEvents(dayStart, dayEnd);

        // For today, only what is still ahead
        if (sameDay(date, now))
            events = events.filter(e => e.end > now || e.date.getTime() === e.end.getTime() && e.date >= now);
        events.sort((a, b) => a.date - b.date);

        this._events.destroy_all_children();
        for (const event of events) {
            const row = new St.Button({
                style_class: 'gn-event',
                can_focus: true,
                x_expand: true,
            });
            const box = new St.BoxLayout({x_expand: true});
            box.add_child(new St.Label({
                style_class: 'gn-event-time',
                text: this._formatEventTime(event, dayStart, dayEnd),
                y_align: Clutter.ActorAlign.START,
            }));
            const summary = new St.Label({
                style_class: 'gn-event-summary',
                text: event.summary ?? '',
                x_expand: true,
                y_align: Clutter.ActorAlign.START,
            });
            summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(summary);
            row.child = box;
            row.connect('clicked', () => this._openCalendarApp());
            addPressFeedback(row, {scale: 0.97});
            this._events.add_child(row);
        }

        this._hasEvents = events.length > 0;
        this._alwaysTwoColumns = this._settings.get_string('calendar-layout') === 'two-columns';

        if (!this._hasEvents && this._alwaysTwoColumns) {
            this._events.add_child(new St.Label({
                style_class: 'gn-events-empty',
                text: sameDay(date, now) ? _('No more events today') : _('No events'),
            }));
        }
        this._syncLayout();
    }

    _syncLayout() {
        if (this._editing)
            return;
        const twoColumns = this._hasEvents || this._alwaysTwoColumns;
        if (this._root.mapped && twoColumns !== this._left.visible) {
            animateResize(this._root, () => this._applyLayout(twoColumns), {width: true});
            fadeIn(twoColumns ? this._left : this._right);
            if (this._weather)
                fadeIn(this._weather);
            return;
        }
        this._applyLayout(twoColumns);
    }

    _applyLayout(twoColumns) {
        this._left.visible = twoColumns;

        if (this._weather) {
            const slot = twoColumns ? this._leftWeatherSlot : this._rightWeatherSlot;
            const other = twoColumns ? this._rightWeatherSlot : this._leftWeatherSlot;
            if (slot.child !== this._weather) {
                other.child = null;
                slot.child = this._weather;
            }
            this._weather.setFlat(twoColumns);
        }

        if (twoColumns)
            this._root.add_style_class_name('two-columns');
        else
            this._root.remove_style_class_name('two-columns');
    }

    _openCalendarApp() {
        Main.overview.hide();
        Main.panel.closeCalendar();

        const app = Gio.AppInfo.get_default_for_type('text/calendar', false);
        if (!app)
            return;

        const context = global.create_app_launch_context(0, -1);
        if (app.get_id() === 'org.gnome.Evolution.desktop')
            app.launch_action('calendar', context);
        else
            app.launch([], context);
    }
}
