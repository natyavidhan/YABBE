"""Lyrics → an ASS subtitle script, drawn by libass (FFmpeg's ``ass`` filter)
onto a transparent canvas the size of the project; the compositor then moves /
scales / blends it like any other layer.

Everything is laid out here: lines are wrapped (measured with the same font
via Pillow) into rows, rows are placed for the chosen layout, and each row
becomes its own event per stretch of time, so rows can slide between places
(scrolling), come and go with their own effects, and the words in the line
being sung change as they're sung - all with ASS override tags (``\\kf`` wipes,
``\\t`` animated colour / scale / blur / alpha). Boxes behind text are a second
layer of the same text drawn invisible with an opaque border box.
"""

from __future__ import annotations

import hashlib
import math
import re
import threading
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Optional

from PIL import ImageFont

from ... import config
from ...models import Lyrics, LyricsStyle
from .. import text as textmod

VERSION = "l1"


# -- colours ------------------------------------------------------------------------------

def _rgba(c: Optional[str], fallback: str = "#ffffff") -> tuple[int, int, int, int]:
    c = (c or fallback).lstrip("#")
    if not re.fullmatch(r"[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", c):
        c = fallback.lstrip("#")
    r, g, b = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
    a = int(c[6:8], 16) if len(c) == 8 else 255
    return r, g, b, a


def _c(c: Optional[str]) -> str:
    r, g, b, _ = _rgba(c)
    return f"&H{b:02X}{g:02X}{r:02X}&"


def _a(c: Optional[str], opacity: float = 1.0) -> str:
    """ASS alpha (00 = opaque) of a colour, times an extra opacity."""
    a = _rgba(c)[3] * max(0.0, min(1.0, opacity))
    return f"&H{255 - round(a):02X}&"


def _style_colour(c: Optional[str]) -> str:
    r, g, b, a = _rgba(c)
    return f"&H{255 - a:02X}{b:02X}{g:02X}{r:02X}"


def _ts(t: float) -> str:
    cs = max(0, round(t * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _esc(s: str) -> str:
    return s.replace("\\", "⧵").replace("{", "(").replace("}", ")").replace("\n", " ")


# -- measuring ------------------------------------------------------------------------------

@lru_cache(maxsize=32)
def _font(family: str, bold: bool, italic: bool, size: int):
    path = textmod.resolve_font(family, bold, italic)
    if not path:
        return None, 1.0
    probe = ImageFont.truetype(path, 100)
    asc, desc = probe.getmetrics()
    # libass sizes fonts by their line height (ascender + descender), Pillow by the em
    ratio = (asc + desc) / 100
    return ImageFont.truetype(path, max(1, round(size / max(0.5, ratio)))), ratio


def _measure(s: LyricsStyle, word: str) -> float:
    font, _ = _font(s.font, s.bold, s.italic, s.size)
    if font is None:
        return len(word) * s.size * 0.55
    return font.getlength(word) + s.letter_spacing * len(word)


def _case(s: LyricsStyle, w: str) -> str:
    if s.case == "upper":
        return w.upper()
    if s.case == "lower":
        return w.lower()
    if s.case == "title":
        return w[:1].upper() + w[1:]
    return w


# -- units (what's shown together) ----------------------------------------------------------

@dataclass
class _Word:
    text: str
    start: float
    end: float


@dataclass
class _Unit:
    words: list[_Word]
    start: float
    end: float
    rows: list[list[int]] = field(default_factory=list)  # word indices per row
    show: float = 0.0
    hide: float = 0.0


def _units(lyrics: Lyrics, canvas_w: float) -> list[_Unit]:
    s = lyrics.style
    off = s.offset_ms / 1000
    out: list[_Unit] = []
    for line in lyrics.lines:
        if line.words:
            words = [_Word(_case(s, w.text), w.start + off, max(w.end, w.start + 0.01) + off) for w in line.words if w.text]
        else:  # untimed words: spread the line evenly
            parts = line.text.split()
            if not parts:
                continue
            span = max(0.05, line.end - line.start) / len(parts)
            words = [_Word(_case(s, p), line.start + off + i * span, line.start + off + (i + 1) * span)
                     for i, p in enumerate(parts)]
        if not words:
            continue
        if s.layout == "words":
            n = max(1, s.words_shown)
            for i in range(0, len(words), n):
                g = words[i:i + n]
                out.append(_Unit(g, g[0].start, g[-1].end))
        else:
            out.append(_Unit(words, words[0].start, max(w.end for w in words)))
    out.sort(key=lambda u: u.start)
    lead, hold = s.lead_ms / 1000, s.hold_ms / 1000
    if s.layout == "words":
        lead = min(lead, 0.15)
    for i, u in enumerate(out):
        prev_end = out[i - 1].end if i else -1e9
        u.show = min(u.start, max(u.start - lead, prev_end))
    for i, u in enumerate(out):
        nxt = out[i + 1].show if i + 1 < len(out) else math.inf
        u.hide = max(u.show + 0.05, min(u.end + hold, nxt))
    # wrap
    width = s.width * canvas_w
    space = _measure(s, " ")
    for u in out:
        rows: list[list[int]] = [[]]
        used = 0.0
        for i, w in enumerate(u.words):
            ww = _measure(s, w.text) * (max(1.0, s.active_scale) if s.word_fx != "fill" else 1.0)
            if rows[-1] and used + space + ww > width:
                rows.append([])
                used = 0.0
            used += (space if rows[-1] else 0) + ww
            rows[-1].append(i)
        u.rows = rows
    return out


def _pages(units: list[_Unit], per_page: int) -> list[int]:
    """Page number of each unit (verses: split at long pauses, at most ``per_page`` lines)."""
    page, count, out = 0, 0, []
    for i, u in enumerate(units):
        if i and (count >= per_page or u.start - units[i - 1].end > 2.0):
            page += 1
            count = 0
        out.append(page)
        count += 1
    return out


# -- building -------------------------------------------------------------------------------

def build(lyrics: Lyrics, W: int, H: int) -> str:
    """ASS script for the whole song, in song time (the compositor shifts the
    canvas' timestamps to song time, so every render window shares one script
    and animations carry on across window edges)."""
    s = lyrics.style
    units = _units(lyrics, W)
    rh = s.size * s.line_spacing
    pages = _pages(units, max(1, s.lines_shown)) if s.layout == "page" else []
    tr = s.transition_ms / 1000

    # time slices: between every show / hide
    cuts = sorted({max(0.0, t) for u in units for t in (u.show, u.hide)} | {0.0})

    def current(t: float) -> Optional[int]:
        best = None
        for i, u in enumerate(units):
            if u.show <= t + 1e-6:
                if t < u.hide - 1e-6:
                    best = i
            else:
                break
        return best

    def visible(c: int) -> tuple[list[int], int]:
        """Units shown while ``c`` is current, and the row the block hangs from."""
        n = max(1, s.lines_shown)
        if s.layout == "stack":
            return list(range(c, min(len(units), c + n))), c
        if s.layout == "scroll":
            k = (n - 1) // 2
            return [i for i in range(c - k, c - k + n) if 0 <= i < len(units)], c
        if s.layout == "page":
            return [i for i in range(len(units)) if pages[i] == pages[c]], c
        return [c], c

    x = W / 2 if s.align == "center" else W * (1 - s.width) / 2 if s.align == "left" else W - W * (1 - s.width) / 2
    an = {"left": 7, "center": 8, "right": 9}[s.align]
    anchor_y = H * s.margin if s.anchor == "top" else H / 2 if s.anchor == "middle" else H * (1 - s.margin)

    def place(vis: list[int], c: int) -> dict[tuple[int, int], float]:
        """Top y of each visible row."""
        rows = [(i, r) for i in vis for r in range(len(units[i].rows))]
        total = len(rows) * rh
        if s.layout == "scroll":
            # the current line's middle sits at the anchor
            before = sum(len(units[i].rows) for i in vis if i < c)
            top = anchor_y - (before + len(units[c].rows) / 2) * rh
        elif s.anchor == "top":
            top = anchor_y
        elif s.anchor == "middle":
            top = anchor_y - total / 2
        else:
            top = anchor_y - total
        return {key: top + j * rh + (rh - s.size) / 2 for j, key in enumerate(rows)}

    # slices with what's on screen
    slices: list[tuple[float, float, Optional[int], dict[tuple[int, int], float]]] = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < 1e-4:
            continue
        c = current((a + b) / 2)
        if c is None:
            slices.append((a, b, None, {}))
            continue
        vis, anchor = visible(c)
        slices.append((a, b, c, place(vis, anchor)))

    events: list[str] = []
    for k, (a, b, c, pos) in enumerate(slices):
        if c is None:
            continue
        prev = slices[k - 1] if k and abs(slices[k - 1][1] - a) < 1e-6 else None
        nxt = slices[k + 1] if k + 1 < len(slices) and abs(slices[k + 1][0] - b) < 1e-6 else None
        for key, y in pos.items():
            ui, ri = key
            u = units[ui]
            state = "current" if ui == c else ("past" if ui < c else "upcoming")
            old_y = prev[3].get(key) if prev else None
            entering = old_y is None
            leaving = not nxt or key not in nxt[3]
            move = None
            if old_y is not None and abs(old_y - y) > 0.5 and tr > 0:
                move = (old_y, y)
            for layer in ((0, 1) if s.box != "none" else (1,)):
                zoom = round(min(tr, b - a) * 1000) if entering and s.line_in == "zoom" else 0
                body = _row_text(s, u, ri, state, a, layer, zoom)
                if body is None:
                    continue
                head = _placement(s, x, y, an, move, tr, entering, b - a)
                events.append(f"Dialogue: {layer},{_ts(a)},{_ts(b)},{'Box' if layer == 0 else 'Main'},,0,0,0,,"
                              f"{{{head}}}{body}")
                if leaving and tr > 0 and s.line_out != "none":
                    out_state = "leaving" if state == "current" else state
                    out_body = _row_text(s, u, ri, out_state, b, layer)
                    if out_body is not None:
                        events.append(
                            f"Dialogue: {layer},{_ts(b)},{_ts(b + tr)},{'Box' if layer == 0 else 'Main'},,0,0,0,,"
                            f"{{{_leave(s, x, y, an, tr)}}}{out_body}")

    return _header(s, W, H) + "\n".join(events) + "\n"


def _placement(s: LyricsStyle, x: float, y: float, an: int, move, tr: float, entering: bool, length: float) -> str:
    tags = [f"\\an{an}"]
    if s.blur:
        tags.append(f"\\blur{s.blur:g}")
    ms = round(min(tr, length) * 1000)
    d = s.size * 0.8
    fx = s.line_in if entering else "none"
    if move:
        tags.append(f"\\move({x:.1f},{move[0]:.1f},{x:.1f},{move[1]:.1f},0,{ms})")
    elif fx in ("slide_up", "slide_down", "slide_left", "drop") and ms:
        dx, dy = {"slide_up": (0, d), "slide_down": (0, -d), "slide_left": (d * 2, 0), "drop": (0, -d * 2)}[fx]
        tags.append(f"\\move({x + dx:.1f},{y + dy:.1f},{x:.1f},{y:.1f},0,{ms})")
    else:
        tags.append(f"\\pos({x:.1f},{y:.1f})")
    if entering and ms and fx != "none":
        tags.append(f"\\fad({ms},0)")
        if fx == "blur":  # (zoom is done per word: see _row_text)
            tags.append(f"\\blur12\\t(0,{ms},\\blur{s.blur:g})")
    return "".join(tags)


def _leave(s: LyricsStyle, x: float, y: float, an: int, tr: float) -> str:
    ms = round(tr * 1000)
    d = s.size * 0.8
    tags = [f"\\an{an}", f"\\fad(0,{ms})"] + ([f"\\blur{s.blur:g}"] if s.blur else [])
    fx = s.line_out
    if fx in ("slide_up", "slide_down", "slide_left", "drop"):
        dx, dy = {"slide_up": (0, -d), "slide_down": (0, d), "slide_left": (-d * 2, 0), "drop": (0, d * 2)}[fx]
        tags.append(f"\\move({x:.1f},{y:.1f},{x + dx:.1f},{y + dy:.1f},0,{ms})")
    else:
        tags.append(f"\\pos({x:.1f},{y:.1f})")
    if fx == "zoom":
        tags.append(f"\\t(0,{ms},\\fscx130\\fscy130)")
    elif fx == "blur":
        tags.append(f"\\t(0,{ms},\\blur12)")
    return "".join(tags)


def _row_text(s: LyricsStyle, u: _Unit, row: int, state: str, ev_start: float, layer: int,
              zoom: int = 0) -> Optional[str]:
    """One row's words with their override tags. ``layer`` 0 = the box behind.
    ``state``: current / past / upcoming / leaving (was current, now going away).
    ``zoom``: ms of a zoom-in at the start (done per word, so word scaling still works)."""
    idx = u.rows[row]
    if layer == 0 and s.box == "line":
        # one box around the whole row
        return "{\\1a&HFF&\\shad0}" + " ".join(_esc(u.words[i].text) for i in idx)
    up, act, past = s.upcoming_color, s.active_color or s.color, s.past_color
    other = s.other_lines_opacity
    parts = []
    if state != "current":
        colour = up if state == "upcoming" else past
        if state == "leaving":
            other = 1.0
        for n, i in enumerate(idx):
            w = _esc(u.words[i].text)
            if layer == 0:
                box_a = _a(s.box_color, other) if s.box == "words" else "&HFF&"
                parts.append(f"{{\\1a&HFF&\\shad0\\3a{box_a}\\fax{_fax(n)}{_zoom(zoom)}}}{w}")
            else:
                parts.append(f"{{\\1c{_c(colour)}\\1a{_a(colour, other)}\\3a{_a(s.outline_color, other)}"
                             f"\\4a{_a(s.shadow_color, other)}{_zoom(zoom)}}}{w}")
        return _join(parts, layer)

    fx = s.word_fx
    words = [u.words[i] for i in idx]
    if fx == "fill" and layer == 1:
        # karaoke wipe: secondary (upcoming) → primary (sung) colour
        cursor = 0.0
        out = [f"{{\\1c{_c(s.color)}\\1a{_a(s.color)}\\2c{_c(up)}\\2a{_a(up)}}}"]
        for n, w in enumerate(words):
            ts = (w.start - ev_start) * 100
            nxt = words[n + 1].start if n + 1 < len(words) else w.end
            te = ((nxt if nxt - w.end < 0.35 else w.end) - ev_start) * 100
            gap = max(0.0, ts - cursor)
            dur = max(0.0, te - max(ts, cursor))
            if gap >= 1:
                out.append(f"{{\\k{round(gap)}}}")
            out.append(f"{{\\kf{round(dur)}{_scale_tags(s, w, ev_start, zoom)}}}{_esc(w.text)}")
            out.append(" " if n + 1 < len(words) else "")
            cursor += gap + dur
        return "".join(out)

    for n, w in enumerate(words):
        ts = round((w.start - ev_start) * 1000)
        te = round((w.end - ev_start) * 1000)
        text = _esc(w.text)
        if layer == 0:
            if s.box == "words":
                hidden = fx == "reveal" and ts > 0
                parts.append(f"{{\\1a&HFF&\\shad0\\3c{_c(s.box_color)}\\fax{_fax(n)}"
                             + (f"\\3a&HFF&\\t({ts},{ts + 60},\\3a{_a(s.box_color)})" if hidden
                                else f"\\3a{_a(s.box_color)}")
                             + f"{_scale_tags(s, w, ev_start, zoom)}}}{text}")
            else:  # active: only while the word is sung
                bc = s.active_box_color or s.box_color
                on = ts <= 0 < te
                parts.append(f"{{\\1a&HFF&\\shad0\\3c{_c(bc)}\\3a{_a(bc) if on else '&HFF&'}\\fax{_fax(n)}"
                             + (f"\\t({ts},{ts + 1},\\3a{_a(bc)})" if ts > 0 else "")
                             + (f"\\t({te},{te + 1},\\3a&HFF&)" if te > 0 else "")
                             + f"{_scale_tags(s, w, ev_start, zoom)}}}{text}")
            continue
        parts.append("{" + _word_tags(s, w, ts, te, up, act, past) + _scale_tags(s, w, ev_start, zoom) + "}" + text)
    return _join(parts, layer)


def _join(parts: list[str], layer: int) -> str:
    # spaces between words carry no box
    sep = "{\\3a&HFF&} " if layer == 0 else " "
    return sep.join(parts)


def _fax(n: int) -> str:
    # a vanishing shear that differs per word, so libass boxes each word separately
    return "0" if n % 2 == 0 else "0.00001"


def _word_tags(s: LyricsStyle, w: _Word, ts: int, te: int, up: str, act: str, past: str) -> str:
    fx = s.word_fx
    if fx == "none":
        return f"\\1c{_c(s.color)}\\1a{_a(s.color)}"

    def colour_at(c: str) -> str:
        return f"\\1c{_c(c)}\\1a{_a(c)}"

    if fx == "glow":
        act = s.color  # the halo carries the active colour
    # the state at the start of the event
    start = act if ts <= 0 < te else past if te <= 0 else up
    tags = [colour_at(start)]
    if fx == "reveal":
        if ts > 0:
            tags = [colour_at(act), "\\alpha&HFF&", f"\\t({ts},{ts + 60},\\alpha&H00&{_alpha_fix(act)})"]
        if te > 0:
            tags.append(f"\\t({te},{te + 1},{colour_at(past)})")
        return "".join(tags)
    ramp = 200 if fx in ("fade", "glow") else 1
    if ts > 0:
        tags.append(f"\\t({ts},{ts + ramp},{colour_at(act)})")
    if te > 0:
        tags.append(f"\\t({te},{te + ramp},{colour_at(past)})")
    if fx == "glow":
        # a soft halo in the active colour around the sung word
        g = max(3.0, s.outline * 2)
        halo = s.active_color or "#7c5cff"
        base = f"\\3c{_c(s.outline_color)}\\3a{_a(s.outline_color)}\\bord{s.outline:g}\\blur{s.blur:g}"
        lit = f"\\3c{_c(halo)}\\3a{_a(halo, 0.75)}\\bord{g:g}\\blur{max(5.0, s.blur + g * 1.5):g}"
        tags.append(lit if ts <= 0 < te else base)
        if ts > 0:
            tags.append(f"\\t({ts},{ts + 150},{lit})")
        if te > 0:
            tags.append(f"\\t({te},{te + 250},{base})")
    return "".join(tags)


def _alpha_fix(c: str) -> str:
    # \alpha sets every component; put the fill's own alpha back
    return f"\\1a{_a(c)}"


def _zoom(ms: int, scale: float = 100) -> str:
    if not ms:
        return ""
    return f"\\fscx{scale * 0.4:g}\\fscy{scale * 0.4:g}\\t(0,{ms},\\fscx{scale:g}\\fscy{scale:g})"


def _scale_tags(s: LyricsStyle, w: _Word, ev_start: float, zoom: int = 0) -> str:
    """Size of the word over time (pop / bounce / a bigger sung word), after an
    optional zoom-in of the whole row."""
    tags = _word_scale(s, w, ev_start)
    if not zoom:
        return tags
    m = re.match(r"\\fscx([\d.]+)\\fscy([\d.]+)", tags)
    start = float(m.group(1)) if m else 100.0
    return _zoom(zoom, start) + (tags[m.end():] if m else tags)


def _word_scale(s: LyricsStyle, w: _Word, ev_start: float) -> str:
    ts = round((w.start - ev_start) * 1000)
    te = round((w.end - ev_start) * 1000)
    big = 100 * s.active_scale
    fx = s.word_fx
    if fx == "pop":
        peak = big * 1.3
        if te <= 0:
            return "\\fscx100\\fscy100"
        start = f"\\fscx{big:g}\\fscy{big:g}" if ts <= 0 else "\\fscx100\\fscy100"
        t = f"\\t({ts},{ts + 90},\\fscx{peak:g}\\fscy{peak:g})\\t({ts + 90},{ts + 220},\\fscx{big:g}\\fscy{big:g})" if ts > 0 else ""
        return start + t + f"\\t({te},{te + 150},\\fscx100\\fscy100)"
    if fx == "bounce":
        if te <= 0 or ts <= 0:
            return "\\fscx100\\fscy100"
        return (f"\\fscx100\\fscy100\\t({ts},{ts + 100},\\fscx92\\fscy128)"
                f"\\t({ts + 100},{ts + 240},\\fscx{big:g}\\fscy{big:g})\\t({te},{te + 150},\\fscx100\\fscy100)")
    if abs(s.active_scale - 1) > 1e-3:
        if te <= 0:
            return "\\fscx100\\fscy100"
        start = f"\\fscx{big:g}\\fscy{big:g}" if ts <= 0 else "\\fscx100\\fscy100"
        t = f"\\t({ts},{ts + 120},\\fscx{big:g}\\fscy{big:g})" if ts > 0 else ""
        return start + t + f"\\t({te},{te + 150},\\fscx100\\fscy100)"
    return ""


def _header(s: LyricsStyle, W: int, H: int) -> str:
    bold = -1 if s.bold else 0
    italic = -1 if s.italic else 0
    main = (f"Style: Main,{s.font},{s.size},{_style_colour(s.color)},{_style_colour(s.upcoming_color)},"
            f"{_style_colour(s.outline_color)},{_style_colour(s.shadow_color)},{bold},{italic},0,0,100,100,"
            f"{s.letter_spacing:g},0,1,{s.outline:g},{s.shadow:g},8,0,0,0,1")
    box = (f"Style: Box,{s.font},{s.size},&HFF000000,&HFF000000,{_style_colour(s.box_color)},&HFF000000,"
           f"{bold},{italic},0,0,100,100,{s.letter_spacing:g},0,3,{s.box_padding:g},0,8,0,0,0,1")
    head = (
        "[Script Info]\nScriptType: v4.00+\n"
        f"PlayResX: {W}\nPlayResY: {H}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"{main}\n{box}\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    return head


def write(lyrics: Lyrics, W: int, H: int) -> Path:
    """The script (cached by what it's made from)."""
    src = f"{VERSION}|{W}x{H}|{lyrics.model_dump_json()}"
    key = hashlib.sha1(src.encode()).hexdigest()[:20]
    d = config.DATA_DIR / "cache" / "lyrics"
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{key}.ass"
    if not path.is_file():
        script = build(lyrics, W, H)
        tmp = path.with_suffix(f".{threading.get_ident()}.tmp")
        tmp.write_text(script, encoding="utf-8")
        tmp.replace(path)
    return path


def fonts_dir() -> Optional[Path]:
    """Extra font folder for libass (the app's own fonts; system fonts come via fontconfig)."""
    d = config.FONT_DIRS[0]
    return d if d.is_dir() else None
