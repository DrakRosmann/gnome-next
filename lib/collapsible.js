import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {animateResize, fadeIn, rectIn, slideIn} from './animation.js';
import {ZeroWidthLayout} from './layouts.js';
import {MediaCard} from './media.js';
import {NotificationList} from './notifications.js';
import {MORPH_TIME, ToggleMorph} from './morph.js';
import {REMOVED_REASON, activateToggle, gridToggles, toggleIcon, toggleTitle} from './toggles.js';
import {addPressFeedback, bounceIcon} from './spring.js';
import {addShapeMorph} from './shape.js';

const COMPACT = 'gn-compact';
const DATE_MENU_MESSAGES = 'gn-date-menu-messages';
const UNREAD_PAD = 'gn-unread-pad';

const CIRCLES_PER_ROW = 6;
const CIRCLE_SPACING = 12;
// Room left for the panel, system row, circles, player and pill
const RESERVED_HEIGHT = 380;

// Spreads equally sized circles over the full width, six per row
const CircleGridLayout = GObject.registerClass(
class GnCircleGridLayout extends Clutter.LayoutManager {
    _children(container) {
        return container.get_children().filter(c => c.visible);
    }

    _childSize(children) {
        return children.length ? children[0].get_preferred_width(-1)[1] : 0;
    }

    vfunc_get_preferred_width(container, _forHeight) {
        const children = this._children(container);
        const size = this._childSize(children);
        const n = Math.min(children.length, CIRCLES_PER_ROW);
        return [size, n * size + Math.max(0, n - 1) * CIRCLE_SPACING];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        const children = this._children(container);
        if (children.length === 0)
            return [0, 0];
        // Circles are square: their height can come out taller than their
        // width when a tile style sets a minimum height
        const size = this._childSize(children);
        const rows = Math.ceil(children.length / CIRCLES_PER_ROW);
        const height = rows * size + (rows - 1) * CIRCLE_SPACING;
        return [height, height];
    }

    vfunc_allocate(container, box) {
        const children = this._children(container);
        const size = this._childSize(children);
        const step = (box.get_width() - size) / (CIRCLES_PER_ROW - 1);
        const rtl = container.text_direction === Clutter.TextDirection.RTL;

        children.forEach((child, i) => {
            const col = i % CIRCLES_PER_ROW;
            const row = Math.floor(i / CIRCLES_PER_ROW);
            const x = rtl ? box.x2 - size - col * step : box.x1 + col * step;
            const y = box.y1 + row * (size + CIRCLE_SPACING);
            child.allocate(Clutter.ActorBox.new(x, y, x + size, y + size));
        });
    }
});

// "Collapsible Quick Settings/Notifications" mockup: notifications and the
// media player live in Quick Settings, and only one of the two groups is
// expanded at a time.
export class Collapsible {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        const qs = Main.panel.statusArea.quickSettings;
        this._menu = qs.menu;
        this._grid = qs.menu._grid;
        this._systemItem = qs._system._systemItem;
        this._compact = false;
        this._circleBindings = [];

        this._circles = new St.Widget({
            style_class: 'gn-circles',
            layout_manager: new CircleGridLayout(),
            x_expand: true,
            visible: false,
        });
        this._grid.insert_child_above(this._circles, this._systemItem);
        this._grid.layout_manager.child_set_property(this._grid, this._circles,
            'column-span', this._grid.layout_manager.nColumns);

        this._section = new St.Widget({
            style_class: 'gn-qs-section',
            layout_manager: new ZeroWidthLayout(),
            x_expand: true,
        });
        const box = new St.BoxLayout({
            style_class: 'gn-qs-section-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._section.add_child(box);

        this._media = new MediaCard();
        box.add_child(this._media);
        // The editor can move the player into the grid
        this._media._gnMedia = true;
        this._media._gnHome = box;
        this._menu._gnMedia = this._media;
        this._media.connectObject('parent-set', () => this._syncSection(), this);

        const label = new St.Label({
            text: _('Expand Settings'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        const pillBox = new St.BoxLayout({style_class: 'gn-pill-box'});
        pillBox.add_child(label);
        pillBox.add_child(new St.Icon({
            style_class: 'gn-pill-icon',
            icon_name: 'go-next-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._expandSettings = new St.Button({
            style_class: 'button gn-pill',
            child: pillBox,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._expandSettings.connect('clicked', () => this._setCompact(false, true));
        addPressFeedback(this._expandSettings);
        box.add_child(this._expandSettings);

        this._notifications = new NotificationList();
        this._notifications.connectObject(
            'expand-requested', () => this._setCompact(true, true),
            'count-changed', () => {
                if (this._compact && this._notifications.count === 0)
                    this._setCompact(false, true);
            }, this);
        box.add_child(this._notifications);

        this._menu.box.add_child(this._section);

        [this._media, this._expandSettings, this._notifications].forEach(actor =>
            actor.connectObject('notify::visible', () => this._syncSection(), this));
        this._syncSection();

        this._menu.connectObject('open-state-changed', (_menu, open) => {
            if (!open)
                return;
            this._setCompact(false, false);
            this._cascadeIn();
        }, this);

        this._grid.connectObject(
            'child-added', (_grid, child) => this._onGridChanged(child),
            'child-removed', () => this._onGridChanged(null),
            this);
        this._removeLockListener = this._lock.addListener(() => this._queueCircles());

        this._feedback = new Map();
        this._syncFeedback();

        const dateMenu = Main.panel.statusArea.dateMenu;
        if (dateMenu?._messageList)
            this._lock.hide(dateMenu._messageList, DATE_MENU_MESSAGES);
        this._moveUnreadIndicator(qs);

        this._setCompact(false, false);
    }

    // The unread dot belongs next to where the notifications are now
    _moveUnreadIndicator(qs) {
        const indicator = Main.panel.statusArea.dateMenu?._indicator;
        const box = indicator?.get_parent();
        if (!box || !qs._indicators)
            return;

        // The clock is centered with an invisible pad the size of the dot
        const pad = box.get_first_child();
        this._unread = {indicator, box, index: box.get_children().indexOf(indicator), pad};
        if (pad !== indicator)
            this._lock.hide(pad, UNREAD_PAD);
        box.remove_child(indicator);
        qs._indicators.add_child(indicator);
    }

    _restoreUnreadIndicator() {
        if (!this._unread)
            return;
        const {indicator, box, index, pad} = this._unread;
        this._unread = null;
        indicator.get_parent()?.remove_child(indicator);
        box.insert_child_at_index(indicator, index);
        this._lock.release(pad, UNREAD_PAD);
    }

    disable() {
        this._morph?.cancel();
        this._morph = null;

        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;

        this._removeLockListener();
        this._feedback.forEach((undo, toggle) => {
            toggle.disconnectObject(this);
            undo();
        });
        this._feedback = null;
        this._menu.disconnectObject(this);
        this._grid.disconnectObject(this);

        this._lock.releaseAll(COMPACT);
        this._lock.releaseAll(DATE_MENU_MESSAGES);
        this._restoreUnreadIndicator();

        this._clearCircles();
        this._circles.destroy();
        delete this._menu._gnMedia;
        this._media.destroy();
        this._section.destroy();
        this._circles = null;
        this._section = null;
        this._media = null;
        this._notifications = null;
    }

    _syncSection() {
        const media = this._media.visible && this._media.get_parent() === this._media._gnHome;
        this._section.visible = media ||
            this._expandSettings.visible || this._notifications.visible;
    }

    // What compact mode hides: the player stays, shrunk to a row
    _isGridItem(child) {
        return child !== this._systemItem &&
            child !== this._circles &&
            child !== this._media &&
            child !== this._grid.layout_manager._overlay;
    }

    // Toggles shrink a little while pressed, like the circles
    _syncFeedback() {
        for (const toggle of gridToggles(this._grid)) {
            if (this._feedback.has(toggle))
                continue;
            const contents = toggle._box?.get_first_child();
            const buttons = toggle._menuButton && contents
                ? [contents, toggle._menuButton]
                : [toggle];
            this._feedback.set(toggle, addPressFeedback(toggle, {scale: 0.96, buttons}));
            toggle.connectObject(
                'notify::checked', () => bounceIcon(toggleIcon(toggle)),
                'destroy', () => this._feedback?.delete(toggle),
                this);
        }
    }

    _onGridChanged(child) {
        if (child)
            this._syncFeedback();
        if (this._compact && child && this._isGridItem(child))
            this._lock.hide(child, COMPACT);
        this._queueCircles();
    }

    _queueCircles() {
        if (!this._compact || this._laterId)
            return;

        const laters = global.compositor.get_laters();
        this._laterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._rebuildCircles();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearCircles() {
        this._circleBindings.forEach(b => b.unbind());
        this._circleBindings = [];
        this._circles.destroy_all_children();
    }

    _rebuildCircles() {
        this._clearCircles();

        for (const item of gridToggles(this._grid)) {
            if (!this._lock.isWanted(item) || this._lock.has(item, REMOVED_REASON))
                continue;

            const icon = new St.Icon({style_class: 'gn-circle-icon'});
            const button = new St.Button({
                style_class: 'quick-toggle button gn-circle',
                child: icon,
                can_focus: true,
                accessible_name: item.title ?? '',
            });
            const flags = GObject.BindingFlags.SYNC_CREATE;
            this._circleBindings.push(
                (toggleIcon(item) ?? item).bind_property('gicon', icon, 'gicon', flags),
                item.bind_property('checked', button, 'checked', flags),
                item.bind_property('reactive', button, 'reactive', flags));
            button.connect('clicked', () => activateToggle(item));
            button.connect('notify::checked', () => bounceIcon(icon));
            addShapeMorph(button);
            button._gnToggle = item;
            addPressFeedback(button, {scale: 0.88});
            this._circles.add_child(button);
        }
    }

    _setCompact(compact, animate) {
        this._morph?.cancel();
        const wasCompact = this._compact;
        if (!animate || compact === wasCompact || !St.Settings.get().enable_animations) {
            if (animate)
                animateResize(this._menu.box, () => this._applyCompact(compact));
            else
                this._applyCompact(compact);
            return;
        }

        const host = this._menu.actor;
        this._morph ??= new ToggleMorph(host);

        if (compact) {
            // Remember where every pill is, both to start the morph and to
            // come back to later
            this._pillRects = new Map();
            for (const toggle of this._morphToggles()) {
                const icon = toggleIcon(toggle);
                const title = toggleTitle(toggle);
                const menuButton = toggle._menuButton;
                this._pillRects.set(toggle, {
                    arrow: menuButton?.visible ? rectIn(menuButton, toggle) : null,
                    rect: rectIn(toggle, host),
                    icon: icon ? {...rectIn(icon, toggle), gicon: icon.gicon} : null,
                    title: title ? {...rectIn(title, toggle), text: title.text} : null,
                });
            }
        }
        const circleRects = compact ? null : new Map(this._circles.get_children()
            .map(c => [c._gnToggle, rectIn(c, host)]));
        const systemRect = rectIn(this._systemItem, host);
        const gridRect = rectIn(this._grid, host);

        animateResize(this._menu.box, () => this._applyCompact(compact), {duration: MORPH_TIME});

        if (compact) {
            const circles = this._circles.get_children();
            const targets = this._circleTargets(circles, systemRect, gridRect);
            const items = circles.map((circle, i) => {
                const pill = this._pillRects.get(circle._gnToggle);
                return pill?.icon && this._morphItem(circle._gnToggle, pill, targets[i], true);
            }).filter(Boolean);

            circles.forEach(c => (c.opacity = 0));
            this._morph.run(items, {
                toCircle: true,
                onDone: () => circles.forEach(c => (c.opacity = 255)),
            });
            slideIn(this._notifications.visibleMessages().slice(1));
        } else {
            const toggles = [...circleRects.keys()].filter(t => this._pillRects?.has(t));
            const items = toggles.map(t => this._morphItem(t, this._pillRects.get(t),
                circleRects.get(t), false)).filter(Boolean);

            toggles.forEach(t => (t.opacity = 0));
            this._morph.run(items, {
                toCircle: false,
                onDone: () => toggles.forEach(t => (t.opacity = 255)),
            });
            // Sliders and the rest come back around the morphing toggles
            [...this._grid].filter(c => this._isGridItem(c) && !toggles.includes(c))
                .forEach(c => fadeIn(c, {delay: MORPH_TIME * 0.3}));
        }

        fadeIn(this._media);
        fadeIn(this._expandSettings);
    }

    // A light cascade, row by row, while the menu itself opens
    _cascadeIn() {
        if (!St.Settings.get().enable_animations)
            return;

        const rows = [];
        let row = null;
        for (const child of this._grid) {
            if (!child.visible || !this._isGridItem(child) && child !== this._systemItem && child !== this._media)
                continue;
            const y = child.has_allocation() ? Math.round(child.get_allocation_box().y1) : rows.length;
            if (!row || row.y !== y) {
                row = {y, actors: []};
                rows.push(row);
            }
            row.actors.push(child);
        }
        if (this._section.visible)
            rows.push({actors: [this._section]});

        rows.forEach(({actors}, i) => {
            actors.forEach(actor => {
                actor.remove_transition('opacity');
                actor.remove_transition('translation-y');
                actor.set({opacity: 0, translation_y: -8});
                actor.ease({
                    opacity: 255,
                    translation_y: 0,
                    delay: 40 + i * 22,
                    duration: 260,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            });
        });
    }

    _morphToggles() {
        return gridToggles(this._grid).filter(t =>
            t.visible && !this._lock.has(t, REMOVED_REASON));
    }

    // Where the circles will be once laid out, computed like CircleGridLayout
    _circleTargets(circles, systemRect, gridRect) {
        if (circles.length === 0)
            return [];

        const size = circles[0].get_preferred_width(-1)[1];
        const spacing = this._grid.layout_manager.rowSpacing ?? CIRCLE_SPACING;
        const top = systemRect.y + systemRect.height + spacing;
        const step = (gridRect.width - size) / (CIRCLES_PER_ROW - 1);
        const rtl = this._grid.text_direction === Clutter.TextDirection.RTL;

        return circles.map((_c, i) => {
            const col = i % CIRCLES_PER_ROW;
            const row = Math.floor(i / CIRCLES_PER_ROW);
            const x = rtl
                ? gridRect.x + gridRect.width - size - col * step
                : gridRect.x + col * step;
            return {x, y: top + row * (size + CIRCLE_SPACING), width: size, height: size};
        });
    }

    // pill: saved pill geometry; circle: the circle's rect
    _morphItem(toggle, pill, circle, toCircle) {
        if (!pill.icon || !circle)
            return null;

        // Icon positions are centers: the shell allocates the icon a taller
        // box than the glyph it draws
        const centered = {cx: circle.width / 2, cy: circle.height / 2, gicon: pill.icon.gicon};
        const pillIcon = {
            cx: pill.icon.x + pill.icon.width / 2,
            cy: pill.icon.y + pill.icon.height / 2,
            gicon: pill.icon.gicon,
        };
        return {
            toggle,
            from: toCircle ? pill.rect : circle,
            to: toCircle ? circle : pill.rect,
            iconFrom: toCircle ? pillIcon : {...centered},
            iconTo: toCircle ? centered : pillIcon,
            title: pill.title,
            arrow: pill.arrow,
        };
    }

    _applyCompact(compact) {
        this._compact = compact;

        if (compact)
            this._menu._activeMenu?.close(PopupAnimation.NONE);

        for (const child of this._grid) {
            if (!this._isGridItem(child))
                continue;
            if (compact)
                this._lock.hide(child, COMPACT);
            else
                this._lock.release(child, COMPACT);
        }

        if (compact)
            this._rebuildCircles();
        else
            this._clearCircles();
        this._circles.visible = compact;

        this._media.setCompact(compact);
        this._expandSettings.visible = compact;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        this._notifications.setMaxHeight(
            Math.max(160, Math.floor(workArea.height / scaleFactor) - RESERVED_HEIGHT));
        this._notifications.setExpanded(compact);
    }
}
