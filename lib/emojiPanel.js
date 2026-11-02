import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const COLUMNS = 8;
const MAX_RESULTS = 120;
const MAX_RECENT = 24;

// GTK's emoji groups (see tools/emoji-data.py), with the icons the Adwaita
// theme has for them
const GROUPS = [
    {id: 'recent', icon: 'emoji-recent-symbolic', title: () => _('Recent')},
    {id: 0, icon: 'emoji-people-symbolic', title: () => _('Smileys')},
    {id: 1, icon: 'emoji-body-symbolic', title: () => _('People')},
    {id: 3, icon: 'emoji-nature-symbolic', title: () => _('Animals & Nature')},
    {id: 4, icon: 'emoji-food-symbolic', title: () => _('Food & Drink')},
    {id: 5, icon: 'emoji-travel-symbolic', title: () => _('Travel & Places')},
    {id: 6, icon: 'emoji-activities-symbolic', title: () => _('Activities')},
    {id: 7, icon: 'emoji-objects-symbolic', title: () => _('Objects')},
    {id: 8, icon: 'emoji-symbols-symbolic', title: () => _('Symbols')},
    {id: 9, icon: 'emoji-flags-symbolic', title: () => _('Flags')},
];

// [emoji, group, name, search text], read once when the panel first opens
let emojiData = null;
function loadEmoji() {
    if (emojiData)
        return emojiData;
    try {
        const file = Gio.File.new_for_uri(GLib.Uri.resolve_relative(import.meta.url, 'emoji.json', GLib.UriFlags.NONE));
        const [, contents] = file.load_contents(null);
        emojiData = JSON.parse(new TextDecoder().decode(contents));
    } catch (e) {
        logError(e, 'GNOME Next: Failed to read the emoji list');
        emojiData = [];
    }
    return emojiData;
}

// Lower case without accents, as the search text is
export function fold(text) {
    return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// The emoji panel of the clipboard popup, as Win+. on Windows: categories
// (recent first), a grid, and a search in Portuguese or English. Emits
// 'emoji-picked' with the emoji chosen; the arrows move through the grid.
export const EmojiPanel = GObject.registerClass({
    Signals: {'emoji-picked': {param_types: [GObject.TYPE_STRING]}},
}, class GnEmojiPanel extends St.BoxLayout {
    constructor(settings) {
        super({
            style_class: 'gn-emoji-panel',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._settings = settings;
        this._query = '';
        this._items = [];
        this._selected = 0;

        this._groupBar = new St.BoxLayout({style_class: 'gn-emoji-groups', x_expand: true});
        this._groupButtons = new Map();
        for (const group of GROUPS) {
            const button = new St.Button({
                style_class: 'button gn-emoji-group',
                icon_name: group.icon,
                accessible_name: group.title(),
                toggle_mode: true,
                x_expand: true,
            });
            button.connect('clicked', () => this.showGroup(group.id));
            this._groupBar.add_child(button);
            this._groupButtons.set(group.id, button);
        }
        this.add_child(this._groupBar);

        this._title = new St.Label({style_class: 'gn-emoji-title'});
        this.add_child(this._title);

        // A viewport, as a scroll view wants something it can scroll
        this._grid = new St.Viewport({
            style_class: 'gn-emoji-grid',
            layout_manager: new Clutter.GridLayout({column_homogeneous: true}),
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'gn-emoji-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._grid,
        });
        this.add_child(this._scroll);
        this._empty = new St.Label({style_class: 'gn-clip-popup-empty', x_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._empty);

        this.showGroup(this._recent().length > 0 ? 'recent' : 0);
    }

    _recent() {
        return this._settings.get_strv('recent-emoji');
    }

    showGroup(id) {
        this._group = id;
        this._query = '';
        this._groupButtons.forEach((button, key) => (button.checked = key === id));
        const group = GROUPS.find(g => g.id === id);
        this._title.text = group.title();
        if (id === 'recent') {
            const names = new Map(loadEmoji().map(e => [e[0], e[2]]));
            this._items = this._recent().map(e => [e, 'recent', names.get(e) ?? '']);
        } else {
            this._items = loadEmoji().filter(e => e[1] === id);
        }
        this._render(_('Emoji you use show up here'));
    }

    setQuery(text) {
        const query = fold(text.trim());
        if (query === this._query)
            return;
        this._query = query;
        if (!query) {
            this.showGroup(this._group);
            return;
        }
        this._groupButtons.forEach(button => (button.checked = false));
        this._title.text = _('Results');
        const words = query.split(/\s+/);
        this._items = loadEmoji().filter(e => words.every(w => e[3].includes(w))).slice(0, MAX_RESULTS);
        this._render(_('No emoji found'));
    }

    _render(emptyText) {
        this._selected = 0;
        this._grid.destroy_all_children();
        const layout = this._grid.layout_manager;
        this._items.forEach(([emoji, , name], i) => {
            const button = new St.Button({
                style_class: 'button gn-emoji',
                label: emoji,
                accessible_name: name,
                can_focus: false,
            });
            button.connect('clicked', () => this._pick(emoji));
            button.connect('notify::hover', () => {
                if (button.hover)
                    this._select(i, {scroll: false});
            });
            layout.attach(button, i % COLUMNS, Math.floor(i / COLUMNS), 1, 1);
        });
        // A short first row keeps its columns, instead of spreading out
        for (let i = this._items.length; i < COLUMNS; i++)
            layout.attach(new St.Widget({style_class: 'gn-emoji-spacer'}), i, 0, 1, 1);
        this._scroll.vadjustment.value = 0;
        this._empty.text = emptyText;
        this._empty.visible = this._items.length === 0;
        this._scroll.visible = this._items.length > 0;
        this._select(0, {scroll: false});
    }

    _select(index, {scroll = true} = {}) {
        const buttons = this._grid.get_children().filter(c => c instanceof St.Button);
        buttons[this._selected]?.remove_style_pseudo_class('selected');
        this._selected = Math.clamp(index, 0, Math.max(0, buttons.length - 1));
        const button = buttons[this._selected];
        if (!button)
            return;
        button.add_style_pseudo_class('selected');
        if (scroll && button.has_allocation()) {
            const box = button.get_allocation_box();
            const adjustment = this._scroll.vadjustment;
            if (box.y1 < adjustment.value)
                adjustment.value = box.y1;
            else if (box.y2 > adjustment.value + adjustment.page_size)
                adjustment.value = box.y2 - adjustment.page_size;
        }
    }

    // Keys from the popup: the arrows move, Enter picks, Tab goes to the
    // next category. Returns whether it took the key.
    handleKey(key, shift) {
        switch (key) {
        case Clutter.KEY_Left:
            this._select(this._selected - 1);
            return true;
        case Clutter.KEY_Right:
            this._select(this._selected + 1);
            return true;
        case Clutter.KEY_Up:
            this._select(this._selected - COLUMNS);
            return true;
        case Clutter.KEY_Down:
            this._select(Math.min(this._selected + COLUMNS, this._items.length - 1));
            return true;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            if (this._items[this._selected])
                this._pick(this._items[this._selected][0]);
            return true;
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab: {
            if (this._query)
                return true;
            const ids = GROUPS.map(g => g.id);
            const step = shift || key === Clutter.KEY_ISO_Left_Tab ? -1 : 1;
            this.showGroup(ids[(ids.indexOf(this._group) + step + ids.length) % ids.length]);
            return true;
        }
        default:
            return false;
        }
    }

    _pick(emoji) {
        const recent = [emoji, ...this._recent().filter(e => e !== emoji)].slice(0, MAX_RECENT);
        this._settings.set_strv('recent-emoji', recent);
        this.emit('emoji-picked', emoji);
    }
});
