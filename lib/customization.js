import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {animateResize, fadeIn, flipFrom, popIn, popOut, rectIn, slideIn} from './animation.js';
import {pack} from './grid.js';
import {addPressFeedback, springTo, stopSpring} from './spring.js';
import {SIZES, TileLayout, UNITS, addSecondaryMenu, defaultSize, nextSize, parseSizes} from './tiles.js';
import {
    CATEGORIES, EXTRA_TOGGLES, REMOVED_REASON as REMOVED, controlGicon, controlId, controlKind,
    controlTitle, gridControls, toggleCategory,
} from './toggles.js';

const EDITING = 'gn-editing';
const A11Y_MENU = 'gn-a11y-menu';

const DIMMED_OPACITY = 110;

// Tiles of the current section: two units per Quick Settings column
const CELL_COLUMNS = 2 * UNITS;
const CELL_SPACING = 8;
const CELL_ROW_SPACING = 4;
const DRAG_THRESHOLD = 8;
// A move or resize while dragging waits this long after the last one, so
// tiles that change places under the pointer do not keep swapping
const SETTLE_TIME = 120; // ms

function unitWidth(width) {
    return (width - (CELL_COLUMNS - 1) * CELL_SPACING) / CELL_COLUMNS;
}

function cellRect({col, row, w, h}, width, rowHeight) {
    const unit = unitWidth(width);
    return {
        x: col * (unit + CELL_SPACING),
        y: row * (rowHeight + CELL_ROW_SPACING),
        width: w * unit + (w - 1) * CELL_SPACING,
        height: h * rowHeight + (h - 1) * CELL_ROW_SPACING,
    };
}

// A quarter arc hugging the bottom corner of a tile, in the theme `color`
function drawCornerHandle(area) {
    const cr = area.get_context();
    const [width, height] = area.get_surface_size();
    const {red, green, blue, alpha} = area.get_theme_node().get_foreground_color();
    const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
    const line = 3 * scaleFactor;
    const radius = Math.min(width, height) - line;
    const rtl = area.text_direction === Clutter.TextDirection.RTL;

    cr.setSourceRGBA(red / 255, green / 255, blue / 255, alpha / 255);
    cr.setLineWidth(line);
    cr.setLineCap(1); // Cairo.LineCap.ROUND
    if (rtl)
        cr.arc(line / 2 + radius, line / 2, radius, Math.PI / 2, Math.PI);
    else
        cr.arc(line / 2, line / 2, radius, 0, Math.PI / 2);
    cr.stroke();
    cr.$dispose();
}

// The first child (the fill) covers `fraction` of the box, from the start or
// from the bottom; the others the whole box. Draws the level of a slider.
const FillLayout = GObject.registerClass(
class GnFillLayout extends Clutter.BinLayout {
    constructor(fraction, upright) {
        super();
        this._fraction = Math.clamp(fraction, 0, 1);
        this._upright = upright;
    }

    vfunc_allocate(container, box) {
        super.vfunc_allocate(container, box);
        const fill = container.get_first_child();
        if (!fill)
            return;
        const [width, height] = [box.get_width(), box.get_height()];
        const fillBox = box.copy();
        if (this._upright) {
            fillBox.y1 = box.y2 - Math.max(width, height * this._fraction);
        } else {
            const length = Math.max(height, width * this._fraction);
            if (container.text_direction === Clutter.TextDirection.RTL)
                fillBox.x1 = box.x2 - length;
            else
                fillBox.x2 = box.x1 + length;
        }
        fill.allocate(fillBox);
    }
});

// Lays children out at the cells in their `_gnCell`, like the Quick Settings
// grid does with tiles, sliders and the player of every size. Rows are as
// tall as the one-row tiles.
const CellLayout = GObject.registerClass(
class GnCellLayout extends Clutter.LayoutManager {
    _cells(container) {
        return container.get_children().filter(c => c._gnCell);
    }

    rowHeight(container) {
        return Math.max(0, ...this._cells(container)
            .filter(c => c._gnCell.h === 1)
            .map(c => c.get_preferred_height(-1)[1]));
    }

    vfunc_get_preferred_width(container, _forHeight) {
        const unit = Math.max(0, ...this._cells(container).map(c =>
            (c.get_preferred_width(-1)[1] - (c._gnCell.w - 1) * CELL_SPACING) / c._gnCell.w));
        return [0, CELL_COLUMNS * unit + (CELL_COLUMNS - 1) * CELL_SPACING];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        const cells = this._cells(container);
        if (cells.length === 0)
            return [0, 0];
        const rows = Math.max(...cells.map(c => c._gnCell.row + c._gnCell.h));
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

// "Quick Settings Customization" mockup, grown into the editors of iOS and
// One UI: an edit button in the system row swaps the menu for an editor where
// every control (toggles, sliders, the player) is moved, resized and removed
// in a live grid, and added back from a categorized catalog.
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

        this._migrateSmallToggles();

        // The player joins the other controls in the grid
        this._media = this._menu._gnMedia ?? null;
        if (this._media) {
            this._media.get_parent()?.remove_child(this._media);
            const sibling = this._extrasSibling();
            if (sibling)
                this._menu.insertItemBefore(this._media, sibling, this._grid.layout_manager.nColumns);
            else
                this._menu.addItem(this._media, this._grid.layout_manager.nColumns);
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
            'changed::control-sizes', () => this._sync(),
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

        if (this._media) {
            this._grid.remove_child(this._media);
            this._media._gnHome.insert_child_at_index(this._media, 0);
            this._media = null;
        }

        this._extras.forEach(item => item.destroy());
        this._extras = [];

        this._editButton.destroy();
        this._editButton = null;
    }

    // Small tiles used to be a list of their own
    _migrateSmallToggles() {
        const small = this._settings.get_strv('small-toggles');
        if (small.length === 0)
            return;
        const sizes = this._settings.get_strv('control-sizes')
            .filter(entry => !small.some(id => entry.startsWith(`${id}:`)));
        this._settings.set_strv('control-sizes', [...sizes, ...small.map(id => `${id}:small`)]);
        this._settings.reset('small-toggles');
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

    // What the editor shows: each control, whether it is available, in Quick
    // Settings, and its size, in grid order
    _editorSignature() {
        const flag = value => (value ? 1 : 0);
        return [...gridControls(this._grid), ...this._extras.filter(e => e.get_parent() !== this._grid)]
            .map(i => `${controlId(this._grid, i)}:${flag(this._lock.isWanted(i))}${flag(this._isActive(i))}:${this._tiles.sizeOf(i)}`)
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

        for (const item of gridControls(this._grid)) {
            if (item._gnExtraId)
                continue;
            if (removed.has(controlId(this._grid, item)))
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
        const ids = new Map(gridControls(this._grid).map(c => [c, controlId(this._grid, c)]));
        const idOf = item => ids.get(item);
        this._tiles.syncOrder(this._settings.get_strv('toggle-order'), idOf);
        this._tiles.syncSizes(parseSizes(this._settings.get_strv('control-sizes')), idOf);

        for (const item of ids.keys()) {
            if (controlKind(item) === 'toggle' && !this._secondaryMenus.has(item)) {
                this._secondaryMenus.set(item, addSecondaryMenu(item));
                item.connectObject('destroy', () => this._secondaryMenus?.delete(item), this);
            }
        }

        this._queueEditorRefresh();
    }

    _isActive(item) {
        if (item._gnExtraId)
            return this._settings.get_strv('added-toggles').includes(item._gnExtraId);
        return !this._settings.get_strv('removed-toggles').includes(controlId(this._grid, item));
    }

    _add(item) {
        // New tiles go last, as on Android
        const id = controlId(this._grid, item);
        const order = this._settings.get_strv('toggle-order');
        if (order.length > 0)
            this._settings.set_strv('toggle-order', [...order.filter(o => o !== id), id]);

        if (item._gnExtraId) {
            const added = this._settings.get_strv('added-toggles');
            if (!added.includes(item._gnExtraId))
                this._settings.set_strv('added-toggles', [...added, item._gnExtraId]);
        } else {
            const removed = this._settings.get_strv('removed-toggles');
            this._settings.set_strv('removed-toggles', removed.filter(r => r !== id));
        }
    }

    _remove(item) {
        if (item._gnExtraId) {
            const added = this._settings.get_strv('added-toggles');
            this._settings.set_strv('added-toggles', added.filter(a => a !== item._gnExtraId));
        } else {
            const id = controlId(this._grid, item);
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

        // Panel settings on one side, as on One UI; reset and done on the other
        const headerButton = (iconName, accessibleName, callback) => {
            const button = new St.Button({
                style_class: 'button gn-editor-close',
                icon_name: iconName,
                accessible_name: accessibleName,
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            button.connect('clicked', callback);
            addPressFeedback(button, {scale: 0.85});
            return button;
        };
        const start = new St.BoxLayout({
            style_class: 'gn-editor-header-buttons',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        start.add_child(headerButton('emblem-system-symbolic', _('Settings'), () => this._openPreferences()));
        header.add_child(start);

        const end = new St.BoxLayout({
            style_class: 'gn-editor-header-buttons',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        this._resetButton = headerButton('edit-undo-symbolic', _('Reset Layout'), () => this._resetLayout());
        end.add_child(this._resetButton);
        end.add_child(headerButton('object-select-symbolic', _('Done'), () => this._stopEditing()));
        header.add_child(end);
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

    _openPreferences() {
        this._menu.close(PopupAnimation.FULL);
        Extension.lookupByURL(import.meta.url)?.openPreferences();
    }

    // Default order and sizes; removed controls stay removed
    _resetLayout() {
        this._settings.reset('toggle-order');
        this._settings.reset('control-sizes');
    }

    _syncResetButton() {
        if (this._resetButton) {
            this._resetButton.reactive = this._settings.get_strv('toggle-order').length > 0 ||
                this._settings.get_strv('control-sizes').length > 0;
        }
    }

    _leaveEditor() {
        this._endDrag();
        this._resetButton = null;
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
        const controls = gridControls(this._grid);

        const current = controls.filter(i => available(i) && this._isActive(i));
        if (current.length > 0) {
            const hint = new St.Label({
                style_class: 'gn-editor-hint',
                text: _('Drag to move. Click or drag the corner to resize.'),
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
            ...controls.filter(i => !i._gnExtraId && available(i)),
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
        this._syncResetButton();

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

    // The controls in Quick Settings, at their sizes, in their order
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

    _cellsOf(item) {
        const kind = controlKind(item);
        return SIZES[kind][this._tiles.sizeOf(item)];
    }

    _placeCurrent() {
        const {items, tiles, grid} = this._current;
        const cells = pack(items.map(i => this._cellsOf(i)), CELL_COLUMNS);
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

    _itemOf(tile) {
        return this._current?.items.find(i => this._current.tiles.get(i) === tile) ?? null;
    }

    _setSize(item, size) {
        const id = controlId(this._grid, item);
        const kind = controlKind(item);
        const sizes = this._settings.get_strv('control-sizes').filter(e => !e.startsWith(`${id}:`));
        if (size !== defaultSize(kind))
            sizes.push(`${id}:${size}`);
        this._settings.set_strv('control-sizes', sizes);
        this._syncResetButton();

        // Reshape just this tile; it and the others glide to their new places
        const tile = this._current?.tiles.get(item);
        if (!tile)
            return;
        const {items, tiles} = this._current;
        const before = new Map(items.map(i => [i, this._cellRect(tiles.get(i))]));
        this._fillCurrentTile(tile, item);
        animateResize(this._menu.box, () => this._placeCurrent());
        this._glideCurrent(before);
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
            if (was.x === now.x && was.y === now.y && was.width === now.width && was.height === now.height)
                continue;
            stopSpring(actor, ['translation_x', 'translation_y', 'scale_x', 'scale_y']);
            // FLIP: from the old rect, scaled, to the new one
            actor.set_pivot_point(0, 0);
            actor.set({
                translation_x: actor.translation_x + was.x - now.x,
                translation_y: actor.translation_y + was.y - now.y,
                scale_x: was.width / now.width,
                scale_y: was.height / now.height,
            });
            springTo(actor, {translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1}, {preset: 'smooth'});
        }
    }

    _onTilePress(tile, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._press)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const [, gx, gy] = this._current.grid.transform_stage_point(x, y);
        const rect = this._cellRect(tile);
        this._press = {
            tile, x, y, offsetX: gx - rect.x, offsetY: gy - rect.y,
            dragging: false, last: null, lastChange: 0,
        };
        this._grab = global.stage.grab(tile._gnPill);
        tile.set_pivot_point(0.5, 0.5);
        springTo(tile, {scale_x: 0.95, scale_y: 0.95}, {preset: 'snappy'});
        return Clutter.EVENT_STOP;
    }

    _onTileMotion(tile, event) {
        const press = this._press;
        if (press?.tile !== tile || press.resizing)
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
        const now = GLib.get_monotonic_time() / 1000;
        if (target && target !== press.last && now - press.lastChange > SETTLE_TIME) {
            const before = new Map(items.map(i => [i, this._cellRect(tiles.get(i))]));
            const item = this._itemOf(tile);
            const to = items.findIndex(i => tiles.get(i) === target);
            items.splice(items.indexOf(item), 1);
            items.splice(to, 0, item);
            this._placeCurrent();
            this._glideCurrent(before, tile);
            press.lastChange = now;
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
        if (press?.tile !== tile || press.resizing || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag({reset: false});
        tile.remove_style_class_name('dragging');
        springTo(tile, {translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1}, {preset: 'bouncy'});

        const item = this._itemOf(tile);
        if (press.dragging) {
            this._saveOrder();
            this._shownSignature = this._editorSignature();
        } else {
            this._cycleSize(item);
        }
        return Clutter.EVENT_STOP;
    }

    _cycleSize(item) {
        const kind = controlKind(item);
        this._setSize(item, nextSize(kind, this._tiles.sizeOf(item)));
    }

    // The corner handle: drag it to pick the size closest to where it is,
    // as on iOS, or click it to go to the next size
    _onHandlePress(tile, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._press)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._press = {tile, x, y, resizing: true, moved: false, lastChange: 0};
        this._grab = global.stage.grab(tile._gnHandle);
        tile._gnHandle.add_style_pseudo_class('active');
        return Clutter.EVENT_STOP;
    }

    _onHandleMotion(tile, event) {
        const press = this._press;
        if (press?.tile !== tile || !press.resizing)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        if (!press.moved && Math.hypot(x - press.x, y - press.y) < DRAG_THRESHOLD)
            return Clutter.EVENT_STOP;
        press.moved = true;

        const now = GLib.get_monotonic_time() / 1000;
        if (now - press.lastChange >= SETTLE_TIME && this._resizeTo(tile, x, y))
            press.lastChange = now;
        return Clutter.EVENT_STOP;
    }

    // Gives the tile the size closest to the pointer at `x`, `y`, measured
    // from its top start corner. A size has to be clearly closer than the
    // current one, so it does not flip back and forth on the line between
    // two. Returns whether it changed.
    _resizeTo(tile, x, y, {margin = 0.3} = {}) {
        const {grid} = this._current;
        const [, gx, gy] = grid.transform_stage_point(x, y);
        const rect = this._cellRect(tile);
        const width = grid.get_allocation_box().get_width();
        const unit = unitWidth(width);
        const rowHeight = grid.layout_manager.rowHeight(grid);
        const rtl = grid.text_direction === Clutter.TextDirection.RTL;
        const across = rtl ? rect.x + rect.width - gx : gx - rect.x;
        const wanted = {
            w: (across + CELL_SPACING / 2) / (unit + CELL_SPACING),
            h: (gy - rect.y + CELL_ROW_SPACING / 2) / (rowHeight + CELL_ROW_SPACING),
        };

        const item = this._itemOf(tile);
        const kind = controlKind(item);
        const current = this._tiles.sizeOf(item);
        const distance = ({w, h}) => Math.hypot(w - wanted.w, h - wanted.h);
        const [size, cells] = Object.entries(SIZES[kind])
            .reduce((best, entry) => (distance(entry[1]) < distance(best[1]) ? entry : best));
        if (size === current || distance(cells) > distance(SIZES[kind][current]) - margin)
            return false;
        this._setSize(item, size);
        return true;
    }

    _onHandleRelease(tile, event) {
        const press = this._press;
        if (press?.tile !== tile || !press.resizing || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        tile._gnHandle.remove_style_pseudo_class('active');
        this._endDrag({reset: false});
        if (!press.moved) {
            this._cycleSize(this._itemOf(tile));
        } else {
            const [x, y] = event.get_coords();
            this._resizeTo(tile, x, y, {margin: 0});
        }
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
            tile._gnHandle?.remove_style_pseudo_class('active');
            tile.set({translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1});
        }
    }

    // The order of the current section, with the removed controls after it
    _saveOrder() {
        const current = this._current.items.map(i => controlId(this._grid, i));
        const rest = gridControls(this._grid)
            .map(i => controlId(this._grid, i))
            .filter(id => !current.includes(id));
        this._settings.set_strv('toggle-order', [...current, ...rest]);
        this._syncResetButton();
    }

    _makeTile(item, mode, section) {
        const interactive = mode !== 'dimmed';

        const tile = new St.Widget({
            style_class: 'gn-tile-wrapper',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        tile._gnKey = `${section}:${controlId(this._grid, item)}`;
        if (item === this._justChanged)
            this._popTiles.push(tile);

        if (section === 'current')
            return this._makeCurrentTile(tile, item);

        const title = controlTitle(item);
        const box = new St.BoxLayout({x_expand: true});
        box.add_child(this._tileIcon(item));
        box.add_child(this._tileLabel(title));

        const pill = new St.Button({
            style_class: 'quick-toggle button gn-tile',
            child: box,
            x_expand: true,
            y_expand: true,
            reactive: interactive,
            can_focus: interactive,
            accessible_name: mode === 'remove'
                ? _('Remove %s').format(title)
                : _('Add %s').format(title),
        });
        tile.add_child(pill);

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

    _tileIcon(item, params = {}) {
        return new St.Icon({
            style_class: 'quick-toggle-icon',
            gicon: controlGicon(item),
            fallback_icon_name: 'application-x-addon-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
            ...params,
        });
    }

    _tileLabel(text) {
        const label = new St.Label({
            style_class: 'quick-toggle-title gn-tile-label',
            text,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END,
        });
        return label;
    }

    // A control in Quick Settings: drag to move, click or drag the corner
    // to resize, − to remove
    _makeCurrentTile(tile, item) {
        const title = controlTitle(item);
        const pill = new St.Widget({
            style_class: 'quick-toggle button gn-tile',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
            y_expand: true,
            accessible_role: Atk.Role.PUSH_BUTTON,
            accessible_name: _('Change the size of %s').format(title),
        });
        pill.connect('button-press-event', (_a, event) => this._onTilePress(tile, event));
        pill.connect('motion-event', (_a, event) => this._onTileMotion(tile, event));
        pill.connect('button-release-event', (_a, event) => this._onTileRelease(tile, event));
        pill.connect('key-press-event', (_a, event) => {
            const key = event.get_key_symbol();
            if (![Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space].includes(key))
                return Clutter.EVENT_PROPAGATE;
            this._cycleSize(item);
            return Clutter.EVENT_STOP;
        });
        tile._gnPill = pill;
        tile.add_child(pill);

        const handle = new St.DrawingArea({
            style_class: 'gn-tile-resize',
            reactive: true,
            track_hover: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
        });
        handle.connect('repaint', () => drawCornerHandle(handle));
        handle.connect('style-changed', () => handle.queue_repaint());
        handle.connect('button-press-event', (_a, event) => this._onHandlePress(tile, event));
        handle.connect('motion-event', (_a, event) => this._onHandleMotion(tile, event));
        handle.connect('button-release-event', (_a, event) => this._onHandleRelease(tile, event));
        tile._gnHandle = handle;
        tile.add_child(handle);

        const badge = new St.Button({
            style_class: 'button gn-tile-badge remove',
            icon_name: 'list-remove-symbolic',
            accessible_name: _('Remove %s').format(title),
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

        this._fillCurrentTile(tile, item);
        return tile;
    }

    // What a current tile shows for the size of its control, drawn roughly
    // as it looks in Quick Settings
    _fillCurrentTile(tile, item) {
        const pill = tile._gnPill;
        const kind = controlKind(item);
        const size = this._tiles.sizeOf(item);
        const {w, h} = SIZES[kind][size];
        const upright = h > 1 && kind === 'slider';

        pill.destroy_all_children();
        pill.style_class = `quick-toggle button gn-tile gn-${kind}-tile gn-size-${size}`;
        if (kind === 'toggle' && size === 'small')
            pill.add_style_class_name('gn-small');

        if (kind === 'slider') {
            pill.layout_manager = new FillLayout(item.slider?.value ?? 0.5, upright);
            pill.add_child(new St.Widget({style_class: 'gn-slider-tile-fill'}));
        } else {
            pill.layout_manager = new Clutter.BinLayout();
        }

        const box = new St.BoxLayout({
            style_class: 'gn-tile-box',
            x_expand: true,
            y_expand: true,
        });
        pill.add_child(box);

        if (w === 1) {
            // Small tiles and upright sliders: the icon, centered or at the
            // bottom like the slider's
            box.add_child(this._tileIcon(item, {
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: upright ? Clutter.ActorAlign.END : Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        if (kind === 'media') {
            box.orientation = Clutter.Orientation.VERTICAL;
            const row = new St.BoxLayout({style_class: 'gn-media-tile-row', x_expand: true});
            row.add_child(this._tileIcon(item));
            row.add_child(this._tileLabel(controlTitle(item)));
            box.add_child(row);
            if (h > 1) {
                const controls = new St.BoxLayout({
                    style_class: 'gn-media-tile-controls',
                    x_expand: true,
                    y_expand: true,
                    y_align: Clutter.ActorAlign.END,
                    x_align: Clutter.ActorAlign.CENTER,
                });
                for (const name of ['media-skip-backward-symbolic', 'media-playback-start-symbolic', 'media-skip-forward-symbolic'])
                    controls.add_child(new St.Icon({icon_name: name, style_class: 'gn-media-tile-icon'}));
                box.add_child(controls);
            }
            return;
        }

        box.add_child(this._tileIcon(item));
        box.add_child(this._tileLabel(controlTitle(item)));
    }
}
