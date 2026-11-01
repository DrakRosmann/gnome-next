import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {SPRINGS} from './spring.js';

// Settles like the `smooth` spring, without overshoot: a corner radius or a
// color going past its target reads as a glitch, not as bounce
const MORPH_SPRING = {...SPRINGS.smooth, dampingRatio: 1};
const SETTLE = 0.002;

// What St draws for `actor` right now: the corner radius (as drawn, at most
// half the shorter side) and the background color
function shapeOf(actor) {
    const node = actor.get_theme_node();
    // Before its first allocation, the size it is going to get
    const [width, height] = actor.has_allocation()
        ? actor.get_size()
        : [actor.get_preferred_width(-1)[1], actor.get_preferred_height(-1)[1]];
    const radius = Math.min(node.get_border_radius(St.Corner.TOPLEFT), width / 2, height / 2);
    const {red, green, blue, alpha} = node.get_background_color();
    return {radius, color: [red, green, blue, alpha]};
}

const mix = (a, b, t) => a + (b - a) * t;

// Morphs a button between the shapes of its checked and unchecked styles,
// e.g. the Android style small tiles, round while off and square while on.
// St on its own cross-fades between the two styles, which shows both shapes
// at once; here the corners and the color move together. Buttons whose two
// styles have the same corners are left to St. Returns a function that undoes
// it.
export function addShapeMorph(button) {
    let previous = null;
    let current = null;
    let timeline = null;
    let morphing = false;

    const remember = () => {
        if (morphing || !button.mapped)
            return;
        previous = current;
        current = shapeOf(button);
    };

    const stop = () => {
        timeline?.stop();
        timeline = null;
    };

    const morph = () => {
        // style-changed for the new state comes before notify::checked, so
        // the shape before the change is the previous one remembered
        const from = previous;
        stop();
        remember();
        const to = current;
        if (!from || !to || Math.abs(from.radius - to.radius) < 1 || !button.mapped)
            return;

        const omega = Math.sqrt(MORPH_SPRING.stiffness);
        const settle = -Math.log(SETTLE) / omega * 1000;
        const duration = adjustAnimationTime(Math.min(settle, 600));
        if (duration <= 0)
            return;

        const apply = p => {
            const color = from.color.map((c, i) => Math.round(mix(c, to.color[i], p)));
            morphing = true;
            button.style = `border-radius: ${mix(from.radius, to.radius, p).toFixed(1)}px; ` +
                `background-color: rgba(${color[0]}, ${color[1]}, ${color[2]}, ${(color[3] / 255).toFixed(3)}); ` +
                'transition-duration: 0;';
            morphing = false;
        };

        timeline = new Clutter.Timeline({actor: button, duration});
        timeline.connect('new-frame', (_t, elapsed) => {
            // Critically damped spring from 0 to 1
            const t = elapsed / duration * settle / 1000;
            apply(1 - Math.exp(-omega * t) * (1 + omega * t));
        });
        timeline.connect('stopped', () => {
            morphing = true;
            button.style = null;
            morphing = false;
        });
        apply(0);
        timeline.start();
    };

    const ids = [
        button.connect('style-changed', remember),
        button.connect('notify::mapped', () => {
            if (!button.mapped) {
                stop();
                previous = current = null;
            }
        }),
        button.connect('notify::checked', morph),
    ];
    return () => {
        stop();
        ids.forEach(id => button.disconnect(id));
    };
}
