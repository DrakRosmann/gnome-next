// Keeps shell actors hidden for as long as at least one reason asks for it,
// while remembering the visibility the actor's owner wants. Shell code keeps
// toggling `visible` on its own items (e.g. Bluetooth hides itself when no
// adapter is present), so simply setting it to false once is not enough.
export class VisibilityLock {
    constructor() {
        this._entries = new Map();
        this._busy = false;
        this._listeners = new Set();
    }

    hide(actor, reason) {
        let entry = this._entries.get(actor);
        if (!entry) {
            entry = {reasons: new Set(), wanted: actor.visible};
            entry.notifyId = actor.connect('notify::visible', () => {
                if (this._busy)
                    return;
                entry.wanted = actor.visible;
                if (actor.visible)
                    this._setVisible(actor, false);
                this._listeners.forEach(cb => cb(actor));
            });
            entry.destroyId = actor.connect('destroy', () => {
                this._entries.delete(actor);
            });
            this._entries.set(actor, entry);
        }
        entry.reasons.add(reason);
        this._setVisible(actor, false);
    }

    release(actor, reason) {
        const entry = this._entries.get(actor);
        if (!entry)
            return;

        entry.reasons.delete(reason);
        if (entry.reasons.size > 0)
            return;

        actor.disconnect(entry.notifyId);
        actor.disconnect(entry.destroyId);
        this._entries.delete(actor);
        this._setVisible(actor, entry.wanted);
    }

    releaseAll(reason) {
        [...this._entries.keys()].forEach(actor => this.release(actor, reason));
    }

    has(actor, reason) {
        return this._entries.get(actor)?.reasons.has(reason) ?? false;
    }

    // The visibility the actor would have without us
    isWanted(actor) {
        return this._entries.get(actor)?.wanted ?? actor.visible;
    }

    // Called with the actor whenever a locked actor's wanted visibility changes
    addListener(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    _setVisible(actor, visible) {
        this._busy = true;
        try {
            actor.visible = visible;
        } finally {
            this._busy = false;
        }
    }

    destroy() {
        for (const [actor, entry] of this._entries) {
            actor.disconnect(entry.notifyId);
            actor.disconnect(entry.destroyId);
            this._setVisible(actor, entry.wanted);
        }
        this._entries.clear();
        this._listeners.clear();
    }
}
