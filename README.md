# GNOME Next

A GNOME Shell 50/51 extension that implements three ideas from the
[GNOME design mockups](https://gitlab.gnome.org/Teams/Design/os-mockups):

| Mockup | What the extension does |
|---|---|
| [Quick Settings customization](https://gitlab.gnome.org/Teams/Design/os-mockups/-/blob/master/system-status/quick-settings/quick-toggles-customization-aday.png) | An **edit** (pencil) button in the Quick Settings system row. It closes the menu and reopens it as an editor: the top section shows the current toggles, which can be dragged into another order and clicked to make them small or large, with a **−** badge, and a categorized catalog below (Connectivity, Device, Personalization, Privacy, Accessibility, Extensions) shows the rest with a **+** badge. Toggles that are already in use appear dimmed. The top-bar accessibility menu is hidden, because the accessibility toggles can now be added to Quick Settings. |
| [Collapsible Quick Settings/Notifications](https://gitlab.gnome.org/Teams/Design/os-mockups/-/blob/master/system-status/quick-settings/quick-toggles-notifications-collapsible-mpris.png) | Notifications and the media player (MPRIS) live in Quick Settings. By default the settings are expanded and only the newest notification shows, with a **“N More Notifications”** pill. Expanding the notifications collapses the toggles into a row of circles, makes the player compact and shows **“Expand Settings”**. Only one group is expanded at a time. |
| [Calendar menu concept](https://gitlab.gnome.org/Teams/Design/os-mockups/-/blob/master/calendar/calendar-popover.png) | A calendar popover without notifications that scales with its content: calendar only → + world clocks → + weather. When the selected day has upcoming events, a left column shows the date, the weather and the events, and the popover height is still set by the calendar and clocks (the events scroll). With more than 4 clocks the list switches to a compact layout; with more than 6 it is paged. |

Also:

* **Small and large tiles, in your order** (as on Android and in the iOS
  Control Center): in the Quick Settings editor, drag a tile to move it (the
  others make room) and click it to switch between large (icon and name) and
  small (icon only, half the width). **−** removes it; added tiles go last.
  Right-click any tile with a menu to open it, like a long press on Android —
  small tiles have no room for the arrow.
* **Android style** (as in Android 16): taller rounded tiles with the icon in
  its own rounded square and the arrow inside the tile, small tiles that are
  round while off and turn into rounded squares when on, thicker sliders, and
  the media player with the album cover as its background. It can be turned
  off in Preferences to keep the GNOME look.
* **Volume of each app** (as in the Windows mixer): the menu of the volume
  slider lists every app playing sound, each with its own slider; clicking the
  app's icon mutes it.
* **Top bar shortcuts:** middle-click the volume icon to mute, and scroll over
  the battery icon to change the screen brightness.
* **Widgets under the calendar** (as in macOS and Windows): a two-column
  board of small (1×1), medium (2×1) and large (2×2) widgets. **Edit Widgets**
  opens a gallery next to the board with a live preview of each widget and a
  size picker; click a widget to add it. On the board, **−** removes a widget,
  dragging moves it and clicking it cycles its size. Widgets with nothing to
  show (no player, no batteries…) stay hidden until you edit. Available:
  * **Weather** — conditions, the next hours and (large) the next days, from GNOME Weather
  * **Weather in Other Cities** — the places saved in GNOME Weather (or the world clocks)
  * **World Clocks** — day/night clock faces for the cities in GNOME Clocks
  * **Up Next** — today's remaining events (and tomorrow's in the large size)
  * **Reminders** — a to-do list kept in the extension settings: type to add, check to
    complete. A time written with the text — "amanhã 9h", "sexta às 14:30", "em 20 min",
    "dia 5", "25/12 de manhã", "tomorrow 9am", "in 2 hours" — is taken out of it and
    brings up a notification then (with *Complete* and *Snooze 10 min*), also for
    reminders that came due while logged out. Overdue reminders turn red
  * **Stocks** — prices and today's chart from Yahoo Finance (the only widget that
    uses the internet). Pick the symbols in Preferences, e.g. `PETR4.SA`, `AAPL`,
    `^BVSP`, `USDBRL=X`, `BTC-USD`; until then a list for your language region is used.
    Says when the market is closed, and keeps the last prices (marked offline) when
    there is no connection
  * **Now Playing** — cover and controls of the MPRIS player
  * **System Monitor** — CPU, memory, disk and network (CPU history when large)
  * **Batteries** — this computer and connected devices (mouse, headset…), via UPower
  * **Controls** — your Quick Settings toggles as round buttons, in the order set
    in the editor (as in the iOS Control Center); clicking the card opens Quick Settings
  * **Note** — a sticky note, saved in the extension settings
  * **Photo** — a random picture from your Pictures folder, a new one each time
* **Unread dot in Quick Settings:** with notifications in Quick Settings, the
  unread-notifications dot moves from the clock to the Quick Settings
  indicators, and notifications count as seen once Quick Settings shows them.
* **Notifications stacked by app:** in Quick Settings, notifications from the
  same app pile up into one stack (GNOME's own notification groups). Clicking a
  stack spreads it out; the button in its header folds it again.
* **Do Not Disturb for a while:** the Do Not Disturb toggle gets a menu — for 1
  hour, until this evening (19:00), until tomorrow (08:00) or until turned off.
  The subtitle shows when it ends, and it turns itself off then, also after
  logging out and back in.
* **Pill sliders** (as in the mockups): volume and brightness become thick
  pills with the icon inside the filled part and the menu arrow inside the track.
* **Animations:** toggles morph from pills into circles (and back) when the
  notifications expand; in the editor the remaining toggles glide to their new
  places when one is added or removed; the menus resize smoothly; Quick Settings
  cascades in when it opens; months and world clock pages slide; dismissed
  notifications slide out and close the gap; the calendar grows and shrinks
  when the events column appears. Moves use damped-spring physics, buttons and
  toggles shrink slightly while pressed, a toggle's icon springs when it turns
  on or off, small tiles morph between round and square (corners and color
  together, not a cross-fade), dismissed notifications slide away while the
  gap closes and stacks glide to the top when a new notification arrives, colors fade between states, and the media cover and play/pause
  icon spring in when they change. In the editors, moving or resizing a tile
  updates it in place, and the widget gallery opens at once and fills in its
  live previews one by one, so no animation waits for heavy work. All of them
  follow the system "Animations" setting.

## Extra toggles in the catalog

Besides the built-in toggles (and toggles from other extensions), the catalog offers:

* **Device:** Screenshot, Battery Health (only on batteries where UPower supports a charge limit)
* **Privacy:** Camera, Location, Screen Lock, Microphone
* **Accessibility:** Zoom, High Contrast, Large Text, Visual Alerts, Screen Keyboard,
  Screen Reader, Sticky Keys, Mouse Keys, Bounce Keys, Slow Keys

Mockup items that need hardware or services GNOME Shell does not expose
(Cast Screen, HDR, Flashlight, Media/File Sharing) are not implemented.

## Install

Requires GNOME Shell 50 or 51 (`gnome-shell --version`). Works on any
distribution (Fedora, Ubuntu, Arch, openSUSE, Debian…).

**One line** (downloads the latest release, no build tools needed):

```sh
curl -fsSL https://raw.githubusercontent.com/DrakRosmann/gnome-next/master/get.sh | bash
```

**From the release zip:** download `gnome-next@gui.zip` from
[Releases](https://github.com/DrakRosmann/gnome-next/releases/latest), then:

```sh
gnome-extensions install --force gnome-next@gui.zip
```

**From source** (needs `glib-compile-schemas`, `zip` and, for translations, `gettext`):

```sh
git clone https://github.com/DrakRosmann/gnome-next.git
cd gnome-next
./install.sh            # builds and copies to ~/.local/share/gnome-shell/extensions
```

Then log out and back in (Wayland) or restart the shell with Alt+F2, `r` (X11), and:

```sh
gnome-extensions enable gnome-next@gui
gnome-extensions prefs gnome-next@gui   # turn each feature on or off
```

`./install.sh pack` creates `gnome-next@gui.zip`. Pushing a `v*` tag builds
the zip on GitHub Actions and attaches it to a release.

To uninstall: `gnome-extensions uninstall gnome-next@gui`.

World clocks come from GNOME Clocks and weather from GNOME Weather, the same
sources the stock calendar uses.

## Notes

* It conflicts with other extensions that rebuild Quick Settings or the date
  menu (e.g. Sanket); enable only one of them.
* Translations: `po/` (pt_BR included). Regenerate the template with
  `xgettext --from-code=UTF-8 -L JavaScript -k_ -kngettext:1,2 -o po/gnome-next@gui.pot extension.js prefs.js lib/*.js lib/widgets/*.js`.

## Layout

```
extension.js          turns each feature on/off from the settings
lib/visibility.js     keeps shell actors hidden while the shell keeps toggling them
lib/toggles.js        extra toggles, categories and toggle helpers
lib/customization.js  Quick Settings editor
lib/tiles.js          small and large tiles, tile order, right-click menus
lib/mixer.js          volume of each app in the volume slider menu
lib/panel.js          top bar shortcuts (mute, brightness)
lib/androidStyle.js   Android style tiles (the look is in the stylesheet)
lib/collapsible.js    settings ⇄ notifications switching, circle toggles
lib/media.js          MPRIS player card
lib/notifications.js  notification list for Quick Settings
lib/calendar.js       calendar popover, weather card
lib/clocks.js         world clocks with analog faces and paging
lib/widgets/          widget board under the calendar:
  board.js            grid, edit mode, drag and resize
  gallery.js          widget gallery shown while editing
  registry.js         the list of widgets and how they are saved
  base.js, drawing.js widget base class, rings, clock faces, sparkline
  *.js                one file per widget
lib/sliders.js        pill-shaped sliders
lib/animation.js      resize, fade, pop and FLIP animations
lib/morph.js          pill ⇄ circle toggle morph
lib/spring.js         spring animations and press feedback
```

License: GPL-2.0-or-later.
