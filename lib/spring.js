import Clutter from 'gi://Clutter';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';

// Damped spring animations. Unlike a fixed easing curve, a spring settles
// with a short, natural deceleration (and a hint of overshoot when the
// damping ratio is below 1), which reads as "physical" motion.
//
// Presets: `smooth` for layout moves, `bouncy` for things popping into place,
// `snappy` for press feedback.
export const SPRINGS = {
    smooth: {stiffness: 260, dampingRatio: 0.9},
    bouncy: {stiffness: 320, dampingRatio: 0.68},
    snappy: {stiffness: 700, dampingRatio: 0.8},
};

const SETTLE_EPSILON = 0.002;
const MAX_DURATION = 1500;

const springs = new WeakMap();

// Position of a spring released from `from` toward 0, at time t (seconds),
// as a fraction of the starting offset
function springProgress(t, omega, zeta) {
    if (zeta < 1) {
        const omegaD = omega * Math.sqrt(1 - zeta * zeta);
        const envelope = Math.exp(-zeta * omega * t);
        return envelope * (Math.cos(omegaD * t) + (zeta * omega / omegaD) * Math.sin(omegaD * t));
    }
    // Critically damped
    return Math.exp(-omega * t) * (1 + omega * t);
}

function settleTime(omega, zeta) {
    return -Math.log(SETTLE_EPSILON) / (Math.min(zeta, 1) * omega);
}

// Stops springs on `actor` that animate any of `keys` (all of them if omitted)
export function stopSpring(actor, keys = null) {
    const running = springs.get(actor);
    if (!running)
        return;
    for (const spring of [...running]) {
        if (!keys || spring.keys.some(k => keys.includes(k))) {
            running.delete(spring);
            spring.timeline.stop();
        }
    }
}

// Animates numeric properties of `actor` to the values in `target`.
// Starting a new spring on an actor takes over from the current values.
export function springTo(actor, target, {preset = 'smooth', delay = 0, onDone} = {}) {
    const {stiffness, dampingRatio} = SPRINGS[preset] ?? preset;
    const keys = Object.keys(target);
    stopSpring(actor, keys);

    const omega = Math.sqrt(stiffness);
    const zeta = dampingRatio;
    const settle = Math.min(settleTime(omega, zeta) * 1000, MAX_DURATION);
    const duration = adjustAnimationTime(settle);
    const scale = duration > 0 ? duration / settle : 0;

    const from = Object.fromEntries(keys.map(k => [k, actor[k]]));

    if (duration <= 0 || !actor.mapped) {
        actor.set(target);
        onDone?.();
        return;
    }

    // Easings already running on these properties would fight the spring
    keys.forEach(k => actor.remove_transition(k.replaceAll('_', '-')));

    const timeline = new Clutter.Timeline({
        actor,
        duration: duration + adjustAnimationTime(delay),
        progress_mode: Clutter.AnimationMode.LINEAR,
    });
    const delayMs = adjustAnimationTime(delay);

    timeline.connect('new-frame', (_t, elapsed) => {
        const t = Math.max(0, elapsed - delayMs) / scale / 1000;
        const p = springProgress(t, omega, zeta);
        const values = {};
        for (const k of keys)
            values[k] = target[k] + (from[k] - target[k]) * p;
        actor.set(values);
    });
    const spring = {keys, timeline};
    timeline.connect('stopped', (_t, finished) => {
        springs.get(actor)?.delete(spring);
        if (finished)
            actor.set(target);
        onDone?.(finished);
    });

    if (!springs.has(actor))
        springs.set(actor, new Set());
    springs.get(actor).add(spring);
    timeline.start();
}

// Shrinks a button a little while it is held down, springing back on release
// (`buttons` are the parts that can be pressed, `target` is what shrinks)
export function addPressFeedback(target, {scale = 0.95, buttons = [target]} = {}) {
    target.set_pivot_point(0.5, 0.5);
    const ids = buttons.map(button => [button, button.connect('notify::pressed', () => {
        const s = buttons.some(b => b.pressed) ? scale : 1;
        springTo(target, {scale_x: s, scale_y: s}, {preset: 'snappy'});
    })]);
    return () => {
        ids.forEach(([button, id]) => button.disconnect(id));
        stopSpring(target, ['scale_x', 'scale_y']);
        target.set_scale(1, 1);
    };
}
