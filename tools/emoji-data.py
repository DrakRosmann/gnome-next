#!/usr/bin/env python3
"""Builds lib/emoji.json for the emoji panel of the clipboard popup.

The order and groups come from GTK's emoji chooser data (inside libgtk-4),
names and keywords from IBus' emoji dictionaries, in Portuguese and English,
so the search finds "coração" and "heart" alike.

Each entry is [emoji, group, name, search text]; groups are GTK's: 0 smileys,
1 people, 3 nature, 4 food, 5 travel, 6 activities, 7 objects, 8 symbols,
9 flags (2, hair styles, goes with people).

Usage: tools/emoji-data.py [path to libgtk-4.so]
"""
import json
import subprocess
import sys
import unicodedata
from pathlib import Path

import gi
gi.require_version('IBus', '1.0')
from gi.repository import GLib, IBus  # noqa: E402

LIBGTK = sys.argv[1] if len(sys.argv) > 1 else '/usr/lib/libgtk-4.so'
DICTS = Path('/usr/share/ibus/dicts')
OUT = Path(__file__).resolve().parent.parent / 'lib' / 'emoji.json'

data = subprocess.run(['gresource', 'extract', LIBGTK, '/org/gtk/libgtk/emoji/en.data'],
                      check=True, capture_output=True).stdout
entries = GLib.Variant.new_from_bytes(
    GLib.VariantType('a(aussasasu)'), GLib.Bytes(data), True).unpack()


def load(lang):
    path = DICTS / f'emoji-{lang}.dict'
    if not path.exists():
        return {}
    return {d.get_emoji(): (d.get_description(), d.get_annotations())
            for d in IBus.EmojiData.load(str(path))}


def strip_accents(text):
    return ''.join(c for c in unicodedata.normalize('NFD', text)
                   if unicodedata.category(c) != 'Mn')


pt = load('pt')
out = []
for codepoints, name, _local, keywords, _keywords2, group in entries:
    # 0 stands for a skin tone; the panel shows the default yellow
    emoji = ''.join(chr(c) for c in codepoints if c)
    pt_name, pt_words = pt.get(emoji) or pt.get(emoji.replace('️', '')) or ('', [])
    words = [pt_name, *pt_words, name, *keywords]
    seen = []
    for w in words:
        w = strip_accents(w.lower())
        if w and w not in seen:
            seen.append(w)
    out.append([emoji, 1 if group == 2 else group, pt_name or name, ' '.join(seen)])

OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
print(f'{len(out)} emoji, {OUT.stat().st_size // 1024} KiB -> {OUT}')
