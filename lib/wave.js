import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

const WAVELENGTH = 22; // px
const AMPLITUDE = 3; // px
const SPEED = 24; // px per second the wave travels
const LINE_WIDTH = 3;
const HANDLE_HEIGHT = 14;
// How fast the amplitude follows playing/paused (per second)
const AMPLITUDE_RATE = 6;

// Media progress drawn like Android's: the played part is a wave that moves
// while playing and flattens when paused, the rest a thin line, and a small
// upright handle between them. `wavy` false keeps it a straight bar.
//
// Colors come from the theme: `color` for the played part and the handle,
// `-gn-track-color` for the rest.
export const WaveProgress = GObject.registerClass(
class GnWaveProgress extends St.DrawingArea {
    constructor(params = {}) {
        super({style_class: 'gn-wave-progress', x_expand: true, ...params});
        this._position = 0; // px
        this._playing = false;
        this._wavy = false;
        this._amplitude = 0;
        this._phase = 0;
        this._lastFrame = 0;

        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        this.connect('notify::mapped', () => this._syncTimeline());
        this.connect('destroy', () => this._timeline.stop());
    }

    // Where the played part ends, in px from the start
    set position(position) {
        if (Math.abs(position - this._position) < 0.1)
            return;
        this._position = position;
        this.queue_repaint();
    }

    setState({playing, wavy}) {
        this._playing = playing;
        this._wavy = wavy;
        this._syncTimeline();
        this.queue_repaint();
    }

    get _targetAmplitude() {
        return this._wavy && this._playing ? AMPLITUDE : 0;
    }

    _syncTimeline() {
        const run = this.mapped && (this._targetAmplitude > 0 || this._amplitude > 0);
        if (run && !this._timeline.is_playing()) {
            this._lastFrame = 0;
            this._timeline.start();
        } else if (!run && this._timeline.is_playing()) {
            this._timeline.stop();
        }
        if (!this.mapped)
            this._amplitude = this._targetAmplitude;
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        const dt = this._lastFrame ? Math.min(0.1, (now - this._lastFrame) / 1e6) : 0;
        this._lastFrame = now;

        if (this._playing)
            this._phase = (this._phase + SPEED * dt) % WAVELENGTH;
        const target = this._targetAmplitude;
        this._amplitude += (target - this._amplitude) * Math.min(1, AMPLITUDE_RATE * dt);
        if (Math.abs(target - this._amplitude) < 0.05)
            this._amplitude = target;

        this.queue_repaint();
        this._syncTimeline();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const node = this.get_theme_node();
        const played = node.get_foreground_color();
        const [hasTrack, trackColor] = node.lookup_color('-gn-track-color', false);
        const track = hasTrack ? trackColor : played;
        const setColor = (color, alpha = 1) =>
            cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255 * alpha);

        const mid = height / 2;
        const rtl = this.text_direction === Clutter.TextDirection.RTL;
        const x = position => (rtl ? width - position : position);
        const end = Math.clamp(this._position, 0, width);
        const gap = 4;

        cr.setLineCap(1); // Cairo.LineCap.ROUND
        cr.setLineWidth(LINE_WIDTH);

        // The rest: a straight line after the handle
        if (end + gap < width - LINE_WIDTH / 2) {
            setColor(track, hasTrack ? 1 : 0.3);
            cr.moveTo(x(end + gap), mid);
            cr.lineTo(x(width - LINE_WIDTH / 2), mid);
            cr.stroke();
        }

        // The played part: a wave that fades into a line near the handle
        if (end - gap > LINE_WIDTH / 2) {
            setColor(played);
            const stop = end - gap;
            cr.moveTo(x(LINE_WIDTH / 2), mid);
            for (let p = LINE_WIDTH / 2; p <= stop; p += 1) {
                const taper = Math.min(1, (stop - p) / WAVELENGTH);
                const y = mid + this._amplitude * taper *
                    Math.sin((p - this._phase) / WAVELENGTH * 2 * Math.PI);
                cr.lineTo(x(p), y);
            }
            cr.stroke();
        }

        // The handle
        if (this._position > 0) {
            setColor(played);
            cr.setLineWidth(LINE_WIDTH + 1);
            cr.moveTo(x(end), mid - HANDLE_HEIGHT / 2);
            cr.lineTo(x(end), mid + HANDLE_HEIGHT / 2);
            cr.stroke();
        }
        cr.$dispose();
    }
});
