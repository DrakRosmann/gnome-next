import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {springTo, stopSpring} from './spring.js';

export const MORPH_TIME = 420;
const STAGGER = 14;
// A touch of overshoot so the toggles settle into place
const MORPH_SPRING = {stiffness: 230, dampingRatio: 0.78};

// Turns toggles into circles and back. While the real widgets are hidden (or
// transparent), a "ghost" per toggle (a plain pill with the toggle's icon and
// title) is eased from the old rectangle to the new one above the menu.
export class ToggleMorph {
    constructor(host) {
        this._host = host;
        this._layer = null;
        this._finish = null;
    }

    get running() {
        return this._layer !== null;
    }

    // Each item: {toggle, from, to, iconFrom, iconTo, title} with rects in
    // host coordinates (icons relative to their pill)
    run(items, {toCircle, onDone}) {
        this.cancel();
        if (items.length === 0) {
            onDone?.();
            return;
        }

        this._layer = new Clutter.Actor();
        this._host.add_child(this._layer);
        this._finish = onDone;

        const layer = this._layer;
        let pending = items.length;
        const done = () => {
            if (this._layer === layer && --pending === 0)
                this.cancel();
        };

        items.forEach((item, i) => this._animate(item, toCircle, i, done));
    }

    cancel() {
        const finish = this._finish;
        const layer = this._layer;
        this._finish = null;
        this._layer = null;
        layer?.get_children().forEach(ghost => {
            stopSpring(ghost);
            ghost.get_children().forEach(c => stopSpring(c));
        });
        layer?.destroy();
        finish?.();
    }

    _animate({toggle, from, to, iconFrom, iconTo, title, arrow}, toCircle, index, done) {
        const delay = index * STAGGER;
        const ghost = new St.Widget({
            style_class: 'quick-toggle button gn-morph-ghost',
            clip_to_allocation: true,
            x: from.x,
            y: from.y,
            width: from.width,
            height: from.height,
        });
        if (toggle.checked)
            ghost.add_style_pseudo_class('checked');
        this._layer.add_child(ghost);

        // The menu arrow half of toggles like Wi-Fi: it goes first when
        // shrinking and comes back last when growing
        if (arrow) {
            const part = new St.Widget({
                style_class: 'gn-morph-arrow',
                x: arrow.x,
                y: 0,
                width: arrow.width,
                height: arrow.height,
                opacity: toCircle ? 255 : 0,
            });
            if (toggle.checked)
                part.add_style_pseudo_class('checked');
            part.add_child(new St.Icon({
                icon_name: 'go-next-symbolic',
                style_class: 'gn-morph-arrow-icon',
                x: Math.round(arrow.width / 2 - 8),
                y: Math.round(arrow.height / 2 - 8),
            }));
            ghost.add_child(part);
            part.ease({
                opacity: toCircle ? 0 : 255,
                delay: toCircle ? 0 : delay + MORPH_TIME * 0.55,
                duration: MORPH_TIME * (toCircle ? 0.25 : 0.4),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        const icon = new St.Icon({
            style_class: 'quick-toggle-icon',
            gicon: iconFrom.gicon,
        });
        ghost.add_child(icon);
        const [, iconWidth] = icon.get_preferred_width(-1);
        const [, iconHeight] = icon.get_preferred_height(-1);
        const at = ({cx, cy}) => ({
            x: Math.round(cx - iconWidth / 2),
            y: Math.round(cy - iconHeight / 2),
        });
        icon.set(at(iconFrom));

        if (title) {
            const label = new St.Label({
                style_class: 'quick-toggle-title',
                text: title.text,
                x: title.x,
                y: title.y,
                opacity: toCircle ? 255 : 0,
            });
            ghost.add_child(label);
            label.ease({
                opacity: toCircle ? 0 : 255,
                delay: toCircle ? 0 : delay + MORPH_TIME * 0.4,
                duration: MORPH_TIME * (toCircle ? 0.3 : 0.5),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        springTo(icon, at(iconTo), {preset: MORPH_SPRING, delay});
        springTo(ghost, {x: to.x, y: to.y, width: to.width, height: to.height}, {
            preset: MORPH_SPRING,
            delay,
            onDone: done,
        });
    }
}
