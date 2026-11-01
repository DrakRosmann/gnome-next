import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const STYLE_CLASS = 'gn-android';

// Android 16 style tiles: taller rounded rectangles with the icon in its own
// rounded square, small tiles that are round while off and square while on,
// and thicker sliders. The look is all in the stylesheet, under this class.
export class AndroidStyle {
    constructor(settings, lock) {
        this._settings = settings;
        this._lock = lock;
    }

    enable() {
        this._box = Main.panel.statusArea.quickSettings.menu.box;
        this._box.add_style_class_name(STYLE_CLASS);
    }

    disable() {
        this._box.remove_style_class_name(STYLE_CLASS);
        this._box = null;
    }
}
