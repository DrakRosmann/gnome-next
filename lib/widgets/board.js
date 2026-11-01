import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {animateResize, popIn, popOut} from '../animation.js';
import {addPressFeedback, springTo, stopSpring} from '../spring.js';
import {SPANS} from './base.js';
import {findWidget, parseWidgets, serializeWidgets} from './registry.js';

const COLUMNS = 2;
export const SPACING = 12;
export const DEFAULT_CELL = 144;
const DRAG_THRESHOLD = 6;

export const SIZE_LABELS = {
    /* Translators: widget size letters (small, medium, large) */
    small: () => _('S'),
    medium: () => _('M'),
    large: () => _('L'),
};

export function sizeTitle(size) {
    return {small: _('Small'), medium: _('Medium'), large: _('Large')}[size];
}

export function cellFor(width) {
    return Math.max(1, Math.floor((width - SPACING * (COLUMNS - 1)) / COLUMNS));
}

export function spanSize(size, cell) {
    const [w, h] = SPANS[size];
    return [w * cell + (w - 1) * SPACING, h * cell + (h - 1) * SPACING];
}

// Dense packing: each widget takes the first place it fits in, so small
// widgets fill the hole left next to an earlier small one. Returns rects in
// grid coordinates (left to right; mirrored by the caller for RTL).
export function placeWidgets(sizes, width) {
    const cell = cellFor(width);
    const taken = [];
    const free = (row, col, w, h) => {
        for (let y = row; y < row + h; y++) {
            for (let x = col; x < col + w; x++) {
                if (taken[y]?.[x])
                    return false;
            }
        }
        return true;
    };
    const rects = sizes.map(size => {
        const [w, h] = SPANS[size];
        for (let row = 0; ; row++) {
            for (let col = 0; col + w <= COLUMNS; col++) {
                if (!free(row, col, w, h))
                    continue;
                for (let y = row; y < row + h; y++) {
                    taken[y] ??= [];
                    for (let x = col; x < col + w; x++)
                        taken[y][x] = true;
                }
                const [width_, height] = spanSize(size, cell);
                return {x: col * (cell + SPACING), y: row * (cell + SPACING), width: width_, height};
            }
        }
    });
    const rows = taken.length;
    return {cell, rects, height: rows ? rows * cell + (rows - 1) * SPACING : 0};
}

const BoardLayout = GObject.registerClass(
class GnBoardLayout extends Clutter.LayoutManager {
    constructor(slots) {
        super();
        this._slots = slots;
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        const width = COLUMNS * DEFAULT_CELL + (COLUMNS - 1) * SPACING;
        return [width, width];
    }

    vfunc_get_preferred_height(_container, forWidth) {
        const width = forWidth >= 0 ? forWidth : COLUMNS * DEFAULT_CELL + (COLUMNS - 1) * SPACING;
        const {height} = placeWidgets(this._slots().map(s => s.widgetSize), width);
        return [height, height];
    }

    vfunc_allocate(container, box) {
        const slots = this._slots();
        const width = box.get_width();
        const {rects} = placeWidgets(slots.map(s => s.widgetSize), width);
        const rtl = container.text_direction === Clutter.TextDirection.RTL;
        slots.forEach((slot, i) => {
            const r = rects[i];
            const x = rtl ? box.x2 - r.x - r.width : box.x1 + r.x;
            const y = box.y1 + r.y;
            slot.allocate(Clutter.ActorBox.new(x, y, x + r.width, y + r.height));
        });
    }
});

// One widget on the board, plus the badge and the drag/click shield shown
// while editing
const Slot = GObject.registerClass({
    Signals: {'empty-changed': {}},
}, class GnWidgetSlot extends St.Widget {
    constructor(info, size, context) {
        super({
            style_class: 'gn-widget-slot',
            layout_manager: new Clutter.BinLayout(),
        });
        this.info = info;
        this._context = context;
        this.setSize(size);
    }

    get id() {
        return this.info.id;
    }

    get empty() {
        return this.widget?.empty ?? true;
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
            this.widget.empty = true;
        }
        this.widget.connect('notify::empty', () => this.emit('empty-changed'));
        this.insert_child_at_index(this.widget, 0);
        if (this._sizeLabel)
            this._sizeLabel.text = SIZE_LABELS[size]();
    }

    setEditing(editing, board) {
        if (editing === !!this._shield)
            return;

        if (!editing) {
            this._shield.destroy();
            this._badge.destroy();
            this._sizeLabel.destroy();
            this._shield = this._badge = this._sizeLabel = null;
            return;
        }

        this._shield = new St.Widget({
            style_class: 'gn-widget-shield',
            reactive: true,
            can_focus: false,
            x_expand: true,
            y_expand: true,
        });
        this._shield.connect('button-press-event', (_a, event) => board._onPress(this, event));
        this._shield.connect('motion-event', (_a, event) => board._onMotion(this, event));
        this._shield.connect('button-release-event', (_a, event) => board._onRelease(this, event));
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
            style_class: 'button gn-widget-badge remove',
            icon_name: 'list-remove-symbolic',
            accessible_name: _('Remove %s').format(this.info.title()),
            can_focus: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._badge.connect('clicked', () => board.remove(this));
        addPressFeedback(this._badge, {scale: 0.85});
        this.add_child(this._badge);
        popIn([this._badge, this._sizeLabel], {from: 0.4});
    }
});

// The widgets under the calendar: a two-column grid of small (1×1), medium
// (2×1) and large (2×2) widgets. In edit mode widgets can be removed, dragged
// to another place and clicked to change their size.
export const WidgetBoard = GObject.registerClass({
    Signals: {
        'editing-changed': {},
        'changed': {},
    },
}, class GnWidgetBoard extends St.BoxLayout {
    constructor(settings, context) {
        super({
            style_class: 'gn-board',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._settings = settings;
        this.widgetContext = {...context, settings};
        this._editing = false;
        this._order = [];
        this._cell = DEFAULT_CELL;

        this._header = new St.BoxLayout({style_class: 'gn-board-header', visible: false});
        const hint = new St.Label({
            style_class: 'gn-board-hint',
            text: _('Drag to move, click to resize'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        hint.clutter_text.set({line_wrap: true, ellipsize: Pango.EllipsizeMode.NONE});
        this._header.add_child(hint);
        const done = new St.Button({
            style_class: 'button gn-board-done',
            label: _('Done'),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        done.connect('clicked', () => this.setEditing(false));
        addPressFeedback(done);
        this._header.add_child(done);
        this.add_child(this._header);

        this._grid = new St.Viewport({
            style_class: 'gn-board-grid',
            layout_manager: new BoardLayout(() => this._visibleSlots()),
            x_expand: true,
        });
        this._grid.connect('notify::allocation', () => {
            this._cell = cellFor(this._grid.get_allocation_box().get_width());
        });
        this._scroll = new St.ScrollView({
            style_class: 'gn-board-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            // A scrollbar would take width from the grid (and the scroll view
            // measures for that narrower width); the fade shows there is more
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            overlay_scrollbars: true,
            x_expand: true,
            child: this._grid,
        });
        this.add_child(this._scroll);

        this._editButton = new St.Button({
            style_class: 'button gn-board-edit',
            label: _('Edit Widgets'),
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._editButton.connect('clicked', () => this.setEditing(true));
        addPressFeedback(this._editButton);
        this.add_child(this._editButton);

        settings.connectObject('changed::widgets', () => {
            if (!this._saving)
                this._load();
        }, this);
        this.connect('destroy', () => {
            this._endDrag();
            settings.disconnectObject(this);
        });
        this._load();
    }

    get editing() {
        return this._editing;
    }

    // Width of one grid cell, for the gallery previews
    get cell() {
        return this._cell;
    }

    has(id) {
        return this._order.some(s => s.id === id);
    }

    setMaxHeight(height) {
        this._scroll.style = `max-height: ${Math.max(0, Math.floor(height))}px;`;
    }

    _visibleSlots() {
        return this._order.filter(s => s.visible);
    }

    _load() {
        this._endDrag();
        this._order.forEach(s => s.destroy());
        this._order = [];
        for (const {id, size} of parseWidgets(this._settings.get_strv('widgets')))
            this._append(findWidget(id), size);
        this._sync();
        this.emit('changed');
    }

    _append(info, size) {
        const slot = new Slot(info, size, this.widgetContext);
        slot.connect('empty-changed', () => {
            if (!this._editing)
                this._animateChange(() => this._sync());
        });
        slot.setEditing(this._editing, this);
        this._order.push(slot);
        this._grid.add_child(slot);
        return slot;
    }

    _save() {
        this._saving = true;
        try {
            this._settings.set_strv('widgets', serializeWidgets(this._order.map(s => ({id: s.id, size: s.widgetSize}))));
        } finally {
            this._saving = false;
        }
        this.emit('changed');
    }

    _sync() {
        // Widgets with nothing to show stay out of the way, except while
        // editing so that they can be removed
        this._order.forEach(s => (s.visible = this._editing || !s.empty));
        this._scroll.visible = this._visibleSlots().length > 0 || this._editing;
        this._header.visible = this._editing;
        this._editButton.visible = !this._editing;
        if (this._editing)
            this.add_style_class_name('editing');
        else
            this.remove_style_class_name('editing');
    }

    scrollToTop() {
        this._scroll.vadjustment.value = 0;
    }

    setEditing(editing) {
        if (editing === this._editing)
            return;
        this._endDrag();
        this._editing = editing;
        this.scrollToTop();
        this._order.forEach(s => s.setEditing(editing, this));
        this._sync();
        this.emit('editing-changed');
    }

    add(info, size) {
        if (this.has(info.id))
            return;
        let slot;
        this._animateChange(() => {
            slot = this._append(info, size);
            this._sync();
        });
        this._save();
        // Scroll to where it went, once it has a place
        const id = slot.connect('notify::allocation', () => {
            slot.disconnect(id);
            const box = slot.get_allocation_box();
            const adjustment = this._scroll.vadjustment;
            const pageSize = adjustment.page_size;
            if (box.y2 > adjustment.value + pageSize || box.y1 < adjustment.value) {
                adjustment.ease(Math.max(0, box.y2 - pageSize), {
                    duration: 300,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
        });
    }

    remove(slot) {
        popOut(slot, () => {
            this._animateChange(() => {
                this._order = this._order.filter(s => s !== slot);
                slot.destroy();
                this._sync();
            });
            this._save();
        });
    }

    _cycleSize(slot) {
        const sizes = slot.info.sizes;
        const next = sizes[(sizes.indexOf(slot.widgetSize) + 1) % sizes.length];
        if (next === slot.widgetSize)
            return;
        this._animateChange(() => slot.setSize(next));
        popIn([slot.widget], {from: 0.92});
        this._save();
    }

    // Runs `change` and glides every widget from where it is drawn now to
    // its new place (FLIP), resizing the board smoothly
    _animateChange(change, {except = null} = {}) {
        const before = new Map();
        for (const slot of this._order) {
            if (slot.visible && slot.has_allocation()) {
                const box = slot.get_allocation_box();
                before.set(slot, {x: box.x1 + slot.translation_x, y: box.y1 + slot.translation_y});
            }
        }

        animateResize(this, change);
        if (!this.mapped || !this._grid.has_allocation())
            return;

        const width = this._grid.get_allocation_box().get_width();
        const visible = this._visibleSlots();
        const {rects} = placeWidgets(visible.map(s => s.widgetSize), width);
        const rtl = this.text_direction === Clutter.TextDirection.RTL;
        visible.forEach((slot, i) => {
            if (slot === except)
                return;
            const old = before.get(slot);
            if (!old) {
                popIn([slot], {from: 0.85});
                return;
            }
            const r = rects[i];
            const x = rtl ? width - r.x - r.width : r.x;
            const dx = old.x - x;
            const dy = old.y - r.y;
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1)
                return;
            slot.set({translation_x: dx, translation_y: dy});
            springTo(slot, {translation_x: 0, translation_y: 0}, {preset: 'smooth'});
        });
    }

    // Where `slot` goes in the current layout, in grid coordinates
    _rectOf(slot) {
        const width = this._grid.get_allocation_box().get_width();
        const visible = this._visibleSlots();
        const {rects} = placeWidgets(visible.map(s => s.widgetSize), width);
        const r = rects[visible.indexOf(slot)];
        if (this.text_direction === Clutter.TextDirection.RTL)
            return {...r, x: width - r.x - r.width};
        return r;
    }

    _onPress(slot, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._press)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const [, gx, gy] = this._grid.transform_stage_point(x, y);
        const rect = this._rectOf(slot);
        this._press = {slot, x, y, offsetX: gx - rect.x, offsetY: gy - rect.y, dragging: false, last: null};
        this._grab = global.stage.grab(slot._shield);
        return Clutter.EVENT_STOP;
    }

    _onMotion(slot, event) {
        const press = this._press;
        if (press?.slot !== slot)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        if (!press.dragging) {
            if (Math.hypot(x - press.x, y - press.y) < DRAG_THRESHOLD)
                return Clutter.EVENT_STOP;
            press.dragging = true;
            this._grid.set_child_above_sibling(slot, null);
            slot.set_pivot_point(0.5, 0.5);
            slot.add_style_class_name('dragging');
            springTo(slot, {scale_x: 1.05, scale_y: 1.05}, {preset: 'snappy'});
        }

        const [, gx, gy] = this._grid.transform_stage_point(x, y);

        // Swap places with the widget under the pointer
        const target = this._visibleSlots().find(other => {
            if (other === slot)
                return false;
            const r = this._rectOf(other);
            return gx >= r.x && gx < r.x + r.width && gy >= r.y && gy < r.y + r.height;
        });
        if (target && target !== press.last) {
            // Taking the target's index puts the slot after it when moving
            // forward and before it when moving back
            this._animateChange(() => {
                const to = this._order.indexOf(target);
                this._order.splice(this._order.indexOf(slot), 1);
                this._order.splice(to, 0, slot);
            }, {except: slot});
        }
        press.last = target ?? null;

        // Follow the pointer from wherever the layout puts it now
        const rect = this._rectOf(slot);
        stopSpring(slot, ['translation_x', 'translation_y']);
        slot.set({
            translation_x: gx - press.offsetX - rect.x,
            translation_y: gy - press.offsetY - rect.y,
        });
        return Clutter.EVENT_STOP;
    }

    _onRelease(slot, event) {
        const press = this._press;
        if (press?.slot !== slot || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag({reset: false});
        if (press.dragging) {
            slot.remove_style_class_name('dragging');
            springTo(slot, {translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1}, {preset: 'bouncy'});
            this._save();
        } else {
            this._cycleSize(slot);
        }
        return Clutter.EVENT_STOP;
    }

    // `reset`: put a dragged widget straight back (the drag was interrupted)
    _endDrag({reset = true} = {}) {
        this._grab?.dismiss();
        this._grab = null;
        const slot = this._press?.slot;
        this._press = null;
        if (reset && slot && this._order.includes(slot)) {
            stopSpring(slot);
            slot.remove_style_class_name('dragging');
            slot.set({translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1});
        }
    }
});
