import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

// Takes whatever width the parent gives instead of asking for its natural
// width, so long labels inside get ellipsized rather than widening a menu
export const ZeroWidthLayout = GObject.registerClass(
class GnZeroWidthLayout extends Clutter.BinLayout {
    vfunc_get_preferred_width(_container, _forHeight) {
        return [0, 0];
    }
});
