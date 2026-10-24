# GNOME Next

A GNOME Shell 50/51 extension that implements three ideas from the
[GNOME design mockups](https://gitlab.gnome.org/Teams/Design/os-mockups):

| Mockup | What the extension does |
|---|---|
| [Quick Settings customization](https://gitlab.gnome.org/Teams/Design/os-mockups/-/blob/master/system-status/quick-settings/quick-toggles-customization-aday.png) | An **edit** (pencil) button in the Quick Settings system row. It closes the menu and reopens it as an editor: the top section shows the current toggles with a **−** badge, and a categorized catalog below (Connectivity, Device, Personalization, Privacy, Accessibility, Extensions) shows the rest with a **+** badge. Toggles that are already in use appear dimmed. The top-bar accessibility menu is hidden, because the accessibility toggles can now be added to Quick Settings. |
| [Collapsible Quick Settings/Notifications](https://gitlab.gnome.org/Teams/Design/os-mockups/-/blob/master/system-status/quick-settings/quick-toggles-notifications-collapsible-mpris.png) | Notifications and the media player (MPRIS) live in Quick Settings. By default the settings are expanded and only the newest notification shows, with a **“N More Notifications”** pill. Expanding the notifications collapses the toggles into a row of circles, makes the player compact and shows **“Expand Settings”**. Only one group is expanded at a time. |
| [Calendar menu concept](https://gitlab.gnome.org/Teams/Design/os-mockups/-/blob/master/calendar/calendar-popover.png) | A calendar popover without notifications that scales with its content: calendar only → + world clocks → + weather. When the selected day has upcoming events, a left column shows the date, the weather and the events, and the popover height is still set by the calendar and clocks (the events scroll). With more than 4 clocks the list switches to a compact layout; with more than 6 it is paged. |

Also:

* **Pill sliders** (as in the mockups): volume and brightness become thick
  pills with the icon inside the filled part and the menu arrow inside the track.
* **Animations:** toggles morph from pills into circles (and back) when the
  notifications expand; in the editor the remaining toggles glide to their new
  places when one is added or removed; the menus resize smoothly; Quick Settings
  cascades in when it opens; months and world clock pages slide; dismissed
  notifications slide out and close the gap; the calendar grows and shrinks
  when the events column appears. Moves use damped-spring physics, buttons and
  toggles shrink slightly while pressed, colors fade between states, and the
  media cover and play/pause icon spring in when they change. All of them
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
  `xgettext --from-code=UTF-8 -L JavaScript -k_ -kngettext:1,2 -o po/gnome-next@gui.pot extension.js prefs.js lib/*.js`.

## Layout

```
extension.js          turns each feature on/off from the settings
lib/visibility.js     keeps shell actors hidden while the shell keeps toggling them
lib/toggles.js        extra toggles, categories and toggle helpers
lib/customization.js  Quick Settings editor
lib/collapsible.js    settings ⇄ notifications switching, circle toggles
lib/media.js          MPRIS player card
lib/notifications.js  notification list for Quick Settings
lib/calendar.js       calendar popover, weather card
lib/clocks.js         world clocks with analog faces and paging
lib/sliders.js        pill-shaped sliders
lib/animation.js      resize, fade, pop and FLIP animations
lib/morph.js          pill ⇄ circle toggle morph
lib/spring.js         spring animations and press feedback
```

License: GPL-2.0-or-later.
