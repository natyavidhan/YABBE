"""Transition catalogue and FFmpeg filter builder.

A transition blends two full-frame RGBA streams of equal length ``D`` (clip A
continuing past the cut, clip B starting before it). Two kinds of recipe:

* **xfade** — FFmpeg's built-in blends/wipes/slides/shapes (fast C code).
* **motion** — per-frame zoom / rotation / blur / colour-shift / brightness /
  shake applied to A, B or the result via timed commands, then blended.

Categories mirror CapCut's transition library (Basic, Camera, Slide, Wipe,
Mask, Blur, Glitch, Light, Distortion).
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Callable, Optional

from .cmdfile import Commands
from .curves import named_ease


@dataclass(frozen=True)
class Spec:
    id: str
    name: str
    category: str
    xfade: str = "fade"  # built-in xfade transition (or "cut" = hard cut at the middle)
    motion: Optional[str] = None
    params: dict = field(default_factory=dict)


def _dirs(prefix: str, name: str, cat: str, xf: str, **kw) -> list[Spec]:
    return [
        Spec(f"{prefix}_{d}", f"{name} {d}", cat, xfade=f"{xf}{d}", **kw)
        for d in ("left", "right", "up", "down")
    ]


CATALOG: list[Spec] = [
    # Basic
    Spec("mix", "Mix", "Basic", "fade"),
    Spec("dissolve", "Dissolve", "Basic", "dissolve"),
    Spec("black_fade", "Black fade", "Basic", "fadeblack"),
    Spec("white_fade", "White fade", "Basic", "fadewhite"),
    Spec("gray_fade", "Monochrome fade", "Basic", "fadegrays"),
    Spec("fade_fast", "Quick fade", "Basic", "fadefast"),
    Spec("fade_slow", "Slow fade", "Basic", "fadeslow"),
    # Camera
    Spec("pull_in", "Pull in", "Camera", motion="pull_in"),
    Spec("pull_out", "Pull out", "Camera", motion="pull_out"),
    Spec("zoom_in", "Zoom in", "Camera", "zoomin"),
    Spec("spin", "Spin", "Camera", motion="spin", params={"dir": 1}),
    Spec("spin_ccw", "Spin left", "Camera", motion="spin", params={"dir": -1}),
    Spec("swing", "Swing", "Camera", motion="swing"),
    Spec("shake", "Shake", "Camera", motion="shake"),
    Spec("swipe_left", "Swipe left", "Camera", "slideleft", motion="whip", params={"axis": "h"}),
    Spec("swipe_right", "Swipe right", "Camera", "slideright", motion="whip", params={"axis": "h"}),
    Spec("swipe_up", "Swipe up", "Camera", "slideup", motion="whip", params={"axis": "v"}),
    Spec("swipe_down", "Swipe down", "Camera", "slidedown", motion="whip", params={"axis": "v"}),
    # Slide
    *_dirs("slide", "Slide", "Slide", "slide"),
    *_dirs("cover", "Cover", "Slide", "cover"),
    *_dirs("reveal", "Reveal", "Slide", "reveal"),
    Spec("squeeze_h", "Squeeze horizontal", "Slide", "squeezeh"),
    Spec("squeeze_v", "Squeeze vertical", "Slide", "squeezev"),
    # Wipe
    *_dirs("wipe", "Wipe", "Wipe", "wipe"),
    *_dirs("soft_wipe", "Soft wipe", "Wipe", "smooth"),
    Spec("wipe_tl", "Corner wipe ↖", "Wipe", "wipetl"),
    Spec("wipe_tr", "Corner wipe ↗", "Wipe", "wipetr"),
    Spec("wipe_bl", "Corner wipe ↙", "Wipe", "wipebl"),
    Spec("wipe_br", "Corner wipe ↘", "Wipe", "wipebr"),
    Spec("diag_tl", "Diagonal ↖", "Wipe", "diagtl"),
    Spec("diag_tr", "Diagonal ↗", "Wipe", "diagtr"),
    Spec("diag_bl", "Diagonal ↙", "Wipe", "diagbl"),
    Spec("diag_br", "Diagonal ↘", "Wipe", "diagbr"),
    Spec("clock", "Clock wipe", "Wipe", "radial"),
    # Mask
    Spec("circle_open", "Circle open", "Mask", "circleopen"),
    Spec("circle_close", "Circle close", "Mask", "circleclose"),
    Spec("circle", "Circle", "Mask", "circlecrop"),
    Spec("rectangle", "Rectangle", "Mask", "rectcrop"),
    Spec("split_open_v", "Split open", "Mask", "vertopen"),
    Spec("split_close_v", "Split close", "Mask", "vertclose"),
    Spec("split_open_h", "Split open horizontal", "Mask", "horzopen"),
    Spec("split_close_h", "Split close horizontal", "Mask", "horzclose"),
    Spec("blinds_left", "Blinds left", "Mask", "hlslice"),
    Spec("blinds_right", "Blinds right", "Mask", "hrslice"),
    Spec("blinds_up", "Blinds up", "Mask", "vuslice"),
    Spec("blinds_down", "Blinds down", "Mask", "vdslice"),
    # Blur
    Spec("blur", "Blur", "Blur", motion="blur"),
    Spec("motion_blur", "Motion blur", "Blur", "hblur"),
    Spec("zoom_blur", "Zoom blur", "Blur", motion="zoom_blur"),
    # Glitch
    Spec("glitch", "Glitch", "Glitch", "cut", motion="glitch"),
    Spec("rgb_split", "RGB split", "Glitch", motion="rgb_split"),
    Spec("mosaic", "Mosaic", "Glitch", "pixelize"),
    # Light
    Spec("flash", "Flash", "Light", motion="flash"),
    Spec("flash_zoom", "Flash zoom", "Light", motion="flash_zoom"),
    # Distortion
    Spec("morph", "Morph", "Distortion", "distance"),
    Spec("wind_left", "Wind left", "Distortion", "hlwind"),
    Spec("wind_right", "Wind right", "Distortion", "hrwind"),
    Spec("wind_up", "Wind up", "Distortion", "vuwind"),
    Spec("wind_down", "Wind down", "Distortion", "vdwind"),
]
BY_ID = {s.id: s for s in CATALOG}
CATEGORIES = ["Basic", "Camera", "Slide", "Wipe", "Mask", "Blur", "Glitch", "Light", "Distortion"]

DEFAULT_DURATION = 0.5
MIN_DURATION = 0.1
MAX_DURATION = 5.0


def catalog_json() -> list[dict]:
    return [{"id": s.id, "name": s.name, "category": s.category} for s in CATALOG]


# -- per-frame motion helpers --------------------------------------------------------------


def _even(v: float) -> int:
    return max(2, int(round(v / 2)) * 2)


class _Motion:
    """Collects filter chains + per-frame command channels for one transition."""

    def __init__(self, uid: str, n: int, W: int, H: int, D: float, fps: float):
        self.uid, self.n, self.W, self.H, self.D, self.fps = uid, n, W, H, D, fps
        self.a: list[str] = []
        self.b: list[str] = []
        self.post: list[str] = []
        self.cmds = {"a": Commands(0.0, fps), "b": Commands(0.0, fps), "post": Commands(0.0, fps)}

    def curve(self, v0: float, v1: float, ease: str = "linear") -> list[float]:
        return [v0 + (v1 - v0) * named_ease(ease, i / max(1, self.n - 1)) for i in range(self.n)]

    def tent(self, peak: float, ease: str = "ease_in_out") -> list[float]:
        """0 → peak at the middle → 0."""
        out = []
        for i in range(self.n):
            p = i / max(1, self.n - 1)
            out.append(peak * named_ease(ease, 1 - abs(2 * p - 1)))
        return out

    def _chain(self, which: str) -> list[str]:
        return {"a": self.a, "b": self.b, "post": self.post}[which]

    def zoom(self, which: str, scales: list[float]) -> None:
        nm = f"scale@tz{which}{self.uid}"
        W, H = self.W, self.H
        self._chain(which).extend([
            f"{nm}=w={_even(W * scales[0])}:h={_even(H * scales[0])}",
            f"pad=w='max(iw,{W})':h='max(ih,{H})':x=(ow-iw)/2:y=(oh-ih)/2:color=black@0:eval=frame",
            f"crop={W}:{H}:(iw-{W})/2:(ih-{H})/2",
        ])
        self.cmds[which].add(nm, "w", [str(_even(W * s)) for s in scales])
        self.cmds[which].add(nm, "h", [str(_even(H * s)) for s in scales])

    def rotate(self, which: str, degrees: list[float]) -> None:
        nm = f"rotate@tr{which}{self.uid}"
        self._chain(which).append(f"{nm}=a={math.radians(degrees[0]):.5f}:c=0x00000000:ow={self.W}:oh={self.H}")
        self.cmds[which].add(nm, "a", [f"{math.radians(d):.5f}" for d in degrees])

    def blur(self, which: str, sigmas: list[float], axis: str = "both") -> None:
        nm = f"gblur@tb{which}{self.uid}"
        if axis == "h":
            self._chain(which).append(f"{nm}=sigma=0.01:sigmaV=0.01")
            self.cmds[which].add(nm, "sigma", [f"{max(0.01, s):.2f}" for s in sigmas])
        elif axis == "v":
            self._chain(which).append(f"{nm}=sigma=0.01:sigmaV=0.01")
            self.cmds[which].add(nm, "sigmaV", [f"{max(0.01, s):.2f}" for s in sigmas])
        else:
            self._chain(which).append(f"{nm}=sigma=0.01")
            self.cmds[which].add(nm, "sigma", [f"{max(0.01, s):.2f}" for s in sigmas])

    def rgbshift(self, which: str, amounts: list[float], jitter: bool = False) -> None:
        nm = f"rgbashift@ts{which}{self.uid}"
        self._chain(which).append(f"{nm}=rh=0:bh=0:edge=smear")
        rnd = random.Random(self.uid)
        rh, bh, gv = [], [], []
        for a in amounts:
            if jitter:
                rh.append(str(int(round(rnd.uniform(-1, 1) * a))))
                bh.append(str(int(round(rnd.uniform(-1, 1) * a))))
            else:
                rh.append(str(int(round(a))))
                bh.append(str(int(round(-a))))
        self.cmds[which].add(nm, "rh", rh)
        self.cmds[which].add(nm, "bh", bh)
        del gv

    def brightness(self, which: str, values: list[float]) -> None:
        nm = f"eq@te{which}{self.uid}"
        self._chain(which).append(f"{nm}=brightness=0")
        self.cmds[which].add(nm, "brightness", [f"{v:.3f}" for v in values])

    def shake(self, which: str, amp_frac: float, freq: float = 1.0) -> None:
        """Camera shake: overscan slightly, then jitter the crop (strongest mid-way)."""
        W, H, D = self.W, self.H, self.D
        over = 1 + 2 * amp_frac + 0.01
        a = f"{amp_frac * W:.2f}*sin(PI*t/{D:.4f})"
        self._chain(which).extend([
            f"scale={_even(W * over)}:{_even(H * over)}",
            f"crop={W}:{H}:x='(iw-ow)/2+{a}*sin(t*{83 * freq:.1f})':y='(ih-oh)/2+{a}*cos(t*{67 * freq:.1f})'",
        ])


MOTIONS: dict[str, Callable[[_Motion, dict], None]] = {}


def _motion(name: str):
    def deco(fn):
        MOTIONS[name] = fn
        return fn
    return deco


@_motion("pull_in")
def _pull_in(m: _Motion, p: dict) -> None:
    s = 0.012 * min(m.W, m.H) * 2
    m.zoom("a", m.curve(1, 1.6, "ease_in"))
    m.blur("a", m.curve(0, s, "ease_in"))
    m.zoom("b", m.curve(1.35, 1, "ease_out"))
    m.blur("b", m.curve(s, 0, "ease_out"))


@_motion("pull_out")
def _pull_out(m: _Motion, p: dict) -> None:
    s = 0.012 * min(m.W, m.H) * 2
    m.zoom("a", m.curve(1, 0.65, "ease_in"))
    m.blur("a", m.curve(0, s, "ease_in"))
    m.zoom("b", m.curve(1.5, 1, "ease_out"))
    m.blur("b", m.curve(s, 0, "ease_out"))


@_motion("zoom_blur")
def _zoom_blur(m: _Motion, p: dict) -> None:
    s = 0.03 * min(m.W, m.H)
    m.zoom("a", m.curve(1, 1.25, "ease_in"))
    m.blur("a", m.curve(0, s, "ease_in"))
    m.zoom("b", m.curve(0.85, 1, "ease_out"))
    m.blur("b", m.curve(s, 0, "ease_out"))


@_motion("spin")
def _spin(m: _Motion, p: dict) -> None:
    d = p.get("dir", 1)
    s = 0.01 * min(m.W, m.H)
    m.zoom("a", m.curve(1, 1.3, "ease_in"))
    m.rotate("a", m.curve(0, 180 * d, "ease_in"))
    m.blur("a", m.curve(0, s, "ease_in"))
    m.zoom("b", m.curve(1.3, 1, "ease_out"))
    m.rotate("b", m.curve(-180 * d, 0, "ease_out"))
    m.blur("b", m.curve(s, 0, "ease_out"))


@_motion("swing")
def _swing(m: _Motion, p: dict) -> None:
    m.zoom("a", m.curve(1, 1.15, "ease_in"))
    m.rotate("a", m.curve(0, 14, "ease_in"))
    m.zoom("b", m.curve(1.15, 1, "ease_out"))
    m.rotate("b", m.curve(-14, 0, "ease_out"))


@_motion("shake")
def _shake(m: _Motion, p: dict) -> None:
    m.shake("post", 0.035)


@_motion("whip")
def _whip(m: _Motion, p: dict) -> None:
    peak = 0.035 * m.W if p.get("axis") == "h" else 0.035 * m.H
    m.blur("post", m.tent(peak), axis=p.get("axis", "h"))


@_motion("blur")
def _blur(m: _Motion, p: dict) -> None:
    s = 0.025 * min(m.W, m.H) * 1.5
    m.blur("a", m.curve(0, s, "ease_in"))
    m.blur("b", m.curve(s, 0, "ease_out"))


@_motion("glitch")
def _glitch(m: _Motion, p: dict) -> None:
    m.rgbshift("post", m.tent(0.03 * m.W, "linear"), jitter=True)
    m.shake("post", 0.02, freq=2.5)


@_motion("rgb_split")
def _rgb_split(m: _Motion, p: dict) -> None:
    m.rgbshift("post", m.tent(0.025 * m.W))


@_motion("flash")
def _flash(m: _Motion, p: dict) -> None:
    m.brightness("post", m.tent(0.75, "ease_out"))


@_motion("flash_zoom")
def _flash_zoom(m: _Motion, p: dict) -> None:
    m.zoom("a", m.curve(1, 1.3, "ease_in"))
    m.zoom("b", m.curve(1.2, 1, "ease_out"))
    m.brightness("post", m.tent(0.7, "ease_out"))


def build_filters(
    kind: str, a_label: str, b_label: str, out_label: str, D: float, fps: float, W: int, H: int, uid: str
) -> list[str]:
    """Filter chains blending ``a_label`` into ``b_label`` (full-frame RGBA streams
    of length D starting at t=0) into ``out_label``."""
    spec = BY_ID.get(kind) or BY_ID["mix"]
    n = max(2, int(round(D * fps)) + 1)
    m = _Motion(uid, n, W, H, D, fps)
    if spec.motion:
        MOTIONS[spec.motion](m, spec.params)
    out: list[str] = []

    def chain(which: str, src: str) -> str:
        filters = m._chain(which)
        if not filters:
            return src
        cmd = m.cmds[which].write()
        pre = [f"sendcmd=f='{cmd}'"] if cmd else []
        lbl = f"{src}_{which}"
        out.append(f"[{src}]{','.join(pre + filters)}[{lbl}]")
        return lbl

    a = chain("a", a_label)
    b = chain("b", b_label)
    # xfade needs a known constant frame rate on both inputs (per-frame scale
    # commands can leave it unset); fps= is a no-op when it already matches.
    for which, lbl in (("a", a), ("b", b)):
        out.append(f"[{lbl}]fps={fps:.6g},setsar=1[{lbl}_cfr]")
    a, b = f"{a}_cfr", f"{b}_cfr"
    mixed = f"{out_label}_mix"
    if spec.xfade == "cut":
        # Hard cut in the middle (glitch-style transitions add their effect on top).
        out.append(f"[{a}][{b}]overlay=0:0:format=rgb:enable='gte(t,{D / 2:.4f})',format=rgba[{mixed}]")
    else:
        out.append(f"[{a}][{b}]xfade=transition={spec.xfade}:duration={D:.4f}:offset=0,format=rgba[{mixed}]")
    post = m._chain("post")
    if post:
        cmd = m.cmds["post"].write()
        pre = [f"sendcmd=f='{cmd}'"] if cmd else []
        out.append(f"[{mixed}]{','.join(pre + post)},format=rgba,setsar=1[{out_label}]")
    else:
        out.append(f"[{mixed}]setsar=1[{out_label}]")
    return out
