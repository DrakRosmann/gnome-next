import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {addShapeMorph} from '../shape.js';
import {addPressFeedback, bounceIcon} from '../spring.js';
import {REMOVED_REASON, activateToggle, gridToggles, toggleIcon} from '../toggles.js';
import {Widget, closeCalendar, label, placeholder, vbox} from './base.js';

// Columns and rows of buttons for each size
const GRID = {small: [2, 2], medium: [4, 2], large: [4, 5]};

// The Quick Settings toggles as round buttons, like the controls of the iOS
// Control Center. They follow the order and the choice made in the Quick
// Settings editor; clicking the card itself opens Quick Settings.
export const ControlsWidget = GObject.registerClass(
class GnControlsWidget extends Widget {
    constructor(size, {lock = null} = {}) {
        super(size, {accessible_name: _('Controls')});
        this.add_style_class_name('gn-controls-widget');
        this._lock = lock;
        this._bindings = [];

        const box = vbox({x_expand: true, y_expand: true});
        this.child = box;
        box.add_child(label('gn-widget-title', {text: _('Controls')}));

        const [columns, rows] = GRID[size];
        this._capacity = columns * rows;
        this._columns = columns;
        this._layout = new Clutter.GridLayout({
            column_homogeneous: true,
            row_homogeneous: true,
            column_spacing: 8,
            row_spacing: 8,
        });
        this._grid = new St.Widget({
            style_class: 'gn-controls-grid',
            layout_manager: this._layout,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._grid);

        this._placeholder = placeholder('emblem-system-symbolic', _('No controls'));
        box.add_child(this._placeholder);

        this._qsGrid = Main.panel.statusArea.quickSettings?.menu._grid ?? null;
        this._qsGrid?.connectObject(
            'child-added', () => this._queueRebuild(),
            'child-removed', () => this._queueRebuild(),
            this);
        // The toggles shown can change while the popover is closed
        this.connect('notify::mapped', () => {
            if (this.mapped)
                this._rebuild();
        });
        this.connect('destroy', () => {
            this._qsGrid?.disconnectObject(this);
            this._unbind();
        });
        this._rebuild();
    }

    _queueRebuild() {
        if (this.mapped)
            this._rebuild();
    }

    _toggles() {
        if (!this._qsGrid)
            return [];
        return gridToggles(this._qsGrid).filter(item => this._lock
            ? this._lock.isWanted(item) && !this._lock.has(item, REMOVED_REASON)
            : item.visible);
    }

    _unbind() {
        this._bindings.forEach(b => b.unbind());
        this._bindings = [];
    }

    _rebuild() {
        this._unbind();
        this._grid.destroy_all_children();

        const toggles = this._toggles().slice(0, this._capacity);
        toggles.forEach((item, i) => {
            const icon = new St.Icon({style_class: 'gn-circle-icon'});
            const button = new St.Button({
                style_class: 'quick-toggle button gn-circle gn-control',
                child: icon,
                can_focus: true,
                accessible_name: item.title ?? '',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const flags = GObject.BindingFlags.SYNC_CREATE;
            this._bindings.push(
                (toggleIcon(item) ?? item).bind_property('gicon', icon, 'gicon', flags),
                item.bind_property('checked', button, 'checked', flags),
                item.bind_property('reactive', button, 'reactive', flags));
            button.connect('clicked', () => activateToggle(item));
            button.connect('notify::checked', () => bounceIcon(icon));
            addShapeMorph(button);
            addPressFeedback(button, {scale: 0.88});
            this._layout.attach(button, i % this._columns, Math.floor(i / this._columns), 1, 1);
        });

        this._grid.visible = toggles.length > 0;
        this._placeholder.visible = toggles.length === 0;
        this.empty = toggles.length === 0;
    }

    activate() {
        closeCalendar();
        Main.panel.statusArea.quickSettings?.menu.open();
    }
});
