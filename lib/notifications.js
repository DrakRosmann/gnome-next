import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {slideIn} from './animation.js';
import {addPressFeedback} from './spring.js';

const ANIMATION_TIME = 160;

function timestamp(notification) {
    return notification.datetime?.to_unix() ?? 0;
}

function newest(source) {
    return Math.max(0, ...source.notifications.map(timestamp));
}

// Newest-first list of the notifications in the message tray, stacked by app
// (with the shell's own notification groups). Collapsed it shows only the
// newest app plus a "N More Notifications" pill; expanded it shows them all
// in a scrollable list, and clicking a stack spreads it out.
export const NotificationList = GObject.registerClass({
    Signals: {
        'expand-requested': {},
        'count-changed': {},
    },
}, class GnNotificationList extends St.BoxLayout {
    constructor() {
        super({
            style_class: 'gn-notifications',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });

        this._expanded = false;
        this._groups = new Map(); // source -> group

        this._list = new St.BoxLayout({
            style_class: 'gn-notification-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'gn-notification-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: this._list,
        });
        this.add_child(this._scroll);

        // The edge of a second card peeking out under the newest one. Not a
        // real `.message`: other extensions (Blur my Shell) treat those as
        // shell message widgets and expect their children.
        this._stack = new St.Widget({
            style_class: 'gn-notification-stack',
            x_expand: true,
        });
        this.add_child(this._stack);

        this._moreLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._moreButton = this._makePill(this._moreLabel);
        this._moreButton.connect('clicked', () => this.emit('expand-requested'));
        addPressFeedback(this._moreButton);
        this.add_child(this._moreButton);

        this._clearButton = new St.Button({
            style_class: 'gn-notification-clear button',
            label: _('Clear'),
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            accessible_name: _('Clear all notifications'),
        });
        this._clearButton.connect('clicked', () => this._clear());
        addPressFeedback(this._clearButton);
        this.add_child(this._clearButton);

        Main.messageTray.connectObject(
            'source-added', (_tray, source) => this._addSource(source),
            'source-removed', (_tray, source) => this._removeSource(source),
            this);
        Main.messageTray.getSources().forEach(source => this._addSource(source));

        // The shell marks notifications as seen when its message list shows
        // them; that list is hidden now, so do it here or the unread dot in
        // the top bar never goes away
        this.connect('notify::mapped', () => this._acknowledge());

        this.connect('destroy', () => {
            this._destroyed = true;
            Main.messageTray.disconnectObject(this);
            for (const source of this._groups.keys()) {
                source.disconnectObject(this);
                source.notifications.forEach(n => n.disconnectObject(this));
            }
        });

        this._sync();
    }

    _makePill(label) {
        const box = new St.BoxLayout({style_class: 'gn-pill-box'});
        box.add_child(label);
        box.add_child(new St.Icon({
            style_class: 'gn-pill-icon',
            icon_name: 'go-next-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return new St.Button({
            style_class: 'button gn-pill',
            child: box,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
    }

    get count() {
        let count = 0;
        for (const source of this._groups.keys())
            count += source.notifications.length;
        return count;
    }

    // Groups with notifications, newest first
    _shownGroups() {
        return this._list.get_children().filter(g => g.source?.notifications.length > 0 &&
            this._groups.get(g.source) === g);
    }

    visibleMessages() {
        return this._shownGroups().filter(g => g.visible);
    }

    get expanded() {
        return this._expanded;
    }

    setExpanded(expanded) {
        this._expanded = expanded;
        if (!expanded) {
            this._scroll.vadjustment.value = 0;
            this._expandedGroup?.collapse().catch(logError);
            this._expandedGroup = null;
        }
        this._sync();
    }

    setMaxHeight(height) {
        this._maxHeight = height;
        this._sync();
    }

    _addSource(source) {
        if (this._groups.has(source))
            return;

        const group = new MessageList.NotificationMessageGroup(source);
        group.connectObject(
            'expand-toggle-requested', () => this._toggleGroup(group),
            'notify::expanded', () => this._sync(),
            this);
        this._groups.set(source, group);
        this._list.insert_child_at_index(group, this._indexFor(source));

        source.connectObject(
            // After the group, which connected first, added its message
            'notification-added', (_s, notification) => this._onAdded(source, notification),
            'notification-removed', (_s, notification) => {
                notification.disconnectObject(this);
                this._sync();
                this.emit('count-changed');
            },
            this);
        source.notifications.forEach(n => this._track(source, n));
        if (source.notifications.length > 0)
            this.emit('count-changed');
        this._sync();
    }

    _track(source, notification) {
        notification.connectObject(
            'notify::datetime', () => this._place(source),
            // Opening a notification leaves Quick Settings
            'activated', () => Main.panel.closeQuickSettings(),
            this);
    }

    _onAdded(source, notification) {
        this._track(source, notification);
        const group = this._groups.get(source);
        const wasShown = group.visible && group.mapped;
        this._place(source);
        this._sync();
        // A new app at the top slides in; a stack that grows does it itself
        if (this.mapped && !wasShown && group.visible)
            slideIn([group]);
        this._acknowledge();
        this.emit('count-changed');
    }

    _removeSource(source) {
        const group = this._groups.get(source);
        if (!group)
            return;

        this._groups.delete(source);
        if (this._expandedGroup === group)
            this._expandedGroup = null;
        source.disconnectObject(this);
        group.disconnectObject(this);

        const wasFirst = !this._expanded && group.visible;
        const finish = () => {
            // The easings below also stop (and call this) when the list is
            // destroyed with the group still in it
            if (this._destroyed)
                return;
            group.destroy();
            this._sync();
            if (wasFirst && this.mapped)
                slideIn(this.visibleMessages().slice(0, 1));
        };

        if (this.mapped && group.visible) {
            group.ease({
                opacity: 0,
                translation_x: group.width / 3,
                duration: ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => {
                    if (this._destroyed)
                        return;
                    // Then close the gap it leaves behind
                    group.height = group.height;
                    group.ease({
                        height: 0,
                        duration: ANIMATION_TIME,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                        onStopped: finish,
                    });
                },
            });
        } else {
            finish();
        }

        this._sync();
        this.emit('count-changed');
    }

    _indexFor(source) {
        const time = newest(source);
        const others = this._list.get_children().filter(g => g.source && g.source !== source);
        // Ties go first: the app that notified last is the newer one
        const index = others.findIndex(g => newest(g.source) <= time);
        return index < 0 ? others.length : index;
    }

    _place(source) {
        const group = this._groups.get(source);
        if (group)
            this._list.set_child_at_index(group, this._indexFor(source));
    }

    // Clicking a stack spreads it out and folds the one spread before; in the
    // collapsed list it expands the list first. A group also asks for this
    // when it gets down to one message.
    _toggleGroup(group) {
        // Being cleared: folding it now would outlive it
        if (this._clearing)
            return;
        if (this._expandedGroup === group || group.source.notifications.length < 2) {
            if (this._expandedGroup === group)
                this._expandedGroup = null;
            group.collapse().catch(logError);
            return;
        }
        if (!this._expanded)
            this.emit('expand-requested');
        this._expandedGroup?.collapse().catch(logError);
        this._expandedGroup = group;
        group.expand().catch(logError);
    }

    _acknowledge() {
        if (!this.mapped)
            return;
        for (const source of this._groups.keys())
            source.notifications.forEach(n => (n.acknowledged = true));
    }

    _clear() {
        this._clearing = true;
        this._expandedGroup = null;
        for (const source of [...this._groups.keys()]) {
            [...source.notifications].forEach(n =>
                n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED));
        }
        this._clearing = false;
    }

    _sync() {
        const count = this.count;
        const groups = this._shownGroups();

        this.visible = count > 0;

        this._groups.forEach(g => (g.visible = false));
        groups.forEach((g, i) => {
            g.visible = this._expanded || i === 0;
        });

        // The shell draws its own stack under a group with several messages
        const firstStacked = groups[0]?.source.notifications.length > 1;
        this._stack.visible = !this._expanded && groups.length > 1 && !firstStacked;
        this._moreButton.visible = !this._expanded && count > 1;
        if (count > 1) {
            this._moreLabel.text = ngettext(
                '%d More Notification', '%d More Notifications', count - 1).format(count - 1);
        }
        this._clearButton.visible = this._expanded && count > 0;

        this._scroll.style = this._expanded && this._maxHeight
            ? `max-height: ${this._maxHeight}px;`
            : null;
        // Only the expanded list scrolls; the fade would cut off the edges of
        // a collapsed stack
        this._scroll.vscrollbar_policy = this._expanded ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER;
        if (this._expanded)
            this._scroll.add_style_class_name('vfade');
        else
            this._scroll.remove_style_class_name('vfade');
    }
});
