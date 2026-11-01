import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {popIn} from '../animation.js';
import {addPressFeedback} from '../spring.js';
import {SIZE_LABELS, sizeTitle, spanSize} from './board.js';
import {WIDGETS} from './registry.js';

const DIMMED_OPACITY = 110;

// One widget in the gallery: name, description, size choice and a live
// preview that adds the widget when clicked
const Entry = GObject.registerClass(
class GnGalleryEntry extends St.BoxLayout {
    constructor(info, board) {
        super({
            style_class: 'gn-gallery-entry',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._info = info;
        this._board = board;
        this._size = info.sizes.includes('medium') ? 'medium' : info.sizes[0];

        const header = new St.BoxLayout({style_class: 'gn-gallery-entry-header'});
        header.add_child(new St.Icon({icon_name: info.icon, style_class: 'gn-gallery-entry-icon'}));
        const title = new St.Label({
            style_class: 'gn-gallery-entry-title',
            text: info.title(),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(title);
        this._added = new St.Label({
            style_class: 'gn-gallery-added',
            text: _('Added'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._added);
        this.add_child(header);

        const description = new St.Label({style_class: 'gn-gallery-entry-description', text: info.description()});
        description.clutter_text.set({line_wrap: true, ellipsize: Pango.EllipsizeMode.NONE});
        this.add_child(description);

        this._chips = new St.BoxLayout({style_class: 'gn-size-chips'});
        for (const size of info.sizes) {
            const chip = new St.Button({
                style_class: 'button gn-size-chip',
                label: SIZE_LABELS[size](),
                accessible_name: sizeTitle(size),
                can_focus: true,
                toggle_mode: false,
            });
            chip._gnSize = size;
            chip.connect('clicked', () => this._setSize(size));
            this._chips.add_child(chip);
        }
        this._chips.visible = info.sizes.length > 1;
        this.add_child(this._chips);

        this._holder = new St.Widget({
            style_class: 'gn-gallery-preview',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.START,
        });
        this.add_child(this._holder);

        this._setSize(this._size, false);
    }

    _setSize(size, animate = true) {
        this._size = size;
        this._chips.get_children().forEach(c => (c.checked = c._gnSize === size));

        this._holder.destroy_all_children();
        const [width, height] = spanSize(size, this._board.cell);
        this._holder.set_size(width, height);

        const preview = new this._info.Widget(size, this._board.widgetContext);
        this._holder.add_child(preview);

        this._shield = new St.Widget({reactive: true, x_expand: true, y_expand: true});
        this._shield.connect('button-release-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._add();
            return Clutter.EVENT_STOP;
        });
        this._holder.add_child(this._shield);

        this._badge = new St.Button({
            style_class: 'button gn-widget-badge add',
            icon_name: 'list-add-symbolic',
            accessible_name: _('Add %s').format(this._info.title()),
            can_focus: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._badge.connect('clicked', () => this._add());
        addPressFeedback(this._badge, {scale: 0.85});
        this._holder.add_child(this._badge);

        if (animate)
            popIn([preview], {from: 0.9});
        this.sync();
    }

    _add() {
        if (this._board.has(this._info.id))
            return;
        this._board.add(this._info, this._size);
    }

    sync() {
        const added = this._board.has(this._info.id);
        this._added.visible = added;
        this._holder.opacity = added ? DIMMED_OPACITY : 255;
        this._shield.reactive = !added;
        this._badge.visible = !added;
    }
});

export const WidgetGallery = GObject.registerClass(
class GnWidgetGallery extends St.BoxLayout {
    constructor(board) {
        super({
            style_class: 'gn-gallery',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        this.add_child(new St.Label({style_class: 'gn-gallery-title', text: _('Widgets')}));
        const subtitle = new St.Label({
            style_class: 'gn-gallery-subtitle',
            text: _('Pick a size and click a widget to add it'),
        });
        subtitle.clutter_text.set({line_wrap: true, ellipsize: Pango.EllipsizeMode.NONE});
        this.add_child(subtitle);

        const list = new St.BoxLayout({
            style_class: 'gn-gallery-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'gn-gallery-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            // A scrollbar would take width from the grid (and the scroll view
            // measures for that narrower width); the fade shows there is more
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: list,
        });
        this.add_child(this._scroll);

        this._entries = WIDGETS.map(info => new Entry(info, board));
        this._entries.forEach(e => list.add_child(e));

        board.connectObject('changed', () => this._entries.forEach(e => e.sync()), this);
        this.connect('destroy', () => board.disconnectObject(this));
    }

    setMaxHeight(height) {
        this._scroll.style = `max-height: ${Math.max(0, Math.floor(height))}px;`;
    }
});
