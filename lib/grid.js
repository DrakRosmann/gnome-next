import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

// Layout units per Quick Settings column: a small tile takes one, a regular
// one the whole column
export const UNITS = 2;

// Row height when no toggle tells it, in logical pixels
const FALLBACK_ROW_HEIGHT = 56;

// Places items of {w, h} units in a grid `columns` units wide, in order, each
// at the first free place from the top: smaller items fill the holes next to
// taller ones, as on iOS and One UI. Returns {col, row, w, h} per item.
export function pack(sizes, columns) {
    const taken = [];
    const isFree = (row, col, w, h) => {
        for (let y = row; y < row + h; y++) {
            for (let x = col; x < col + w; x++) {
                if (taken[y]?.[x])
                    return false;
            }
        }
        return true;
    };

    return sizes.map(size => {
        const w = Math.clamp(size.w, 1, columns);
        const h = Math.max(1, size.h);
        for (let row = 0; ; row++) {
            for (let col = 0; col + w <= columns; col++) {
                if (!isFree(row, col, w, h))
                    continue;
                for (let y = row; y < row + h; y++) {
                    taken[y] ??= [];
                    for (let x = col; x < col + w; x++)
                        taken[y][x] = true;
                }
                return {col, row, w, h};
            }
        }
    });
}

// Heights of the rows of `cells` (from pack()): each row is as tall as its
// one-row items want, `fallback` when it only has taller ones, and items
// spanning rows spread whatever more they need over them
export function rowHeights(cells, heights, spacing, fallback) {
    const count = Math.max(0, ...cells.map(c => c.row + c.h));
    const rows = new Array(count).fill(0);
    cells.forEach((c, i) => {
        if (c.h === 1)
            rows[c.row] = Math.max(rows[c.row], heights[i]);
    });
    for (let r = 0; r < count; r++) {
        if (rows[r] === 0)
            rows[r] = fallback;
    }
    cells.forEach((c, i) => {
        if (c.h === 1)
            return;
        let span = (c.h - 1) * spacing;
        for (let r = c.row; r < c.row + c.h; r++)
            span += rows[r];
        const extra = (heights[i] - span) / c.h;
        if (extra > 0) {
            for (let r = c.row; r < c.row + c.h; r++)
                rows[r] += extra;
        }
    });
    return rows;
}

let GridLayout = null;

// A Quick Settings layout where items take {w, h} units instead of a number
// of columns, so tiles can be small and sliders tall. `sizeOf(child)` gives
// an item's {w, h, custom}; `custom` sizes do not count for the width of the
// menu. Everything else (column spans, nColumns, the menu overlay) works as
// in the shell's layout, which other extensions rely on.
function gridLayoutClass(Base) {
    GridLayout ??= GObject.registerClass({
        GTypeName: 'GnQuickSettingsGridLayout',
    }, class GnQuickSettingsGridLayout extends Base {
        _gnColumns() {
            return this.nColumns * UNITS;
        }

        _gnSize(container, child) {
            const span = Math.clamp(this.get_child_meta(container, child).columnSpan, 1, this.nColumns);
            return this._gnSizeOf?.(child, span * UNITS) ?? {w: span * UNITS, h: 1, custom: false};
        }

        _gnPlace(container, natural) {
            const children = [...container].filter(c => c.visible && c !== this._overlay);
            const sizes = children.map(c => this._gnSize(container, c));
            const cells = pack(sizes, this._gnColumns());
            const heights = children.map(c => c.get_preferred_height(-1)[natural ? 1 : 0]);

            // Rows of only tall items are as tall as the toggles
            let unit = 0;
            children.forEach((c, i) => {
                if (sizes[i].w <= UNITS && sizes[i].h === 1 && c.has_style_class_name('quick-toggle'))
                    unit = Math.max(unit, heights[i]);
            });
            if (unit === 0)
                unit = FALLBACK_ROW_HEIGHT * St.ThemeContext.get_for_stage(global.stage).scaleFactor;

            const rows = rowHeights(cells, heights, this.row_spacing, unit);
            return {children, cells, rows};
        }

        vfunc_get_preferred_width(container, _forHeight) {
            let [minWidth, natWidth] = [0, 0];
            for (const child of container) {
                if (child === this._overlay)
                    continue;
                const {w, custom} = this._gnSize(container, child);
                if (custom)
                    continue;
                const [childMin, childNat] = child.get_preferred_width(-1);
                const columns = w / UNITS;
                minWidth = Math.max(minWidth, childMin / columns);
                natWidth = Math.max(natWidth, childNat / columns);
            }
            const spacing = (this.nColumns - 1) * this.column_spacing;
            return [this.nColumns * minWidth + spacing, this.nColumns * natWidth + spacing];
        }

        vfunc_get_preferred_height(container, forWidth) {
            const [overlayMin, overlayNat] = this._overlay.get_preferred_height(forWidth);
            const total = natural => {
                const {rows} = this._gnPlace(container, natural);
                return rows.reduce((sum, h) => sum + h, 0) + Math.max(0, rows.length - 1) * this.row_spacing;
            };
            return [total(false) + overlayMin, total(true) + overlayNat];
        }

        vfunc_allocate(container, box) {
            const {children, cells, rows} = this._gnPlace(container, true);
            const width = box.get_width();
            const [, overlayHeight] = this._overlay.get_preferred_height(width);
            this._overlay.allocate_available_size(0, 0, width, overlayHeight);

            // An open menu shows under the last row of its item
            const menuAfter = new Set();
            children.forEach((child, i) => {
                if (child.menu?.actor.visible)
                    menuAfter.add(cells[i].row + cells[i].h - 1);
            });
            const tops = [];
            let y = box.y1;
            rows.forEach((height, r) => {
                tops[r] = y;
                y += height + this.row_spacing;
                if (menuAfter.has(r))
                    y += overlayHeight;
            });

            // Edges on whole pixels, the same for every row, so tiles line up
            // with the full width items
            const columns = this._gnColumns();
            const spacing = this.column_spacing;
            const edge = col => Math.round(col * (width + spacing) / columns);
            const rtl = container.text_direction === Clutter.TextDirection.RTL;
            const childBox = new Clutter.ActorBox();
            children.forEach((child, i) => {
                const {col, row, w, h} = cells[i];
                const childWidth = edge(col + w) - edge(col) - spacing;
                const x = rtl ? box.x2 - edge(col + w) + spacing : box.x1 + edge(col);
                const last = row + h - 1;
                childBox.set_origin(Math.round(x), Math.round(tops[row]));
                childBox.set_size(childWidth,
                    Math.round(tops[last] + rows[last]) - Math.round(tops[row]));
                child.allocate(childBox);
            });
        }
    });
    return GridLayout;
}

// Puts `grid` under a GridLayout. Returns a function that gives it its own
// layout back.
export function installGridLayout(grid, sizeOf) {
    const old = grid.layout_manager;
    const spans = new Map([...grid].map(c => [c, old.get_child_meta(grid, c).columnSpan]));
    const Layout = gridLayoutClass(old.constructor);
    const layout = new Layout(old._overlay, {
        nColumns: old.nColumns,
        rowSpacing: old.rowSpacing,
        columnSpacing: old.columnSpacing,
    });
    layout._gnSizeOf = sizeOf;
    grid.layout_manager = layout;
    spans.forEach((span, child) => layout.child_set_property(grid, child, 'column-span', span));

    return () => {
        const current = new Map([...grid].map(c => [c, layout.get_child_meta(grid, c).columnSpan]));
        layout._gnSizeOf = null;
        grid.layout_manager = old;
        current.forEach((span, child) => old.child_set_property(grid, child, 'column-span', span));
        old.layout_changed();
    };
}

// Lays its one child out turned a quarter: the child gets the height of the
// box as its width, so a horizontal slider stands upright. It wants no height
// of its own and fills whatever rows the grid gives it.
export const UprightLayout = GObject.registerClass(
class GnUprightLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width(container, _forHeight) {
        const child = container.get_first_child();
        return child ? child.get_preferred_height(-1) : [0, 0];
    }

    vfunc_get_preferred_height(_container, _forWidth) {
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        const child = container.get_first_child();
        if (!child)
            return;
        const [width, height] = [box.get_width(), box.get_height()];
        const x = box.x1 + (width - height) / 2;
        const y = box.y1 + (height - width) / 2;
        child.allocate(Clutter.ActorBox.new(x, y, x + height, y + width));
    }
});
