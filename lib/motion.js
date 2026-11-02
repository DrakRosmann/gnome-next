import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {rectIn} from './animation.js';
import {springTo, stopSpring} from './spring.js';

// The panel settles with a hint of overshoot, like a sheet on iOS
const OPEN_SPRING = {stiffness: 380, dampingRatio: 0.78};
// A grabbed slider springs up quickly and settles back with a little bounce
const GRAB_SPRING = {stiffness: 600, dampingRatio: 0.75};
// ms of delay per px from the corner the panel opens from, and at most
const RIPPLE_DELAY = 0.22;
const RIPPLE_MAX = 150;

function motionAllowed() {
    const settings = St.Settings.get();
    return settings.enable_animations && settings.reduced_motion !== St.ReducedMotion?.REDUCE;
}

// How Quick Settings moves, as in the iOS Control Center: the panel springs
// open out of its top bar button and the controls follow in a wave from that
// corner; it shrinks back into the button when it closes; and a slider grows
// a little while it is dragged.
export class PanelMotion {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        const qs = Main.panel.statusArea.quickSettings;
        this._button = qs;
        this._menu = qs.menu;
        this._grid = qs.menu._grid;
        this._sliders = new Set();

        this._patchPointer();
        this._menu.connectObject('open-state-changed', (_m, open) => {
            if (open)
                this._ripple();
        }, this);
        this._grid.connectObject('child-added', () => this._watchSliders(), this);
        this._watchSliders();
    }

    disable() {
        const pointer = this._menu._boxPointer;
        delete pointer.open;
        delete pointer.close;
        stopSpring(pointer);
        pointer.set({scale_x: 1, scale_y: 1, translation_y: 0});

        this._menu.disconnectObject(this);
        this._grid.disconnectObject(this);
        for (const item of this._sliders) {
            item.slider.disconnectObject(this);
            item.disconnectObject(this);
            stopSpring(item, ['scale_x', 'scale_y']);
            item.set({scale_x: 1, scale_y: 1});
        }
        this._sliders = null;
    }

    // Where the panel comes out of: its top bar button, as a pivot point
    _pivot(pointer) {
        const [bx] = this._button.get_transformed_position();
        const [bw] = this._button.get_transformed_size();
        const [px] = pointer.get_transformed_position();
        const width = pointer.width;
        const pivot = (bx + bw / 2 - px) / width;
        // Before its first layout it has no place yet: the button is at its
        // end, as the panel opens under it
        if (!Number.isFinite(pivot) || !pointer.has_allocation())
            return this._button.text_direction === Clutter.TextDirection.RTL ? 0 : 1;
        return Math.clamp(pivot, 0, 1);
    }

    _patchPointer() {
        const pointer = this._menu._boxPointer;
        const open = pointer.open.bind(pointer);
        const close = pointer.close.bind(pointer);

        pointer.open = (animate, onComplete) => {
            stopSpring(pointer);
            pointer.remove_all_transitions();
            open(PopupAnimation.NONE, onComplete);
            if (!(animate & PopupAnimation.FULL) || !motionAllowed())
                return;
            pointer.set_pivot_point(this._pivot(pointer), 0);
            pointer.set({scale_x: 0.88, scale_y: 0.88, translation_y: -10, opacity: 0});
            pointer.ease({opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            springTo(pointer, {scale_x: 1, scale_y: 1, translation_y: 0}, {preset: OPEN_SPRING});
        };

        pointer.close = (animate, onComplete) => {
            stopSpring(pointer);
            pointer.remove_all_transitions();
            const done = () => {
                close(PopupAnimation.NONE, onComplete);
                pointer.set({scale_x: 1, scale_y: 1, translation_y: 0, opacity: 255});
            };
            if (!(animate & PopupAnimation.FULL) || !pointer.mapped || !motionAllowed()) {
                done();
                return;
            }
            pointer.set_pivot_point(this._pivot(pointer), 0);
            pointer.ease({
                opacity: 0,
                scale_x: 0.92,
                scale_y: 0.92,
                translation_y: -6,
                duration: 160,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: done,
            });
        };
    }

    // The controls come in one after another, the ones nearest the button
    // first, each springing up from a little smaller
    _ripple() {
        if (!motionAllowed())
            return;
        const box = this._menu.box;
        const overlay = this._grid.layout_manager._overlay;
        const actors = [
            ...[...this._grid].filter(c => c !== overlay),
            ...[...box].filter(c => c !== this._grid),
        ].filter(a => a.visible && a.has_allocation());
        if (actors.length === 0)
            return;

        const rtl = box.text_direction === Clutter.TextDirection.RTL;
        const width = box.width;
        for (const actor of actors) {
            const rect = rectIn(actor, box);
            const dx = (rtl ? rect.x : width - rect.x - rect.width) + rect.width / 2;
            const dy = rect.y + Math.min(rect.height, 60) / 2;
            const delay = Math.min(RIPPLE_MAX, Math.hypot(dx, dy) * RIPPLE_DELAY);

            actor.remove_transition('opacity');
            stopSpring(actor, ['scale_x', 'scale_y', 'translation_y']);
            actor.set_pivot_point(0.5, 0.5);
            actor.set({opacity: 0, scale_x: 0.92, scale_y: 0.92, translation_y: -6});
            actor.ease({opacity: 255, delay, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            springTo(actor, {scale_x: 1, scale_y: 1, translation_y: 0}, {preset: 'smooth', delay});
        }
    }

    // A slider grows a little across while it is dragged, as on iOS, and
    // settles back when let go
    _watchSliders() {
        for (const item of this._grid) {
            if (!(item instanceof QuickSlider) || this._sliders.has(item) || !item.slider)
                continue;
            this._sliders.add(item);
            item.slider.connectObject(
                'drag-begin', () => this._grab(item, true),
                'drag-end', () => this._grab(item, false),
                this);
            item.connectObject('destroy', () => this._sliders?.delete(item), this);
        }
    }

    _grab(item, grabbed) {
        if (!motionAllowed())
            return;
        // Upright sliders grow in width, the others in height
        const upright = item.has_style_class_name('gn-upright');
        const target = !grabbed
            ? {scale_x: 1, scale_y: 1}
            : upright ? {scale_x: 1.08, scale_y: 1.02} : {scale_x: 1.015, scale_y: 1.1};
        item.set_pivot_point(0.5, 0.5);
        springTo(item, target, {preset: GRAB_SPRING});
    }
}
