import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';

// Mockup sliders: a thick pill where the filled part carries the icon and the
// menu arrow sits inside the track. The shell's slider pieces are moved into
// an overlay; their behaviour (dragging, muting, menus) is untouched.
export class PillSliders {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        this._grid = Main.panel.statusArea.quickSettings.menu._grid;
        this._restyled = new Map();

        this._grid.connectObject(
            'child-added', () => this._queueRestyle(),
            'destroy', () => (this._gridDestroyed = true),
            this);
        this._restyleAll();
    }

    disable() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;

        this._grid.disconnectObject(this);
        [...this._restyled.keys()].forEach(item => this._restore(item));
        this._restyled = null;
    }

    _queueRestyle() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            if (!this._gridDestroyed)
                this._restyleAll();
            return GLib.SOURCE_REMOVE;
        });
    }

    _restyleAll() {
        for (const child of this._grid) {
            if (child instanceof QuickSlider && !this._restyled.has(child))
                this._restyle(child);
        }
    }

    _restyle(item) {
        const icon = item._iconButton;
        const menuButton = item._menuButton;
        const sliderBin = item.slider?.get_parent();
        const box = sliderBin?.get_parent();
        if (!icon || !menuButton || !box || icon.get_parent() !== box || menuButton.get_parent() !== box)
            return;

        const state = {
            box,
            children: box.get_children(),
            icon: {x_expand: icon.x_expand, x_align: icon.x_align, y_align: icon.y_align},
        };

        const track = new St.Widget({
            style_class: 'gn-slider-track',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        [sliderBin, icon, menuButton].forEach(a => box.remove_child(a));
        track.add_child(sliderBin);
        track.add_child(icon);
        track.add_child(menuButton);
        box.insert_child_at_index(track, 0);

        sliderBin.x_expand = true;
        icon.set({
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        icon.add_style_class_name('gn-slider-icon');
        menuButton.set({x_expand: true, x_align: Clutter.ActorAlign.END});
        menuButton.add_style_class_name('gn-slider-menu');
        item.add_style_class_name('gn-pill-slider');

        state.track = track;
        state.menu = {x_expand: false, x_align: Clutter.ActorAlign.FILL};
        this._restyled.set(item, state);

        item.connectObject('destroy', () => this._restyled?.delete(item), this);
    }

    _restore(item) {
        const state = this._restyled.get(item);
        this._restyled.delete(item);
        item.disconnectObject(this);

        const {box, track, children} = state;
        const icon = item._iconButton;
        const menuButton = item._menuButton;

        track.get_children().forEach(a => track.remove_child(a));
        track.destroy();

        // Put the pieces back in their original order
        children.forEach((child, index) => {
            if (child.get_parent() !== box)
                box.insert_child_at_index(child, index);
        });

        icon.set(state.icon);
        icon.remove_style_class_name('gn-slider-icon');
        menuButton.set(state.menu);
        menuButton.remove_style_class_name('gn-slider-menu');
        item.remove_style_class_name('gn-pill-slider');
    }
}
