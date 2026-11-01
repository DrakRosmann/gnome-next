import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {UNITS, UprightLayout, installGridLayout} from './grid.js';
import {addShapeMorph} from './shape.js';
import {controlKind, gridControls, toggleIcon, toggleTitle} from './toggles.js';

export {UNITS};

// Visibility lock reason for the title and arrow of small tiles
const SMALL = 'gn-small';

// The sizes each kind of control comes in, in the order a click cycles
// through them, in layout units: four across, rows as tall as a toggle
export const SIZES = {
    toggle: {
        large: {w: 2, h: 1},
        small: {w: 1, h: 1},
    },
    slider: {
        wide: {w: 4, h: 1},
        half: {w: 2, h: 1},
        tall: {w: 1, h: 2},
        tower: {w: 1, h: 3},
    },
    media: {
        large: {w: 4, h: 2},
        compact: {w: 4, h: 1},
        square: {w: 2, h: 2},
    },
};

export function defaultSize(kind) {
    return Object.keys(SIZES[kind])[0];
}

// The next size of `kind` after `size`, for a click on a tile
export function nextSize(kind, size) {
    const sizes = Object.keys(SIZES[kind]);
    return sizes[(sizes.indexOf(size) + 1) % sizes.length];
}

// "id:size" entries of the control-sizes setting, as a map
export function parseSizes(entries) {
    const sizes = new Map();
    for (const entry of entries) {
        const i = entry.lastIndexOf(':');
        if (i > 0)
            sizes.set(entry.slice(0, i), entry.slice(i + 1));
    }
    return sizes;
}

// Sizes and order for the Quick Settings grid, as on iOS and One UI: small
// and large toggles, wide, half and upright sliders, and the media player.
// The grid gets a layout that places items by units of width and rows.
export class TileLayout {
    constructor(grid, lock) {
        this._grid = grid;
        this._lock = lock;
        this._sizes = new Map();
    }

    enable() {
        this._restoreLayout = installGridLayout(this._grid, (child, span) => this._cellsOf(child, span));
    }

    disable() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        for (const item of [...this._sizes.keys()])
            this._apply(item, null);
        this._lock.releaseAll(SMALL);
        this._restoreLayout();
        this._restoreLayout = null;
    }

    // The size of `item` in the grid
    sizeOf(item) {
        const kind = controlKind(item);
        return kind ? this._sizes.get(item)?.size ?? defaultSize(kind) : null;
    }

    _cellsOf(child, span) {
        const kind = controlKind(child);
        const size = this._sizes.get(child)?.size;
        if (!kind || !size && kind !== 'media')
            return {w: span, h: 1, custom: false};
        // While notifications are expanded the player is a single row
        if (kind === 'media' && child.compact)
            return {...SIZES.media.compact, custom: true};
        const cells = SIZES[kind][size ?? defaultSize(kind)];
        return {...cells, custom: kind === 'media' || size !== defaultSize(kind)};
    }

    // `sizes`: a map of ids to sizes; `idOf`: the id of a control
    syncSizes(sizes, idOf) {
        const controls = gridControls(this._grid);
        for (const item of controls) {
            const kind = controlKind(item);
            const size = sizes.get(idOf(item));
            this._apply(item, size && size !== defaultSize(kind) && SIZES[kind][size] ? size : null);
        }
        for (const item of [...this._sizes.keys()]) {
            if (!controls.includes(item))
                this._apply(item, null);
        }
        this._grid.layout_manager.layout_changed();
    }

    // `size` null: the default size
    _apply(item, size) {
        const state = this._sizes.get(item);
        if ((state?.size ?? null) === size)
            return;

        state?.undo();
        this._sizes.delete(item);
        if (!size)
            return;

        const kind = controlKind(item);
        const undo = [];
        if (kind === 'toggle' && size === 'small')
            undo.push(this._makeSmall(item));
        if (kind === 'slider' && SIZES.slider[size].h > 1)
            undo.push(this._makeUpright(item));
        if (kind === 'media') {
            item.setSize(size);
            undo.push(() => item.setSize(null));
        }
        const id = item.connect('destroy', () => this._sizes?.delete(item));
        undo.push(() => item.disconnect(id));
        this._sizes.set(item, {size, undo: () => undo.reverse().forEach(f => f())});
    }

    _makeSmall(item) {
        const parts = [toggleTitle(item)?.get_parent(), item._menuButton].filter(Boolean);
        const icon = toggleIcon(item);

        parts.forEach(part => this._lock.hide(part, SMALL));
        icon?.set({x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        item.add_style_class_name('gn-small');
        // The part that draws the tile: the toggle inside a menu toggle
        const button = item._menuButton ? item._box.get_first_child() : item;
        const undoMorph = addShapeMorph(button);

        return () => {
            undoMorph();
            parts.forEach(part => this._lock.release(part, SMALL));
            icon?.set({x_expand: false, x_align: Clutter.ActorAlign.FILL});
            item.remove_style_class_name('gn-small');
        };
    }

    // A slider standing upright, as on One UI and iOS: its contents are laid
    // out turned a quarter, so the icon ends up at the bottom, and the icons
    // are turned back. Dragging keeps working, since the slider reads the
    // pointer through its transformation.
    _makeUpright(item) {
        const box = item.get_child();
        // St.Bin places its child itself, so the turn happens one level down
        const upright = new St.Widget({
            layout_manager: new UprightLayout(),
            x_expand: true,
            y_expand: true,
        });
        item.set_child(upright);
        upright.add_child(box);
        const rtl = item.text_direction === Clutter.TextDirection.RTL;
        const angle = rtl ? 90 : -90;
        const icons = [item._iconButton, item._menuButton].map(b => b?.get_child()).filter(Boolean);

        item.add_style_class_name('gn-upright');
        box.set_pivot_point(0.5, 0.5);
        box.rotation_angle_z = angle;
        icons.forEach(icon => {
            icon.set_pivot_point(0.5, 0.5);
            icon.rotation_angle_z = -angle;
        });

        // The bar is as thick as the slider is wide
        const sync = () => this._queueThickness();
        const id = item.connect('notify::allocation', sync);
        item._gnUpright = true;
        sync();

        return () => {
            item.disconnect(id);
            item._gnUpright = false;
            item.slider.style = null;
            icons.forEach(icon => (icon.rotation_angle_z = 0));
            box.rotation_angle_z = 0;
            item.remove_style_class_name('gn-upright');
            upright.remove_child(box);
            item.set_child(box);
            upright.destroy();
        };
    }

    // Changing the style while allocating would lay the grid out again
    _queueThickness() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
            for (const item of this._sizes.keys()) {
                if (!item._gnUpright || !item.has_allocation())
                    continue;
                const [width] = item.get_theme_node().get_content_box(item.get_allocation_box()).get_size();
                const thickness = Math.max(24, Math.floor(width / scaleFactor));
                const style = `-barlevel-height: ${thickness}px; min-height: ${thickness}px;`;
                if (item.slider.style !== style)
                    item.slider.style = style;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Moves the controls into `order` (ids), keeping the places the grid has
    // for them: the system row and other items stay where they are. Controls
    // that are not in `order` keep their place too.
    syncOrder(order, idOf) {
        const children = [...this._grid];
        const rank = item => order.indexOf(idOf(item));
        const listed = gridControls(this._grid).filter(item => rank(item) >= 0);
        const sorted = [...listed].sort((a, b) => rank(a) - rank(b));

        const wanted = [...children];
        listed.forEach((item, k) => (wanted[children.indexOf(item)] = sorted[k]));
        wanted.forEach((child, i) => {
            if (this._grid.get_child_at_index(i) !== child)
                this._grid.set_child_at_index(child, i);
        });
    }
}

// Opens a toggle's menu with the secondary button, as a long press does on
// Android. Returns a function that undoes it.
export function addSecondaryMenu(item) {
    if (!item.menu)
        return () => {};
    const id = item.connect('button-press-event', (_actor, event) => {
        if (event.get_button() !== Clutter.BUTTON_SECONDARY || !item.menuEnabled || !item.reactive)
            return Clutter.EVENT_PROPAGATE;
        item.menu.open();
        return Clutter.EVENT_STOP;
    });
    return () => item.disconnect(id);
}
