import Clutter from 'gi://Clutter';

import {gridToggles, toggleIcon, toggleTitle} from './toggles.js';

// Visibility lock reason for the title and arrow of small tiles
const SMALL = 'gn-small';

// Layout units per Quick Settings column: a small tile takes one, a regular
// one the whole column
export const UNITS = 2;

// Android and iOS style tile sizes and order for the Quick Settings grid.
//
// The shell's grid has two columns and only knows column spans. Instead of
// changing the spans other code (and other extensions) set, the layout is told
// it has twice as many columns and reads each span doubled, except for small
// tiles, which take half a column. The width of a column stays the same.
export class TileLayout {
    constructor(grid, lock) {
        this._grid = grid;
        this._lock = lock;
        this._small = new Set();
    }

    enable() {
        const layout = this._grid.layout_manager;
        let columns = layout.nColumns;
        const spanOf = (container, child) =>
            Math.clamp(layout.get_child_meta(container, child).columnSpan, 1, columns);

        // The layout reads these through `this`, so own properties on the
        // instance take the place of the class ones
        Object.defineProperty(layout, 'nColumns', {
            configurable: true,
            get: () => columns * UNITS,
            set: value => {
                columns = value;
                layout.layout_changed();
            },
        });
        layout._getColSpan = (container, child) =>
            child._gnSmall ? 1 : spanOf(container, child) * UNITS;
        layout._getMaxChildWidth = container => {
            let [minWidth, natWidth] = [0, 0];
            for (const child of container) {
                if (child === layout._overlay || child._gnSmall)
                    continue;
                const [childMin, childNat] = child.get_preferred_width(-1);
                const span = spanOf(container, child);
                minWidth = Math.max(minWidth, childMin / span);
                natWidth = Math.max(natWidth, childNat / span);
            }
            // A column is UNITS units and the spacing between them
            const spacing = (UNITS - 1) * layout.column_spacing;
            return [
                Math.max(0, (minWidth - spacing) / UNITS),
                Math.max(0, (natWidth - spacing) / UNITS),
            ];
        };
        this._layout = layout;
        layout.layout_changed();
    }

    disable() {
        [...this._small].forEach(item => this._setSmall(item, false));
        this._lock.releaseAll(SMALL);

        const layout = this._layout;
        delete layout.nColumns;
        delete layout._getColSpan;
        delete layout._getMaxChildWidth;
        layout.layout_changed();
        this._layout = null;
    }

    // `small`: the ids of the small tiles; `idOf`: the id of a toggle
    syncSizes(small, idOf) {
        for (const item of gridToggles(this._grid))
            this._setSmall(item, small.includes(idOf(item)));
        for (const item of [...this._small]) {
            if (item.get_parent() !== this._grid)
                this._setSmall(item, false);
        }
    }

    _setSmall(item, small) {
        if (small === this._small.has(item))
            return;

        const parts = [toggleTitle(item)?.get_parent(), item._menuButton].filter(Boolean);
        const icon = toggleIcon(item);

        if (small) {
            this._small.add(item);
            parts.forEach(part => this._lock.hide(part, SMALL));
            icon?.set({x_expand: true, x_align: Clutter.ActorAlign.CENTER});
            item.add_style_class_name('gn-small');
            item.connectObject('destroy', () => this._small.delete(item), this);
        } else {
            this._small.delete(item);
            item.disconnectObject(this);
            parts.forEach(part => this._lock.release(part, SMALL));
            icon?.set({x_expand: false, x_align: Clutter.ActorAlign.FILL});
            item.remove_style_class_name('gn-small');
        }
        item._gnSmall = small;
        this._layout.layout_changed();
    }

    // Moves the toggles into `order` (ids), keeping the places the grid has
    // for toggles: sliders and other items stay where they are. Toggles that
    // are not in `order` go after the others, in their current order.
    syncOrder(order, idOf) {
        const children = [...this._grid];
        const toggles = gridToggles(this._grid);
        const rank = item => {
            const i = order.indexOf(idOf(item));
            return i < 0 ? Infinity : i;
        };
        const sorted = toggles
            .map((item, i) => ({item, i, rank: rank(item)}))
            .sort((a, b) => a.rank - b.rank || a.i - b.i)
            .map(({item}) => item);

        const wanted = [...children];
        toggles.forEach((item, k) => (wanted[children.indexOf(item)] = sorted[k]));
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
