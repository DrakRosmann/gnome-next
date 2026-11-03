import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

// Below this a menu scrolls anyway rather than shrinking further
const MIN_HEIGHT = 160;
// Room kept under a menu for the panel's own edge
const BOTTOM_MARGIN = 24;

// Toggle menus open under their toggle and the panel grows to fit them, so on
// a short screen a long one (the timer, a crowded Wi-Fi list) ran off the
// bottom. Each menu now scrolls within the room the screen has left under
// its toggle.
export class MenuFit {
    enable() {
        const menu = Main.panel.statusArea.quickSettings.menu;
        // Every toggle menu's actor lives on this layer
        this._overlay = menu._overlay;
        this._fitted = new Map();

        this._overlay.connectObject('child-added', (_overlay, actor) => this._wrap(actor._delegate), this);
        [...this._overlay].forEach(actor => this._wrap(actor._delegate));
    }

    disable() {
        this._overlay.disconnectObject(this);
        for (const [menu, {scroll, open}] of this._fitted) {
            menu.disconnectObject(this);
            if (open)
                menu.open = open;
            else
                delete menu.open;
            scroll.child = null;
            menu.actor.remove_child(scroll);
            menu.actor.add_child(menu.box);
            scroll.destroy();
        }
        this._fitted = null;
    }

    _wrap(menu) {
        const item = menu?.sourceActor;
        if (!item || !menu.box || this._fitted.has(menu) || menu.box.get_parent() !== menu.actor)
            return;

        const scroll = new St.ScrollView({
            style_class: 'gn-menu-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        menu.actor.remove_child(menu.box);
        scroll.child = menu.box;
        menu.actor.add_child(scroll);

        // Fitted before the menu measures itself to open
        const own = Object.hasOwn(menu, 'open') ? menu.open : null;
        const open = own ?? Object.getPrototypeOf(menu).open;
        menu.open = animate => {
            this._fit(item, menu, scroll);
            open.call(menu, animate);
        };
        // Items reached with the keyboard scroll into view
        menu.connectObject('active-changed', (_menu, active) => {
            if (active && scroll.style)
                ensureActorVisibleInScrollView(scroll, active.actor ?? active);
        }, this);
        scroll.connect('destroy', () => this._fitted?.delete(menu));
        this._fitted.set(menu, {scroll, open: own});
    }

    _fit(item, menu, scroll) {
        scroll.style = null;
        scroll.vadjustment.value = 0;
        if (!item.has_allocation())
            return;

        const monitor = Main.layoutManager.findIndexForActor(item);
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const [, y] = item.get_transformed_position();
        const top = y + item.height;
        const chrome = menu.actor.get_theme_node().get_vertical_padding() + BOTTOM_MARGIN * scaleFactor;
        const room = workArea.y + workArea.height - top - chrome;

        const [, natural] = scroll.get_preferred_height(-1);
        if (natural <= room)
            return;
        const height = Math.max(MIN_HEIGHT, Math.floor(room / scaleFactor));
        scroll.style = `max-height: ${height}px;`;
    }
}
