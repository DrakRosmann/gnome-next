import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';

import {springTo} from './spring.js';

export const RESIZE_TIME = 260;
export const FADE_TIME = 200;
export const POP_TIME = 220;

const RESIZE_MODE = Clutter.AnimationMode.EASE_OUT_CUBIC;

// Runs `change` and eases the actor from its current size to the size it
// wants afterwards. Works when called again mid-animation: it starts from
// whatever size is currently on screen.
export function animateResize(actor, change, {width = false, duration = RESIZE_TIME} = {}) {
    if (!actor.mapped || actor._gnResizing) {
        change();
        return;
    }

    const [oldWidth, oldHeight] = actor.get_size();
    actor.remove_transition('width');
    actor.remove_transition('height');
    actor.set_size(-1, -1);

    actor._gnResizing = true;
    try {
        change();
    } finally {
        actor._gnResizing = false;
    }

    const [, newWidth] = width ? actor.get_preferred_width(-1) : [0, oldWidth];
    const [, newHeight] = actor.get_preferred_height(newWidth);
    if (Math.abs(newHeight - oldHeight) < 1 && Math.abs(newWidth - oldWidth) < 1)
        return;

    const clip = actor.clip_to_allocation;
    actor.clip_to_allocation = true;
    if (width)
        actor.width = oldWidth;
    actor.height = oldHeight;

    actor.ease({
        ...width ? {width: newWidth} : {},
        height: newHeight,
        duration,
        mode: RESIZE_MODE,
        onStopped: () => {
            actor.set_size(-1, -1);
            actor.clip_to_allocation = clip;
        },
    });
}

export function fadeIn(actor, {delay = 0, duration = FADE_TIME} = {}) {
    actor.remove_transition('opacity');
    actor.opacity = 0;
    actor.ease({
        opacity: 255,
        delay,
        duration,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
}

// Scale and fade actors in one after another
export function popIn(actors, {stagger = 18, from = 0.7, duration = POP_TIME} = {}) {
    actors.forEach((actor, i) => {
        actor.pivot_point = new Graphene.Point({x: 0.5, y: 0.5});
        actor.set({opacity: 0, scale_x: from, scale_y: from});
        actor.ease({
            opacity: 255,
            delay: i * stagger,
            duration: duration * 0.6,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        springTo(actor, {scale_x: 1, scale_y: 1}, {preset: 'bouncy', delay: i * stagger});
    });
}

// Slide actors down into place one after another
export function slideIn(actors, {stagger = 30, distance = 12, duration = POP_TIME, delay = 0} = {}) {
    actors.forEach((actor, i) => {
        actor.set({opacity: 0, translation_y: -distance});
        actor.ease({
            opacity: 255,
            translation_y: 0,
            delay: delay + i * stagger,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    });
}

export function popOut(actor, onDone, {duration = 140} = {}) {
    if (!actor.mapped) {
        onDone();
        return;
    }
    actor.pivot_point = new Graphene.Point({x: 0.5, y: 0.5});
    actor.reactive = false;
    actor.ease({
        opacity: 0,
        scale_x: 0.85,
        scale_y: 0.85,
        duration,
        mode: Clutter.AnimationMode.EASE_IN_QUAD,
        onStopped: onDone,
    });
}

// Position and size of `actor` as currently drawn, in `reference` coordinates
export function rectIn(actor, reference) {
    const origin = actor.apply_relative_transform_to_point(reference,
        new Graphene.Point3D({x: 0, y: 0, z: 0}));
    const [width, height] = actor.get_size();
    return {x: origin.x, y: origin.y, width, height};
}

// FLIP: once `actor` gets its next allocation, start it at `oldRect` (taken
// with rectIn() before the layout changed) and glide it to its new place
export function flipFrom(actor, oldRect, reference, {delay = 0} = {}) {
    if (!oldRect)
        return;

    const id = actor.connect('notify::allocation', () => {
        actor.disconnect(id);
        const now = rectIn(actor, reference);
        const dx = oldRect.x - (now.x - actor.translation_x);
        const dy = oldRect.y - (now.y - actor.translation_y);
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1)
            return;

        actor.set({translation_x: dx, translation_y: dy});
        springTo(actor, {translation_x: 0, translation_y: 0}, {preset: 'smooth', delay});
    });
}

// Slide an actor in from one side, e.g. after paging
export function slideFrom(actor, direction, {distance = 24, duration = 240} = {}) {
    actor.remove_transition('translation-x');
    actor.remove_transition('opacity');
    actor.set({translation_x: direction * distance, opacity: 0});
    actor.ease({
        translation_x: 0,
        opacity: 255,
        duration,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
    });
}
