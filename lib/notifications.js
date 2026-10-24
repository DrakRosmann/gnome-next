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

// Flat, newest-first list of every notification in the message tray.
// Collapsed it shows only the newest one plus a "N More Notifications" pill;
// expanded it shows them all in a scrollable list.
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
        this._messages = new Map();

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

        this.connect('destroy', () => {
            Main.messageTray.disconnectObject(this);
            Main.messageTray.getSources().forEach(s => s.disconnectObject(this));
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
        return this._messages.size;
    }

    visibleMessages() {
        return this._list.get_children().filter(c => c.visible && this._messages.has(c.notification));
    }

    get expanded() {
        return this._expanded;
    }

    setExpanded(expanded) {
        this._expanded = expanded;
        if (!expanded)
            this._scroll.vadjustment.value = 0;
        this._sync();
    }

    setMaxHeight(height) {
        this._maxHeight = height;
        this._sync();
    }

    _addSource(source) {
        source.connectObject(
            'notification-added', (_s, notification) => this._addNotification(notification),
            'notification-removed', (_s, notification) => this._removeNotification(notification),
            this);
        source.notifications.forEach(n => this._addNotification(n));
    }

    _removeSource(source) {
        source.disconnectObject(this);
        source.notifications.forEach(n => this._removeNotification(n));
    }

    _indexFor(notification) {
        const time = timestamp(notification);
        const others = this._list.get_children().filter(c => c.notification !== notification);
        // Ties go first: a notification added later is the newer one
        const index = others.findIndex(c => c.notification && timestamp(c.notification) <= time);
        return index < 0 ? others.length : index;
    }

    _addNotification(notification) {
        let message = this._messages.get(notification);
        if (message) {
            this._list.set_child_at_index(message, this._indexFor(notification));
            this._sync();
            return;
        }

        message = new MessageList.NotificationMessage(notification);
        message.connect('clicked', () => Main.panel.closeQuickSettings());
        notification.connectObject('notify::datetime', () => {
            if (this._messages.has(notification))
                this._list.set_child_at_index(message, this._indexFor(notification));
        }, message);

        this._messages.set(notification, message);
        this._list.insert_child_at_index(message, this._indexFor(notification));

        if (this.mapped)
            slideIn([message]);

        this._sync();
        this.emit('count-changed');
    }

    _removeNotification(notification) {
        const message = this._messages.get(notification);
        if (!message)
            return;

        this._messages.delete(notification);
        notification.disconnectObject(message);

        const wasFirst = !this._expanded && message.visible;
        const finish = () => {
            message.destroy();
            this._sync();
            if (wasFirst && this.mapped)
                slideIn(this.visibleMessages().slice(0, 1));
        };

        if (this.mapped && message.visible) {
            message.ease({
                opacity: 0,
                translation_x: message.width / 3,
                duration: ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => {
                    // Then close the gap it leaves behind
                    message.height = message.height;
                    message.ease({
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

    _clear() {
        [...this._messages.keys()].forEach(n =>
            n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED));
    }

    _sync() {
        const count = this._messages.size;
        const messages = this._list.get_children().filter(c => this._messages.has(c.notification));

        this.visible = count > 0;

        messages.forEach((m, i) => {
            m.visible = this._expanded || i === 0;
        });

        this._stack.visible = !this._expanded && count > 1;
        this._moreButton.visible = !this._expanded && count > 1;
        if (count > 1) {
            this._moreLabel.text = ngettext(
                '%d More Notification', '%d More Notifications', count - 1).format(count - 1);
        }
        this._clearButton.visible = this._expanded && count > 0;

        this._scroll.style = this._expanded && this._maxHeight
            ? `max-height: ${this._maxHeight}px;`
            : null;
    }
});
