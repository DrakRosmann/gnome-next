import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {animateResize, fadeIn, flipFrom, popIn, popOut, rectIn, slideIn} from './animation.js';
import {addPressFeedback} from './spring.js';
import {
    CATEGORIES, EXTRA_TOGGLES, REMOVED_REASON as REMOVED, gridToggles, toggleCategory, toggleIcon,
    toggleId,
} from './toggles.js';

const EDITING = 'gn-editing';
const A11Y_MENU = 'gn-a11y-menu';

const DIMMED_OPACITY = 110;

// "Quick Settings Customization" mockup: an edit button in the system row
// swaps the menu for an editor where toggles are removed from the top section
// or added from a categorized catalog.
export class Customization {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        const qs = Main.panel.statusArea.quickSettings;
        this._qs = qs;
        this._menu = qs.menu;
        this._grid = qs.menu._grid;

        this._extras = [];
        for (const info of EXTRA_TOGGLES) {
            let item = null;
            try {
                item = info.create();
            } catch (e) {
                logError(e, `GNOME Next: Failed to create toggle ${info.id}`);
            }
            if (!item)
                continue;
            item._gnExtraId = info.id;
            item._gnCategory = info.category;
            item.connectObject('notify::visible', () => this._queueEditorRefresh(), this);
            this._extras.push(item);
        }

        const systemItem = qs._system._systemItem;
        this._editButton = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            icon_name: 'document-edit-symbolic',
            accessible_name: _('Edit Quick Settings'),
        });
        this._editButton.connect('clicked', () => this._startEditing());
        addPressFeedback(this._editButton, {scale: 0.88});
        systemItem.child.insert_child_above(this._editButton, systemItem._laptopSpacer);

        this._grid.connectObject('child-added', (_grid, child) => {
            if (!this._extras.includes(child))
                this._queueSync();
        }, this);

        this._settings.connectObject(
            'changed::removed-toggles', () => this._sync(),
            'changed::added-toggles', () => this._sync(),
            'changed::hide-accessibility-menu', () => this._syncA11yMenu(),
            this);

        this._menu.connectObject('menu-closed', () => this._onMenuClosed(), this);
        this._removeLockListener = this._lock.addListener(() => this._queueEditorRefresh());

        this._sync();
        this._syncA11yMenu();
    }

    disable() {
        if (this._editor) {
            this._menu.close(PopupAnimation.NONE);
            this._leaveEditor();
        }

        this._laterIds?.forEach(id => global.compositor.get_laters().remove(id));
        this._laterIds = null;

        this._removeLockListener();
        this._menu.disconnectObject(this);
        this._grid.disconnectObject(this);
        this._settings.disconnectObject(this);

        this._lock.releaseAll(REMOVED);
        this._lock.release(Main.panel.statusArea.a11y, A11Y_MENU);

        this._extras.forEach(item => item.destroy());
        this._extras = [];

        this._editButton.destroy();
        this._editButton = null;
    }

    _later(key, callback) {
        this._laterIds ??= new Map();
        if (this._laterIds.has(key))
            return;

        const laters = global.compositor.get_laters();
        this._laterIds.set(key, laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterIds.delete(key);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    // Toggles from other extensions or late indicators get their column span
    // after `child-added`, so look at them right before the next redraw
    _queueSync() {
        this._later('sync', () => this._sync());
    }

    _queueEditorRefresh() {
        if (this._editor)
            this._later('refresh', () => animateResize(this._menu.box, () => this._populateEditor()));
    }

    _syncA11yMenu() {
        const a11y = Main.panel.statusArea.a11y;
        if (!a11y)
            return;

        if (this._settings.get_boolean('hide-accessibility-menu'))
            this._lock.hide(a11y, A11Y_MENU);
        else
            this._lock.release(a11y, A11Y_MENU);
    }

    _extrasSibling() {
        const last = this._qs._backgroundApps?.quickSettingsItems?.at(-1);
        return last?.get_parent() === this._grid ? last : null;
    }

    _sync() {
        const removed = new Set(this._settings.get_strv('removed-toggles'));
        const added = this._settings.get_strv('added-toggles');

        for (const item of gridToggles(this._grid)) {
            if (item._gnExtraId)
                continue;
            if (removed.has(toggleId(this._grid, item)))
                this._lock.hide(item, REMOVED);
            else
                this._lock.release(item, REMOVED);
        }

        const wanted = added
            .map(id => this._extras.find(e => e._gnExtraId === id))
            .filter(Boolean);

        // Re-insert extras so their order follows the setting
        for (const item of this._extras) {
            if (item.get_parent() === this._grid)
                this._grid.remove_child(item);
        }
        for (const item of wanted) {
            const sibling = this._extrasSibling();
            if (sibling)
                this._menu.insertItemBefore(item, sibling, 1);
            else
                this._menu.addItem(item, 1);
        }

        this._queueEditorRefresh();
    }

    _isActive(item) {
        if (item._gnExtraId)
            return this._settings.get_strv('added-toggles').includes(item._gnExtraId);
        return !this._settings.get_strv('removed-toggles').includes(toggleId(this._grid, item));
    }

    _add(item) {
        if (item._gnExtraId) {
            const added = this._settings.get_strv('added-toggles');
            if (!added.includes(item._gnExtraId))
                this._settings.set_strv('added-toggles', [...added, item._gnExtraId]);
        } else {
            const id = toggleId(this._grid, item);
            const removed = this._settings.get_strv('removed-toggles');
            this._settings.set_strv('removed-toggles', removed.filter(r => r !== id));
        }
    }

    _remove(item) {
        if (item._gnExtraId) {
            const added = this._settings.get_strv('added-toggles');
            this._settings.set_strv('added-toggles', added.filter(a => a !== item._gnExtraId));
        } else {
            const id = toggleId(this._grid, item);
            const removed = this._settings.get_strv('removed-toggles');
            if (!removed.includes(id))
                this._settings.set_strv('removed-toggles', [...removed, id]);
        }
    }

    // The editor replaces the menu contents in place, resizing smoothly
    _startEditing() {
        if (this._editor)
            return;
        this._menu._activeMenu?.close(PopupAnimation.NONE);
        animateResize(this._menu.box, () => this._enterEditor());
        fadeIn(this._editor);

        // The current toggles pop in one by one, the catalog rises after them
        const [current, ...rest] = this._editorContent.get_children();
        popIn(current?.get_children() ?? [], {stagger: 14, from: 0.88});
        slideIn(rest, {distance: -16, duration: 320, stagger: 60, delay: 80});
    }

    _stopEditing() {
        if (!this._editor || this._leaving)
            return;
        this._leaving = true;

        // Fade the editor away first, then let the menu settle back
        const editor = this._editor;
        editor.set_pivot_point(0.5, 0);
        editor.ease({
            opacity: 0,
            scale_x: 0.97,
            scale_y: 0.97,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                this._leaving = false;
                if (this._editor !== editor)
                    return;
                const restored = [...this._menu.box].filter(c => this._lock.has(c, EDITING));
                animateResize(this._menu.box, () => this._leaveEditor());
                slideIn(restored, {distance: 10, stagger: 40, duration: 260});
            },
        });
    }

    _onMenuClosed() {
        if (this._editor)
            this._leaveEditor();
    }

    _enterEditor() {
        const [, gridWidth] = this._grid.get_preferred_width(-1);

        for (const child of this._menu.box) {
            if (child.visible)
                this._lock.hide(child, EDITING);
        }

        this._editor = new St.BoxLayout({
            style_class: 'gn-editor',
            orientation: Clutter.Orientation.VERTICAL,
            width: gridWidth,
        });

        const header = new St.Widget({
            style_class: 'gn-editor-header',
            layout_manager: new Clutter.BinLayout(),
        });
        header.add_child(new St.Label({
            style_class: 'gn-editor-title',
            text: _('Quick Settings'),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const closeButton = new St.Button({
            style_class: 'button gn-editor-close',
            icon_name: 'window-close-symbolic',
            accessible_name: _('Done'),
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        closeButton.connect('clicked', () => this._stopEditing());
        addPressFeedback(closeButton, {scale: 0.85});
        header.add_child(closeButton);
        this._editor.add_child(header);

        this._editorContent = new St.BoxLayout({
            style_class: 'gn-editor-content',
            orientation: Clutter.Orientation.VERTICAL,
        });
        // No visible scrollbar: it would clip the badges at the right edge;
        // the fade at the edges shows there is more
        this._editorScroll = new St.ScrollView({
            style_class: 'gn-editor-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            overlay_scrollbars: true,
            child: this._editorContent,
        });
        this._editor.add_child(this._editorScroll);

        const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const maxHeight = Math.max(200, Math.floor(workArea.height / scaleFactor) - 160);
        this._editorScroll.style = `max-height: ${maxHeight}px;`;

        this._menu.box.add_child(this._editor);
        this._populateEditor();
    }

    _leaveEditor() {
        this._editor.destroy();
        this._editor = null;
        this._editorContent = null;
        this._editorScroll = null;
        this._lock.releaseAll(EDITING);
    }

    _populateEditor() {
        if (!this._editor)
            return;

        const scroll = this._editorScroll;
        const scrollValue = scroll.vadjustment.value;

        // Remember where everything was so it can glide to its new place
        const oldRects = new Map();
        for (const actor of this._flipActors())
            oldRects.set(actor._gnKey, rectIn(actor, this._editorContent));

        this._editorContent.destroy_all_children();
        this._popTiles = [];

        const available = item => this._lock.isWanted(item);
        const toggles = gridToggles(this._grid);

        const current = toggles.filter(i => available(i) && this._isActive(i));
        const currentGrid = this._makeGrid(current.map(i => this._makeTile(i, 'remove', 'current')));
        currentGrid.add_style_class_name('gn-editor-current');
        this._editorContent.add_child(currentGrid);
        if (current.length === 0) {
            this._editorContent.add_child(new St.Label({
                style_class: 'gn-editor-empty',
                text: _('Add quick settings from the list below'),
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const catalog = new St.BoxLayout({
            style_class: 'quick-toggle-menu gn-editor-catalog',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const candidates = [
            ...toggles.filter(i => !i._gnExtraId && available(i)),
            ...this._extras.filter(available),
        ];
        for (const category of CATEGORIES) {
            const items = candidates.filter(i => toggleCategory(i) === category.id);
            if (items.length === 0)
                continue;

            const header = new St.Label({
                style_class: 'gn-editor-category',
                text: category.title(),
            });
            header._gnKey = `category:${category.id}`;
            catalog.add_child(header);
            catalog.add_child(this._makeGrid(items.map(i =>
                this._makeTile(i, this._isActive(i) ? 'dimmed' : 'add', 'catalog'))));
        }
        catalog._gnKey = 'catalog';
        this._editorContent.add_child(catalog);

        for (const actor of this._flipActors()) {
            if (!this._popTiles.includes(actor))
                flipFrom(actor, oldRects.get(actor._gnKey), this._editorContent);
        }

        popIn(this._popTiles, {from: 0.8});
        this._justChanged = null;

        // The editor may be gone (menu closed) by the time this runs
        this._later('scroll', () => {
            if (this._editorScroll === scroll)
                scroll.vadjustment.value = scrollValue;
        });
    }

    _flipActors() {
        if (!this._editorContent)
            return [];
        const actors = [];
        const walk = actor => {
            for (const child of actor) {
                if (child._gnKey)
                    actors.push(child);
                if (child._gnKey !== undefined && child._gnKey !== 'catalog')
                    continue;
                walk(child);
            }
        };
        walk(this._editorContent);
        return actors;
    }

    _makeGrid(tiles) {
        const layout = new Clutter.GridLayout({
            column_homogeneous: true,
            column_spacing: 12,
            row_spacing: 4,
        });
        const grid = new St.Widget({
            style_class: 'gn-editor-grid',
            layout_manager: layout,
        });
        tiles.forEach((tile, i) => layout.attach(tile, i % 2, Math.floor(i / 2), 1, 1));
        return grid;
    }

    _makeTile(item, mode, section) {
        const interactive = mode !== 'dimmed';

        const tile = new St.Widget({
            style_class: 'gn-tile-wrapper',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        tile._gnKey = `${section}:${toggleId(this._grid, item)}`;

        const box = new St.BoxLayout({x_expand: true});
        box.add_child(new St.Icon({
            style_class: 'quick-toggle-icon',
            gicon: (toggleIcon(item) ?? item).gicon,
            fallback_icon_name: 'application-x-addon-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const label = new St.Label({
            style_class: 'quick-toggle-title gn-tile-label',
            text: item.title ?? '',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END,
        });
        box.add_child(label);

        const pill = new St.Button({
            style_class: 'quick-toggle button gn-tile',
            child: box,
            x_expand: true,
            y_expand: true,
            reactive: interactive,
            can_focus: interactive,
            accessible_name: mode === 'remove'
                ? _('Remove %s').format(item.title)
                : _('Add %s').format(item.title),
        });
        tile.add_child(pill);
        if (item === this._justChanged)
            this._popTiles.push(tile);

        if (!interactive) {
            tile.opacity = DIMMED_OPACITY;
            return tile;
        }

        const action = () => {
            this._justChanged = item;
            popOut(tile, () => (mode === 'add' ? this._add(item) : this._remove(item)));
        };
        pill.connect('clicked', action);

        const badge = new St.Button({
            style_class: `button gn-tile-badge ${mode}`,
            icon_name: mode === 'add' ? 'list-add-symbolic' : 'list-remove-symbolic',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        badge.connect('clicked', action);
        tile.add_child(badge);
        addPressFeedback(tile, {buttons: [pill, badge]});

        return tile;
    }
}
