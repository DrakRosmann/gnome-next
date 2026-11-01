import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

const LINE_CAP_ROUND = 1;

function setColor(cr, color, alpha = 1) {
    cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255,
        alpha * color.alpha / 255);
}

// A progress ring; the filled part uses the foreground color (the accent
// color in the stylesheet), the track a faint version of it
export const Ring = GObject.registerClass(
class GnRing extends St.DrawingArea {
    constructor(params = {}) {
        super({style_class: 'gn-ring', ...params});
        this._value = 0;
    }

    set value(value) {
        value = Math.clamp(value, 0, 1);
        if (value === this._value)
            return;
        this._value = value;
        this.queue_repaint();
    }

    get value() {
        return this._value;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const node = this.get_theme_node();
        const color = node.get_foreground_color();
        const [hasWidth, ringWidth] = node.lookup_length('-gn-ring-width', false);
        const thickness = hasWidth ? ringWidth : Math.max(3, Math.min(width, height) * 0.12);
        const radius = Math.min(width, height) / 2 - thickness / 2;

        cr.translate(width / 2, height / 2);
        cr.setLineWidth(thickness);
        cr.setLineCap(LINE_CAP_ROUND);

        setColor(cr, color, 0.18);
        cr.arc(0, 0, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (this._value > 0.005) {
            setColor(cr, color);
            const start = -Math.PI / 2;
            cr.arc(0, 0, radius, start, start + this._value * 2 * Math.PI);
            cr.stroke();
        }
        cr.$dispose();
    }
});

// A filled clock face: light during the day, dark at night
export const ClockFace = GObject.registerClass(
class GnClockFace extends St.DrawingArea {
    constructor(params = {}) {
        super({style_class: 'gn-clock-face', ...params});
        this._hours = 0;
        this._minutes = 0;
    }

    setTime(hours, minutes) {
        if (hours === this._hours && minutes === this._minutes)
            return;
        this._hours = hours;
        this._minutes = minutes;
        this.queue_repaint();
    }

    get night() {
        return this._hours < 6 || this._hours >= 18;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const radius = Math.min(width, height) / 2;
        const night = this.night;
        const face = night ? [0.11, 0.11, 0.12] : [0.96, 0.96, 0.95];
        const ink = night ? [1, 1, 1] : [0.1, 0.1, 0.1];
        const ink_ = alpha => cr.setSourceRGBA(...ink, alpha);

        cr.translate(width / 2, height / 2);
        cr.setLineCap(LINE_CAP_ROUND);

        cr.setSourceRGBA(...face, 1);
        cr.arc(0, 0, radius, 0, 2 * Math.PI);
        cr.fill();
        ink_(0.12);
        cr.setLineWidth(1);
        cr.arc(0, 0, radius - 0.5, 0, 2 * Math.PI);
        cr.stroke();

        // Hour marks
        const line = Math.max(1, radius / 22);
        for (let i = 0; i < 12; i++) {
            const angle = i * Math.PI / 6;
            const outer = radius * 0.86;
            const inner = outer - radius * (i % 3 === 0 ? 0.16 : 0.09);
            cr.setLineWidth(i % 3 === 0 ? line * 1.6 : line);
            ink_(i % 3 === 0 ? 0.8 : 0.4);
            cr.moveTo(Math.sin(angle) * inner, -Math.cos(angle) * inner);
            cr.lineTo(Math.sin(angle) * outer, -Math.cos(angle) * outer);
            cr.stroke();
        }

        const hand = (angle, length, lineWidth) => {
            cr.setLineWidth(lineWidth);
            cr.moveTo(-Math.sin(angle) * radius * 0.08, Math.cos(angle) * radius * 0.08);
            cr.lineTo(Math.sin(angle) * length, -Math.cos(angle) * length);
            cr.stroke();
        };
        ink_(1);
        hand(((this._hours % 12) + this._minutes / 60) * Math.PI / 6, radius * 0.5, line * 2.6);
        hand(this._minutes * Math.PI / 30, radius * 0.74, line * 1.8);

        // Center pin in the accent orange used by clock apps
        cr.setSourceRGBA(0.96, 0.47, 0, 1);
        cr.arc(0, 0, line * 2.2, 0, 2 * Math.PI);
        cr.fill();

        cr.$dispose();
    }
});

// A ring with something (an icon or a label) in the middle
export function ringWith(ring, center) {
    const bin = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    bin.add_child(ring);
    center.set({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
    bin.add_child(center);
    return bin;
}

// A small line chart of recent values in [0, 1]
export const Sparkline = GObject.registerClass(
class GnSparkline extends St.DrawingArea {
    constructor(params = {}) {
        super({style_class: 'gn-sparkline', ...params});
        this._values = [];
        this._capacity = 40;
    }

    // Shows exactly `values`, scaled between their minimum and maximum
    setValues(values) {
        const min = Math.min(...values);
        const span = Math.max(...values) - min;
        this._values = values.map(v => (span > 0 ? (v - min) / span : 0.5));
        this._capacity = Math.max(2, values.length);
        this.queue_repaint();
    }

    push(value) {
        this._values.push(Math.clamp(value, 0, 1));
        if (this._values.length > this._capacity)
            this._values.shift();
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const color = this.get_theme_node().get_foreground_color();
        const values = this._values;
        if (values.length < 2) {
            cr.$dispose();
            return;
        }

        const step = width / (this._capacity - 1);
        const x0 = width - (values.length - 1) * step;
        const y = v => height - 1 - v * (height - 2);

        cr.moveTo(x0, height);
        values.forEach((v, i) => cr.lineTo(x0 + i * step, y(v)));
        cr.lineTo(width, height);
        cr.closePath();
        setColor(cr, color, 0.2);
        cr.fill();

        values.forEach((v, i) => (i === 0 ? cr.moveTo(x0, y(v)) : cr.lineTo(x0 + i * step, y(v))));
        setColor(cr, color);
        cr.setLineWidth(1.5);
        cr.stroke();
        cr.$dispose();
    }
});
