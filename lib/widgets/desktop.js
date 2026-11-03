import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {popIn, popOut} from '../animation.js';
import {addPressFeedback, springTo} from '../spring.js';
import {DEFAULT_CELL, SIZE_LABELS, SPACING, sizeTitle, spanSize} from './board.js';
import {findWidget} from './registry.js';

// Space kept between widgets and the edges of the screen
const MARGIN = 24;
// Where dropped widgets snap to
const SNAP = SPACING;
const DRAG_THRESHOLD = 6;
const BACKDROP_TIME = 200; // ms

function workArea() {
    return Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
}

// Settings store "id:size:x:y" strings, x and y from the top left corner of
// the primary monitor's work area
export function parseDesktopWidgets(strv) {
    const seen = new Set();
    const result = [];
    for (const entry of strv) {
        const [id, size, x, y] = entry.split(':');
        const info = findWidget(id);
        if (!info || seen.has(id))
            continue;
        seen.add(id);
        const px = parseInt(x), py = parseInt(y);
        result.push({
            id,
            size: info.sizes.includes(size) ? size : info.sizes[0],
            x: Number.isFinite(px) ? px : null,
            y: Number.isFinite(py) ? py : null,
        });
    }
    return result;
}

function overlaps(a, b, gap = 0) {
    return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap &&
        a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

// One widget on the desktop, plus the badges and the drag shield shown
// while arranging
const DesktopItem = GObject.registerClass(
class GnDesktopItem extends St.Widget {
    constructor(info, size, context) {
        super({
            style_class: 'gn-desktop-widget',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
        });
        this.info = info;
        this._context = context;
        this.setSize(size);
    }

    get id() {
        return this.info.id;
    }

    get rect() {
        const [width, height] = spanSize(this.widgetSize, DEFAULT_CELL);
        return {x: this.x, y: this.y, width, height};
    }

    setSize(size) {
        this.widgetSize = size;
        this.widget?.destroy();
        this.widget = null;
        try {
            this.widget = new this.info.Widget(size, this._context);
        } catch (e) {
            logError(e, `GNOME Next: Failed to create widget ${this.id}`);
            this.widget = new St.Widget({style_class: 'gn-widget world-clocks-button', x_expand: true, y_expand: true});
        }
        this.insert_child_at_index(this.widget, 0);
        this.set_size(...spanSize(size, DEFAULT_CELL));
        if (this._sizeLabel)
            this._sizeLabel.text = SIZE_LABELS[size]();
    }

    setArranging(arranging, desktop) {
        if (arranging === !!this._shield)
            return;

        if (!arranging) {
            this._shield.destroy();
            this._badge.destroy();
            this._sizeLabel.destroy();
            this._shield = this._badge = this._sizeLabel = null;
            return;
        }

        this._shield = new St.Widget({
            style_class: 'gn-widget-shield gn-desktop-shield',
            reactive: true,
            x_expand: true,
            y_expand: true,
        });
        this._shield.connect('button-press-event', (_a, event) => desktop._onPress(this, event));
        this._shield.connect('motion-event', (_a, event) => desktop._onMotion(this, event));
        this._shield.connect('button-release-event', (_a, event) => desktop._onRelease(this, event));
        this.add_child(this._shield);

        this._sizeLabel = new St.Label({
            style_class: 'gn-widget-size',
            text: SIZE_LABELS[this.widgetSize](),
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
        });
        this.add_child(this._sizeLabel);

        this._badge = new St.Button({
            style_class: 'button gn-widget-badge remove gn-desktop-badge',
            icon_name: 'list-remove-symbolic',
            accessible_name: _('Remove %s').format(this.info.title()),
            can_focus: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._badge.connect('clicked', () => desktop.remove(this));
        addPressFeedback(this._badge, {scale: 0.85});
        this.add_child(this._badge);
        popIn([this._badge, this._sizeLabel], {from: 0.4});
    }
});

// Widgets on the desktop, over the wallpaper and under the windows. Unlike
// under the calendar, widgets with nothing to show stay, with their
// placeholder: they were put there on purpose. Right
// click one for its size, to add it under the calendar too or to remove it;
// "Edit Widgets" brings them over the windows to be dragged around.
//
// `calendar`: {add(info, size)} puts a widget under the calendar too,
// {has(id)} tells whether it is there, {edit()} opens the calendar's editor
export class DesktopWidgets extends EventEmitter {
    constructor(settings, context, calendar) {
        super();
        this._settings = settings;
        this._context = {...context, settings};
        this._calendar = calendar;
        this._items = [];
        this._arranging = false;

        this._layer = new St.Widget({
            name: 'gnDesktopWidgets',
            layout_manager: new Clutter.FixedLayout(),
        });
        this._layer.connect('key-press-event', (_a, event) => {
            if (!this._arranging || event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this.setArranging(false);
            return Clutter.EVENT_STOP;
        });
        Main.layoutManager._backgroundGroup.add_child(this._layer);

        this._menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, St.Side.TOP);
        this._menu.actor.add_style_class_name('background-menu');
        Main.layoutManager.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();
        this._menuManager = new PopupMenu.PopupMenuManager(this._layer);
        this._menuManager.addMenu(this._menu);

        settings.connectObject('changed::desktop-widgets', () => {
            if (!this._saving)
                this._load();
        }, this);
        Main.layoutManager.connectObject('monitors-changed', () => this._fit(), this);
        global.display.connectObject('workareas-changed', () => this._fit(), this);
        Main.overview.connectObject('showing', () => this.setArranging(false), this);
        this._load();
    }

    destroy() {
        this.setArranging(false);
        this._endDrag();
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._menu.destroy();
        this._menu = null;
        this._layer.destroy();
        this._layer = null;
        this._items = [];
    }

    get arranging() {
        return this._arranging;
    }

    get count() {
        return this._items.length;
    }

    has(id) {
        return this._items.some(i => i.id === id);
    }

    _load() {
        this._endDrag();
        this._items.forEach(i => i.destroy());
        this._items = [];
        const area = workArea();
        const pending = [];
        for (const {id, size, x, y} of parseDesktopWidgets(this._settings.get_strv('desktop-widgets'))) {
            const item = this._append(findWidget(id), size);
            if (x === null || y === null)
                pending.push(item);
            else
                item.set_position(area.x + x, area.y + y);
        }
        pending.forEach(item => item.set_position(...this._freeSpot(item)));
        this._fit();
        if (pending.length)
            this._save();
        else
            this.emit('changed');
    }

    _append(info, size) {
        const item = new DesktopItem(info, size, this._context);
        item.connect('captured-event', (_a, event) => this._onCapturedEvent(item, event));
        item.setArranging(this._arranging, this);
        this._items.push(item);
        this._layer.add_child(item);
        return item;
    }

    _save() {
        const area = workArea();
        this._saving = true;
        try {
            this._settings.set_strv('desktop-widgets', this._items.map(i =>
                `${i.id}:${i.widgetSize}:${Math.round(i.x - area.x)}:${Math.round(i.y - area.y)}`));
        } finally {
            this._saving = false;
        }
        this.emit('changed');
    }

    // Puts the widgets back where they were saved, relative to the work
    // area, keeping them inside it (after a monitor or top bar change)
    _fit() {
        const area = workArea();
        const saved = new Map(parseDesktopWidgets(this._settings.get_strv('desktop-widgets'))
            .map(w => [w.id, w]));
        for (const item of this._items) {
            const w = saved.get(item.id);
            const [x, y] = w && w.x !== null && w.y !== null
                ? [area.x + w.x, area.y + w.y] : [item.x, item.y];
            item.set_position(...this._clamp(item, x, y, area));
        }
    }

    _clamp(item, x, y, area = workArea()) {
        const {width, height} = item.rect;
        return [
            Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
            Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))),
        ];
    }

    // The first free place from the top right corner, down each column
    _freeSpot(item) {
        const area = workArea();
        const {width, height} = item.rect;
        const others = this._items.filter(i => i !== item).map(i => i.rect);
        const step = (DEFAULT_CELL + SPACING) / 2;
        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        for (let col = 0; ; col++) {
            const x = rtl
                ? area.x + MARGIN + col * step
                : area.x + area.width - MARGIN - width - col * step;
            if (x < area.x || x + width > area.x + area.width)
                break;
            for (let y = area.y + MARGIN; y + height <= area.y + area.height - MARGIN; y += step) {
                const rect = {x, y, width, height};
                if (!others.some(o => overlaps(rect, o, SPACING / 2)))
                    return [Math.round(x), Math.round(y)];
            }
        }
        return this._clamp(item, area.x + area.width - MARGIN - width, area.y + MARGIN, area);
    }

    add(info, size) {
        if (this.has(info.id))
            return;
        const item = this._append(info, size);
        item.set_position(...this._freeSpot(item));
        popIn([item], {from: 0.85});
        this._save();
    }

    remove(item) {
        const done = () => {
            this._items = this._items.filter(i => i !== item);
            item.destroy();
            this._save();
        };
        if (item.mapped)
            popOut(item, done);
        else
            done();
    }

    openCalendarEditor() {
        this.setArranging(false);
        this._calendar.edit();
    }

    // Under the calendar too; it stays on the desktop
    _addToCalendar(item) {
        this._calendar.add(item.info, item.widgetSize);
    }

    _setSize(item, size) {
        if (size === item.widgetSize)
            return;
        item.setSize(size);
        item.set_position(...this._clamp(item, item.x, item.y));
        popIn([item], {from: 0.92});
        this._save();
    }

    // Right click: the widget's menu. While arranging the shield takes the
    // clicks instead.
    _onCapturedEvent(item, event) {
        if (this._arranging || event.type() !== Clutter.EventType.BUTTON_PRESS ||
            event.get_button() !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._openMenu(item, x, y);
        return Clutter.EVENT_STOP;
    }

    _openMenu(item, x, y) {
        this._menu.removeAll();
        if (item.info.sizes.length > 1) {
            for (const size of item.info.sizes) {
                const menuItem = this._menu.addAction(sizeTitle(size), () => this._setSize(item, size));
                menuItem.setOrnament(size === item.widgetSize
                    ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            }
            this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        this._menu.addAction(_('Edit Widgets'), () => this.setArranging(true));
        this._menu.addAction(_('Add Widgets…'), () => this.openCalendarEditor());
        if (!this._calendar.has(item.id))
            this._menu.addAction(_('Add to Calendar'), () => this._addToCalendar(item));
        this._menu.addAction(_('Remove'), () => this.remove(item));
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        this._menu.open();
    }

    // While arranging, the widgets come over the windows (on a dimmed
    // backdrop) to be dragged around; a click on the backdrop, Escape or
    // Done puts them back on the desktop
    setArranging(arranging) {
        if (arranging === this._arranging || (arranging && !this._items.length))
            return;
        this._endDrag();
        this._arranging = arranging;

        if (arranging) {
            this._backdrop = new St.Widget({
                style_class: 'gn-desktop-backdrop',
                reactive: true,
                opacity: 0,
            });
            this._backdrop.add_constraint(new Clutter.BindConstraint({
                source: global.stage,
                coordinate: Clutter.BindCoordinate.ALL,
            }));
            this._backdrop.connect('button-release-event', () => {
                this.setArranging(false);
                return Clutter.EVENT_STOP;
            });
            this._backdrop.ease({opacity: 255, duration: BACKDROP_TIME});

            this._done = new St.Button({
                style_class: 'button gn-board-done gn-desktop-done',
                label: _('Done'),
                can_focus: true,
            });
            this._done.connect('clicked', () => this.setArranging(false));
            addPressFeedback(this._done);
            const area = workArea();
            this._done.connect('notify::width', () => {
                this._done.set_position(
                    Math.round(area.x + (area.width - this._done.width) / 2),
                    area.y + MARGIN / 2);
            });

            this._hint = new St.Label({
                style_class: 'gn-desktop-hint',
                text: _('Drag to move, click to resize'),
            });
            this._hint.connect('notify::width', () => {
                this._hint.set_position(
                    Math.round(area.x + (area.width - this._hint.width) / 2),
                    area.y + area.height - MARGIN - this._hint.height);
            });

            // Over the windows, under the top bar
            this._backgroundGroup().remove_child(this._layer);
            Main.layoutManager.uiGroup.insert_child_below(this._layer, Main.layoutManager.panelBox);
            this._layer.insert_child_at_index(this._backdrop, 0);
            this._layer.add_child(this._done);
            this._layer.add_child(this._hint);
            popIn([this._done], {from: 0.6});

            this._layer.reactive = true;
            this._grab = Main.pushModal(this._layer, {actionMode: Shell.ActionMode.POPUP});
            this._done.grab_key_focus();
        } else {
            if (this._grab)
                Main.popModal(this._grab);
            this._grab = null;
            this._backdrop?.destroy();
            this._done?.destroy();
            this._hint?.destroy();
            this._backdrop = this._done = this._hint = null;
            this._layer.reactive = false;
            this._layer.get_parent()?.remove_child(this._layer);
            this._backgroundGroup().add_child(this._layer);
        }

        this._items.forEach(i => i.setArranging(arranging, this));
        this.emit('arranging-changed');
    }

    _backgroundGroup() {
        return Main.layoutManager._backgroundGroup;
    }

    _onPress(item, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._press)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._press = {item, x, y, startX: item.x, startY: item.y, dragging: false};
        this._dragGrab = global.stage.grab(item._shield);
        return Clutter.EVENT_STOP;
    }

    _onMotion(item, event) {
        const press = this._press;
        if (press?.item !== item)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        if (!press.dragging) {
            if (Math.hypot(x - press.x, y - press.y) < DRAG_THRESHOLD)
                return Clutter.EVENT_STOP;
            press.dragging = true;
            this._layer.set_child_above_sibling(item, null);
            // The Done button and the hint stay on top
            if (this._done)
                this._layer.set_child_above_sibling(this._done, null);
            item.set_pivot_point(0.5, 0.5);
            item.add_style_class_name('dragging');
            springTo(item, {scale_x: 1.04, scale_y: 1.04}, {preset: 'snappy'});
        }
        const [nx, ny] = this._clamp(item, press.startX + x - press.x, press.startY + y - press.y);
        item.set_position(nx, ny);
        return Clutter.EVENT_STOP;
    }

    _onRelease(item, event) {
        const press = this._press;
        if (press?.item !== item || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag({reset: false});
        if (press.dragging) {
            item.remove_style_class_name('dragging');
            // Snap from where the widget is to the grid, in screen space
            const area = workArea();
            const snap = (v, origin) => origin + Math.round((v - origin) / SNAP) * SNAP;
            const [sx, sy] = this._clamp(item, snap(item.x, area.x), snap(item.y, area.y), area);
            const dx = item.x - sx, dy = item.y - sy;
            item.set_position(sx, sy);
            item.set({translation_x: dx, translation_y: dy});
            springTo(item, {translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1}, {preset: 'bouncy'});
            this._save();
        } else {
            const sizes = item.info.sizes;
            this._setSize(item, sizes[(sizes.indexOf(item.widgetSize) + 1) % sizes.length]);
        }
        return Clutter.EVENT_STOP;
    }

    _endDrag({reset = true} = {}) {
        this._dragGrab?.dismiss();
        this._dragGrab = null;
        const press = this._press;
        this._press = null;
        if (reset && press && this._items.includes(press.item)) {
            press.item.remove_style_class_name('dragging');
            press.item.set({scale_x: 1, scale_y: 1});
            press.item.set_position(press.startX, press.startY);
        }
    }
}

// "Add Widgets…" and "Edit Desktop Widgets" in the desktop's right-click
// menu, on every monitor. The shell makes a new background (and menu)
// whenever the wallpaper or the monitors change, so new ones get them too.
export class BackgroundMenuItems {
    constructor(desktop) {
        this._desktop = desktop;
        this._menus = new Map();
        this._managers = new Set();
        this._idleId = 0;
        // A new background manager (monitors changed) adds its first
        // background right away; a new wallpaper swaps the manager's
        // background later and says so with 'changed'
        Main.layoutManager._backgroundGroup.connectObject('child-added', (_group, actor) => {
            if (actor instanceof Meta.BackgroundActor && !this._idleId) {
                this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._idleId = 0;
                    this._sync();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }, this);
        this._sync();
    }

    destroy() {
        Main.layoutManager._backgroundGroup.disconnectObject(this);
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._managers.forEach(m => m.disconnectObject(this));
        this._managers.clear();
        for (const [menu, items] of this._menus) {
            menu.disconnectObject(this);
            items.forEach(i => i.destroy());
        }
        this._menus.clear();
    }

    _sync() {
        const managers = new Set(Main.layoutManager._bgManagers ?? []);
        for (const manager of this._managers) {
            if (!managers.has(manager)) {
                manager.disconnectObject(this);
                this._managers.delete(manager);
            }
        }
        for (const manager of managers) {
            if (!this._managers.has(manager)) {
                this._managers.add(manager);
                // Runs after the shell's handler, which makes the new menu
                manager.connectObject('changed', () => this._patch(manager.backgroundActor), this);
            }
            this._patch(manager.backgroundActor);
        }
    }

    _patch(actor) {
        const menu = actor?._backgroundMenu;
        if (!menu || this._menus.has(menu))
            return;
        const add = menu.addAction(_('Add Widgets…'), () => this._desktop.openCalendarEditor());
        const edit = menu.addAction(_('Edit Desktop Widgets'), () => this._desktop.setArranging(true));
        const separator = new PopupMenu.PopupSeparatorMenuItem();
        menu.addMenuItem(separator);
        menu.moveMenuItem(add, 0);
        menu.moveMenuItem(edit, 1);
        menu.moveMenuItem(separator, 2);
        this._menus.set(menu, [add, edit, separator]);
        menu.connectObject(
            'open-state-changed', (_m, open) => {
                if (open)
                    edit.visible = this._desktop.count > 0;
            },
            // Its background went away
            'destroy', () => this._menus.delete(menu),
            this);
    }
}
