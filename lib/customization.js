import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {animateResize, fadeIn, flipFrom, popIn, popOut, rectIn, slideIn} from './animation.js';
import {addPressFeedback, springTo, stopSpring} from './spring.js';
import {TileLayout, UNITS, addSecondaryMenu} from './tiles.js';
import {
    CATEGORIES, EXTRA_TOGGLES, REMOVED_REASON as REMOVED, gridToggles, toggleCategory, toggleIcon,
    toggleId,
} from './toggles.js';

const EDITING = 'gn-editing';
const A11Y_MENU = 'gn-a11y-menu';

const DIMMED_OPACITY = 110;

// Tiles of the current section: two units per Quick Settings column
const CELL_COLUMNS = 2 * UNITS;
const CELL_SPACING = 8;
const CELL_ROW_SPACING = 4;
const DRAG_THRESHOLD = 8;

// Puts tiles of `spans` units into rows of CELL_COLUMNS, in order
function placeCells(spans) {
    let col = 0, row = 0;
    return spans.map(span => {
        if (col + span > CELL_COLUMNS) {
            col = 0;
            row++;
        }
        const cell = {col, row, span};
        col += span;
        return cell;
    });
}

function cellRect({col, row, span}, width, rowHeight) {
    const unit = (width - (CELL_COLUMNS - 1) * CELL_SPACING) / CELL_COLUMNS;
    return {
        x: col * (unit + CELL_SPACING),
        y: row * (rowHeight + CELL_ROW_SPACING),
        width: span * unit + (span - 1) * CELL_SPACING,
        height: rowHeight,
    };
}

// Lays children out at the cells in their `_gnCell`, like the Quick Settings
// grid does with small and large tiles
const CellLayout = GObject.registerClass(
class GnCellLayout extends Clutter.LayoutManager {
    _cells(container) {
        return container.get_children().filter(c => c._gnCell);
    }

    rowHeight(container) {
        return Math.max(0, ...this._cells(container).map(c => c.get_preferred_height(-1)[1]));
    }

    vfunc_get_preferred_width(container, _forHeight) {
        const unit = Math.max(0, ...this._cells(container).map(c =>
            c.get_preferred_width(-1)[1] / c._gnCell.span));
        return [0, CELL_COLUMNS * unit + (CELL_COLUMNS - 1) * CELL_SPACING];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        const cells = this._cells(container);
        if (cells.length === 0)
            return [0, 0];
        const rows = Math.max(...cells.map(c => c._gnCell.row)) + 1;
        const height = rows * this.rowHeight(container) + (rows - 1) * CELL_ROW_SPACING;
        return [height, height];
    }

    vfunc_allocate(container, box) {
        const width = box.get_width();
        const rowHeight = this.rowHeight(container);
        const rtl = container.text_direction === Clutter.TextDirection.RTL;
        for (const child of this._cells(container)) {
            const r = cellRect(child._gnCell, width, rowHeight);
            const x = box.x1 + (rtl ? width - r.x - r.width : r.x);
            const y = box.y1 + r.y;
            child.allocate(Clutter.ActorBox.new(x, y, x + r.width, y + r.height));
        }
    }
});

// "Quick Settings Customization" mockup: an edit button in the system row
// swaps the menu for an editor where toggles are removed from the top section
// or added from a categorized catalog.
export class Customization {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        const qs = Main.panel.statusArea.quickSettings;
        this._qs = qs;
        this._menu = qs.menu;
        this._grid = qs.menu._grid;

        this._extras = [];
        for (const info of EXTRA_TOGGLES) {
            let item = null;
            try {
                item = info.create();
            } catch (e) {
                logError(e, `GNOME Next: Failed to create toggle ${info.id}`);
            }
            if (!item)
                continue;
            item._gnExtraId = info.id;
            item._gnCategory = info.category;
            item.connectObject('notify::visible', () => this._queueEditorRefresh(), this);
            this._extras.push(item);
        }

        this._tiles = new TileLayout(this._grid, this._lock);
        this._tiles.enable();
        this._secondaryMenus = new Map();

        const systemItem = qs._system._systemItem;
        this._editButton = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            icon_name: 'document-edit-symbolic',
            accessible_name: _('Edit Quick Settings'),
        });
        this._editButton.connect('clicked', () => this._startEditing());
        addPressFeedback(this._editButton, {scale: 0.88});
        systemItem.child.insert_child_above(this._editButton, systemItem._laptopSpacer);

        this._grid.connectObject('child-added', (_grid, child) => {
            if (!this._extras.includes(child))
                this._queueSync();
        }, this);

        this._settings.connectObject(
            'changed::removed-toggles', () => this._sync(),
            'changed::added-toggles', () => this._sync(),
            'changed::toggle-order', () => this._sync(),
            'changed::small-toggles', () => this._sync(),
            'changed::hide-accessibility-menu', () => this._syncA11yMenu(),
            this);

        this._menu.connectObject('menu-closed', () => this._onMenuClosed(), this);
        this._removeLockListener = this._lock.addListener(() => this._queueEditorRefresh());

        this._sync();
        this._syncA11yMenu();
    }

    disable() {
        if (this._editor) {
            this._menu.close(PopupAnimation.NONE);
            this._leaveEditor();
        }

        this._laterIds?.forEach(id => global.compositor.get_laters().remove(id));
        this._laterIds = null;

        this._removeLockListener();
        this._menu.disconnectObject(this);
        this._grid.disconnectObject(this);
        this._settings.disconnectObject(this);

        this._secondaryMenus.forEach(undo => undo());
        this._secondaryMenus = null;
        this._tiles.disable();
        this._tiles = null;

        this._lock.releaseAll(REMOVED);
        this._lock.release(Main.panel.statusArea.a11y, A11Y_MENU);

        this._extras.forEach(item => item.destroy());
        this._extras = [];

        this._editButton.destroy();
        this._editButton = null;
    }

    _later(key, callback) {
        this._laterIds ??= new Map();
        if (this._laterIds.has(key))
            return;

        const laters = global.compositor.get_laters();
        this._laterIds.set(key, laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterIds.delete(key);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    // Toggles from other extensions or late indicators get their column span
    // after `child-added`, so look at them right before the next redraw
    _queueSync() {
        this._later('sync', () => this._sync());
    }

    _queueEditorRefresh() {
        if (!this._editor)
            return;
        this._later('refresh', () => {
            // Moves and resizes are shown in place as they happen; rebuilding
            // the editor for them would only cost a frame
            if (this._editorSignature() !== this._shownSignature)
                animateResize(this._menu.box, () => this._populateEditor());
        });
    }

    // What the editor shows: each toggle, whether it is available, in Quick
    // Settings and small, in grid order
    _editorSignature() {
        const flag = value => (value ? 1 : 0);
        return [...gridToggles(this._grid), ...this._extras.filter(e => e.get_parent() !== this._grid)]
            .map(i => `${toggleId(this._grid, i)}:${flag(this._lock.isWanted(i))}${flag(this._isActive(i))}${flag(i._gnSmall)}`)
            .join(',');
    }

    _syncA11yMenu() {
        const a11y = Main.panel.statusArea.a11y;
        if (!a11y)
            return;

        if (this._settings.get_boolean('hide-accessibility-menu'))
            this._lock.hide(a11y, A11Y_MENU);
        else
            this._lock.release(a11y, A11Y_MENU);
    }

    _extrasSibling() {
        const last = this._qs._backgroundApps?.quickSettingsItems?.at(-1);
        return last?.get_parent() === this._grid ? last : null;
    }

    _sync() {
        const removed = new Set(this._settings.get_strv('removed-toggles'));
        const added = this._settings.get_strv('added-toggles');

        for (const item of gridToggles(this._grid)) {
            if (item._gnExtraId)
                continue;
            if (removed.has(toggleId(this._grid, item)))
                this._lock.hide(item, REMOVED);
            else
                this._lock.release(item, REMOVED);
        }

        const wanted = added
            .map(id => this._extras.find(e => e._gnExtraId === id))
            .filter(Boolean);

        // Re-insert extras so their order follows the setting
        for (const item of this._extras) {
            if (item.get_parent() === this._grid)
                this._grid.remove_child(item);
        }
        for (const item of wanted) {
            const sibling = this._extrasSibling();
            if (sibling)
                this._menu.insertItemBefore(item, sibling, 1);
            else
                this._menu.addItem(item, 1);
        }

        // Ids of repeated toggles depend on their order, so take them first
        const ids = new Map(gridToggles(this._grid).map(t => [t, toggleId(this._grid, t)]));
        const idOf = item => ids.get(item);
        this._tiles.syncOrder(this._settings.get_strv('toggle-order'), idOf);
        this._tiles.syncSizes(this._settings.get_strv('small-toggles'), idOf);

        for (const item of ids.keys()) {
            if (!this._secondaryMenus.has(item)) {
                this._secondaryMenus.set(item, addSecondaryMenu(item));
                item.connectObject('destroy', () => this._secondaryMenus?.delete(item), this);
            }
        }

        this._queueEditorRefresh();
    }

    _isActive(item) {
        if (item._gnExtraId)
            return this._settings.get_strv('added-toggles').includes(item._gnExtraId);
        return !this._settings.get_strv('removed-toggles').includes(toggleId(this._grid, item));
    }

    _add(item) {
        // New tiles go last, as on Android
        const id = toggleId(this._grid, item);
        const order = this._settings.get_strv('toggle-order');
        if (order.length > 0)
            this._settings.set_strv('toggle-order', [...order.filter(o => o !== id), id]);

        if (item._gnExtraId) {
            const added = this._settings.get_strv('added-toggles');
            if (!added.includes(item._gnExtraId))
                this._settings.set_strv('added-toggles', [...added, item._gnExtraId]);
        } else {
            const id = toggleId(this._grid, item);
            const removed = this._settings.get_strv('removed-toggles');
            this._settings.set_strv('removed-toggles', removed.filter(r => r !== id));
        }
    }

    _remove(item) {
        if (item._gnExtraId) {
            const added = this._settings.get_strv('added-toggles');
            this._settings.set_strv('added-toggles', added.filter(a => a !== item._gnExtraId));
        } else {
            const id = toggleId(this._grid, item);
            const removed = this._settings.get_strv('removed-toggles');
            if (!removed.includes(id))
                this._settings.set_strv('removed-toggles', [...removed, id]);
        }
    }

    // The editor replaces the menu contents in place, resizing smoothly
    _startEditing() {
        if (this._editor)
            return;
        this._menu._activeMenu?.close(PopupAnimation.NONE);
        animateResize(this._menu.box, () => this._enterEditor());
        fadeIn(this._editor);

        // The current toggles pop in one by one, the catalog rises after them
        const current = this._current.grid;
        const rest = this._editorContent.get_children().filter(c => c !== current);
        popIn(current.get_children(), {stagger: 14, from: 0.88});
        slideIn(rest, {distance: -16, duration: 320, stagger: 60, delay: 80});
    }

    _stopEditing() {
        if (!this._editor || this._leaving)
            return;
        this._leaving = true;

        // Fade the editor away first, then let the menu settle back
        const editor = this._editor;
        editor.set_pivot_point(0.5, 0);
        editor.ease({
            opacity: 0,
            scale_x: 0.97,
            scale_y: 0.97,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                this._leaving = false;
                if (this._editor !== editor)
                    return;
                const restored = [...this._menu.box].filter(c => this._lock.has(c, EDITING));
                animateResize(this._menu.box, () => this._leaveEditor());
                slideIn(restored, {distance: 10, stagger: 40, duration: 260});
            },
        });
    }

    _onMenuClosed() {
        if (this._editor)
            this._leaveEditor();
    }

    _enterEditor() {
        const [, gridWidth] = this._grid.get_preferred_width(-1);

        for (const child of this._menu.box) {
            if (child.visible)
                this._lock.hide(child, EDITING);
        }

        this._editor = new St.BoxLayout({
            style_class: 'gn-editor',
            orientation: Clutter.Orientation.VERTICAL,
            width: gridWidth,
        });

        const header = new St.Widget({
            style_class: 'gn-editor-header',
            layout_manager: new Clutter.BinLayout(),
        });
        header.add_child(new St.Label({
            style_class: 'gn-editor-title',
            text: _('Quick Settings'),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const closeButton = new St.Button({
            style_class: 'button gn-editor-close',
            icon_name: 'window-close-symbolic',
            accessible_name: _('Done'),
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        closeButton.connect('clicked', () => this._stopEditing());
        addPressFeedback(closeButton, {scale: 0.85});
        header.add_child(closeButton);
        this._editor.add_child(header);

        this._editorContent = new St.BoxLayout({
            style_class: 'gn-editor-content',
            orientation: Clutter.Orientation.VERTICAL,
        });
        // No visible scrollbar: it would clip the badges at the right edge;
        // the fade at the edges shows there is more
        this._editorScroll = new St.ScrollView({
            style_class: 'gn-editor-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            overlay_scrollbars: true,
            child: this._editorContent,
        });
        this._editor.add_child(this._editorScroll);

        const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const maxHeight = Math.max(200, Math.floor(workArea.height / scaleFactor) - 160);
        this._editorScroll.style = `max-height: ${maxHeight}px;`;

        this._menu.box.add_child(this._editor);
        this._populateEditor();
    }

    _leaveEditor() {
        this._endDrag();
        this._current = null;
        this._editor.destroy();
        this._editor = null;
        this._editorContent = null;
        this._editorScroll = null;
        this._lock.releaseAll(EDITING);
    }

    _populateEditor() {
        if (!this._editor)
            return;

        const scroll = this._editorScroll;
        const scrollValue = scroll.vadjustment.value;

        // Remember where everything was so it can glide to its new place
        const oldRects = new Map();
        for (const actor of this._flipActors())
            oldRects.set(actor._gnKey, rectIn(actor, this._editorContent));

        this._editorContent.destroy_all_children();
        this._popTiles = [];

        const available = item => this._lock.isWanted(item);
        const toggles = gridToggles(this._grid);

        const current = toggles.filter(i => available(i) && this._isActive(i));
        if (current.length > 0) {
            const hint = new St.Label({
                style_class: 'gn-editor-hint',
                text: _('Drag to move, click to resize'),
            });
            hint._gnKey = 'hint';
            this._editorContent.add_child(hint);
        }
        this._editorContent.add_child(this._makeCurrentGrid(current));
        if (current.length === 0) {
            this._editorContent.add_child(new St.Label({
                style_class: 'gn-editor-empty',
                text: _('Add quick settings from the list below'),
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const catalog = new St.BoxLayout({
            style_class: 'quick-toggle-menu gn-editor-catalog',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const candidates = [
            ...toggles.filter(i => !i._gnExtraId && available(i)),
            ...this._extras.filter(available),
        ];
        for (const category of CATEGORIES) {
            const items = candidates.filter(i => toggleCategory(i) === category.id);
            if (items.length === 0)
                continue;

            const header = new St.Label({
                style_class: 'gn-editor-category',
                text: category.title(),
            });
            header._gnKey = `category:${category.id}`;
            catalog.add_child(header);
            catalog.add_child(this._makeGrid(items.map(i =>
                this._makeTile(i, this._isActive(i) ? 'dimmed' : 'add', 'catalog'))));
        }
        catalog._gnKey = 'catalog';
        this._editorContent.add_child(catalog);

        for (const actor of this._flipActors()) {
            if (!this._popTiles.includes(actor))
                flipFrom(actor, oldRects.get(actor._gnKey), this._editorContent);
        }

        popIn(this._popTiles, {from: 0.8});
        this._justChanged = null;
        this._shownSignature = this._editorSignature();

        // The editor may be gone (menu closed) by the time this runs
        this._later('scroll', () => {
            if (this._editorScroll === scroll)
                scroll.vadjustment.value = scrollValue;
        });
    }

    _flipActors() {
        if (!this._editorContent)
            return [];
        const actors = [];
        const walk = actor => {
            for (const child of actor) {
                if (child._gnKey)
                    actors.push(child);
                if (child._gnKey !== undefined && child._gnKey !== 'catalog')
                    continue;
                walk(child);
            }
        };
        walk(this._editorContent);
        return actors;
    }

    _makeGrid(tiles) {
        const layout = new Clutter.GridLayout({
            column_homogeneous: true,
            column_spacing: 12,
            row_spacing: 4,
        });
        const grid = new St.Widget({
            style_class: 'gn-editor-grid',
            layout_manager: layout,
        });
        tiles.forEach((tile, i) => layout.attach(tile, i % 2, Math.floor(i / 2), 1, 1));
        return grid;
    }

    // The toggles in Quick Settings, small and large, in their order
    _makeCurrentGrid(items) {
        this._endDrag();
        const grid = new St.Widget({
            style_class: 'gn-editor-grid gn-editor-current',
            layout_manager: new CellLayout(),
            x_expand: true,
        });
        this._current = {grid, items: [...items], tiles: new Map()};
        for (const item of items) {
            const tile = this._makeTile(item, 'remove', 'current');
            this._current.tiles.set(item, tile);
            grid.add_child(tile);
        }
        this._placeCurrent();
        return grid;
    }

    _placeCurrent() {
        const {items, tiles, grid} = this._current;
        const cells = placeCells(items.map(i => (i._gnSmall ? 1 : UNITS)));
        items.forEach((item, i) => (tiles.get(item)._gnCell = cells[i]));
        grid.queue_relayout();
    }

    // Where a tile of the current section is (or goes), in grid coordinates
    _cellRect(tile) {
        const {grid} = this._current;
        const width = grid.get_allocation_box().get_width();
        const r = cellRect(tile._gnCell, width, grid.layout_manager.rowHeight(grid));
        if (grid.text_direction === Clutter.TextDirection.RTL)
            return {...r, x: width - r.x - r.width};
        return r;
    }

    _toggleSize(item) {
        const id = toggleId(this._grid, item);
        const small = this._settings.get_strv('small-toggles').filter(s => s !== id);
        if (!item._gnSmall)
            small.push(id);
        this._settings.set_strv('small-toggles', small);

        // Swap just this tile and let the others glide to their new places
        if (!this._current?.tiles.has(item))
            return;
        const {grid, items, tiles} = this._current;
        const before = new Map(items.map(i => [i, this._cellRect(tiles.get(i))]));
        const old = tiles.get(item);
        this._popTiles = [];
        const tile = this._makeTile(item, 'remove', 'current');
        grid.replace_child(old, tile);
        old.destroy();
        tiles.set(item, tile);
        animateResize(this._menu.box, () => this._placeCurrent());
        this._glideCurrent(before, tile);
        // It takes its new size at once: fading it in while the neighbours
        // make room keeps it from looking stacked on them
        tile.set_pivot_point(0.5, 0.5);
        tile.set({scale_x: 0.9, scale_y: 0.9, opacity: 0});
        tile.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        springTo(tile, {scale_x: 1, scale_y: 1}, {preset: 'bouncy'});
        this._shownSignature = this._editorSignature();
    }

    // Tiles of the current section glide from `before` (their rects then)
    // to where the layout puts them now, except `except`
    _glideCurrent(before, except = null) {
        const {items, tiles} = this._current;
        for (const item of items) {
            const actor = tiles.get(item);
            const was = before.get(item);
            if (actor === except || !was)
                continue;
            const now = this._cellRect(actor);
            if (was.x === now.x && was.y === now.y)
                continue;
            stopSpring(actor, ['translation_x', 'translation_y']);
            actor.set({
                translation_x: actor.translation_x + was.x - now.x,
                translation_y: actor.translation_y + was.y - now.y,
            });
            springTo(actor, {translation_x: 0, translation_y: 0}, {preset: 'smooth'});
        }
    }

    _onTilePress(tile, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._press)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const [, gx, gy] = this._current.grid.transform_stage_point(x, y);
        const rect = this._cellRect(tile);
        this._press = {tile, x, y, offsetX: gx - rect.x, offsetY: gy - rect.y, dragging: false, last: null};
        this._grab = global.stage.grab(tile._gnPill);
        springTo(tile, {scale_x: 0.95, scale_y: 0.95}, {preset: 'snappy'});
        return Clutter.EVENT_STOP;
    }

    _onTileMotion(tile, event) {
        const press = this._press;
        if (press?.tile !== tile)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const {grid, items, tiles} = this._current;
        if (!press.dragging) {
            if (Math.hypot(x - press.x, y - press.y) < DRAG_THRESHOLD)
                return Clutter.EVENT_STOP;
            press.dragging = true;
            grid.set_child_above_sibling(tile, null);
            tile.add_style_class_name('dragging');
            springTo(tile, {scale_x: 1.06, scale_y: 1.06}, {preset: 'snappy'});
        }

        const [, gx, gy] = grid.transform_stage_point(x, y);

        // Take the place of the tile under the pointer; the others make room
        const target = items.map(i => tiles.get(i)).find(other => {
            if (other === tile)
                return false;
            const r = this._cellRect(other);
            return gx >= r.x && gx < r.x + r.width && gy >= r.y && gy < r.y + r.height;
        });
        if (target && target !== press.last) {
            const before = new Map(items.map(i => [i, this._cellRect(tiles.get(i))]));
            const item = items.find(i => tiles.get(i) === tile);
            const to = items.findIndex(i => tiles.get(i) === target);
            items.splice(items.indexOf(item), 1);
            items.splice(to, 0, item);
            this._placeCurrent();
            this._glideCurrent(before, tile);
        }
        press.last = target ?? null;

        // Follow the pointer from wherever the layout puts the tile now
        const rect = this._cellRect(tile);
        stopSpring(tile, ['translation_x', 'translation_y']);
        tile.set({
            translation_x: gx - press.offsetX - rect.x,
            translation_y: gy - press.offsetY - rect.y,
        });
        return Clutter.EVENT_STOP;
    }

    _onTileRelease(tile, event) {
        const press = this._press;
        if (press?.tile !== tile || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag({reset: false});
        tile.remove_style_class_name('dragging');
        springTo(tile, {translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1}, {preset: 'bouncy'});

        const item = this._current.items.find(i => this._current.tiles.get(i) === tile);
        if (press.dragging) {
            this._saveOrder();
            this._shownSignature = this._editorSignature();
        } else
            this._toggleSize(item);
        return Clutter.EVENT_STOP;
    }

    // `reset`: put a dragged tile straight back (the drag was interrupted)
    _endDrag({reset = true} = {}) {
        this._grab?.dismiss();
        this._grab = null;
        const tile = this._press?.tile;
        this._press = null;
        if (reset && tile) {
            stopSpring(tile);
            tile.remove_style_class_name('dragging');
            tile.set({translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1});
        }
    }

    // The order of the current section, with the removed toggles after it
    _saveOrder() {
        const current = this._current.items.map(i => toggleId(this._grid, i));
        const rest = gridToggles(this._grid)
            .map(i => toggleId(this._grid, i))
            .filter(id => !current.includes(id));
        this._settings.set_strv('toggle-order', [...current, ...rest]);
    }

    _makeTile(item, mode, section) {
        const interactive = mode !== 'dimmed';

        const tile = new St.Widget({
            style_class: 'gn-tile-wrapper',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        tile._gnKey = `${section}:${toggleId(this._grid, item)}`;

        const box = new St.BoxLayout({x_expand: true});
        box.add_child(new St.Icon({
            style_class: 'quick-toggle-icon',
            gicon: (toggleIcon(item) ?? item).gicon,
            fallback_icon_name: 'application-x-addon-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const label = new St.Label({
            style_class: 'quick-toggle-title gn-tile-label',
            text: item.title ?? '',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END,
        });
        box.add_child(label);

        if (section === 'current')
            return this._makeCurrentTile(tile, box, label, item);

        const pill = new St.Button({
            style_class: 'quick-toggle button gn-tile',
            child: box,
            x_expand: true,
            y_expand: true,
            reactive: interactive,
            can_focus: interactive,
            accessible_name: mode === 'remove'
                ? _('Remove %s').format(item.title)
                : _('Add %s').format(item.title),
        });
        tile.add_child(pill);
        if (item === this._justChanged)
            this._popTiles.push(tile);

        if (!interactive) {
            tile.opacity = DIMMED_OPACITY;
            return tile;
        }

        const action = () => {
            this._justChanged = item;
            popOut(tile, () => (mode === 'add' ? this._add(item) : this._remove(item)));
        };
        pill.connect('clicked', action);

        const badge = new St.Button({
            style_class: `button gn-tile-badge ${mode}`,
            icon_name: mode === 'add' ? 'list-add-symbolic' : 'list-remove-symbolic',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        badge.connect('clicked', action);
        tile.add_child(badge);
        addPressFeedback(tile, {buttons: [pill, badge]});

        return tile;
    }

    // A tile in Quick Settings: drag to move, click to resize, − to remove
    _makeCurrentTile(tile, box, label, item) {
        const small = !!item._gnSmall;
        label.visible = !small;
        if (small)
            box.get_first_child().set({x_expand: true, x_align: Clutter.ActorAlign.CENTER});

        const pill = new St.Widget({
            style_class: `quick-toggle button gn-tile${small ? ' gn-small' : ''}`,
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
            y_expand: true,
            accessible_role: Atk.Role.PUSH_BUTTON,
            accessible_name: small
                ? _('Make %s larger').format(item.title)
                : _('Make %s smaller').format(item.title),
        });
        pill.add_child(box);
        pill.connect('button-press-event', (_a, event) => this._onTilePress(tile, event));
        pill.connect('motion-event', (_a, event) => this._onTileMotion(tile, event));
        pill.connect('button-release-event', (_a, event) => this._onTileRelease(tile, event));
        pill.connect('key-press-event', (_a, event) => {
            const key = event.get_key_symbol();
            if (![Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space].includes(key))
                return Clutter.EVENT_PROPAGATE;
            this._toggleSize(item);
            return Clutter.EVENT_STOP;
        });
        tile._gnPill = pill;
        tile.add_child(pill);
        if (item === this._justChanged)
            this._popTiles.push(tile);

        const badge = new St.Button({
            style_class: 'button gn-tile-badge remove',
            icon_name: 'list-remove-symbolic',
            accessible_name: _('Remove %s').format(item.title),
            can_focus: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        badge.connect('clicked', () => {
            this._justChanged = item;
            popOut(tile, () => this._remove(item));
        });
        addPressFeedback(badge, {scale: 0.85});
        tile.add_child(badge);
        return tile;
    }
}
