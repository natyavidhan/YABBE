"""Timeline → FFmpeg command compiler.

One function, :func:`build`, turns a window ``[t0, t1)`` of a project timeline
into ffmpeg input arguments plus a ``-filter_complex`` graph producing
``[vout]`` and/or ``[aout]``. Frames, preview segments and exports all use it,
so what you see while editing is what you get in the export.

Geometry (project pixels, later multiplied by ``scale``):
  * crop is applied to the source first (fractions of the source size)
  * media is "contain"-fitted to the canvas, text keeps its rasterised size
  * the result is multiplied by ``transform.scale``, flipped, rotated and faded
  * its centre is placed at canvas centre + (transform.x, transform.y)
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .. import config
from ..models import Asset, ChromaKey, Clip, Keyframe, Project
from . import keyframes, media, nested, prerender, text, trackapply, transitions
from .cmdfile import Commands as _Commands

EPS = 1e-6
AUDIO_RATE = 48000


@dataclass
class Window:
    t0: float
    t1: float
    scale: float = 1.0  # output size = project size * scale
    use_proxies: bool = False
    video: bool = True
    audio: bool = True

    @property
    def duration(self) -> float:
        return max(0.0, self.t1 - self.t0)


@dataclass
class Graph:
    inputs: list[str] = field(default_factory=list)
    filters: list[str] = field(default_factory=list)
    width: int = 0
    height: int = 0
    has_video: bool = False
    has_audio: bool = False
    _n: int = 0

    def add_input(self, *args: str) -> int:
        self.inputs.extend(args)
        self._n += 1
        return self._n - 1

    def args(self) -> list[str]:
        out = list(self.inputs)
        if self.filters:
            graph = ";".join(self.filters)
            if len(graph) > 60_000:  # one argument may not exceed 128 KB: pass a file instead
                d = config.DATA_DIR / "cache" / "cmd"
                d.mkdir(parents=True, exist_ok=True)
                path = d / (hashlib.sha1(graph.encode()).hexdigest()[:20] + ".graph")
                if not path.is_file():
                    path.write_text(graph)
                out += ["-/filter_complex", str(path)]
            else:
                out += ["-filter_complex", graph]
        if self.has_video:
            out += ["-map", "[vout]"]
        if self.has_audio:
            out += ["-map", "[aout]"]
        return out


@dataclass
class LayerGeometry:
    width: float  # final (pre-rotation) size, project pixels
    height: float
    cx: float  # centre, project pixels
    cy: float


def _even(v: float) -> int:
    return max(2, int(round(v / 2)) * 2)


def _num(v: float) -> str:
    return f"{v:.6f}".rstrip("0").rstrip(".") or "0"


def ffmpeg_color(color: str) -> str:
    c = (color or "#000000").strip()
    if re.fullmatch(r"#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", c):
        return "0x" + c.lstrip("#")
    return "black"


def source_size(project: Project, clip: Clip, u: float = 0.0) -> Optional[tuple[int, int]]:
    if clip.type == "sequence":
        child = project.sequence(clip.sequence_id)
        return (child.settings.width, child.settings.height) if child else None
    if clip.type == "text":
        if clip.text is None:
            return None
        return text.measure(keyframes.text_style_at(clip, u))
    asset = project.asset(clip.asset_id)
    if asset is None or not asset.width or not asset.height:
        return None
    return asset.width, asset.height


def base_size(
    project: Project, clip: Clip, u: float = 0.0, size: Optional[tuple[int, int]] = None
) -> Optional[tuple[float, float]]:
    """Layer size at scale 1: cropped source, contain-fitted (text: natural size)."""
    size = size or source_size(project, clip, u)
    if size is None:
        return None
    sw, sh = size
    cw, ch = sw * clip.crop.width_fraction(), sh * clip.crop.height_fraction()
    W, H = project.settings.width, project.settings.height
    fit = 1.0 if clip.type == "text" else min(W / cw, H / ch)
    return cw * fit, ch * fit


def layer_geometry(project: Project, clip: Clip, u: float = 0.0) -> Optional[LayerGeometry]:
    """Geometry at clip-local time ``u`` (keyframes applied)."""
    base = base_size(project, clip, u)
    if base is None:
        return None
    val = lambda p: prop_value(clip, p, u)  # noqa: E731
    s = val("scale")
    W, H = project.settings.width, project.settings.height
    return LayerGeometry(base[0] * s, base[1] * s, W / 2 + val("x"), H / 2 + val("y"))


def prop_value(clip: Clip, prop: str, u: float) -> float:
    frames = clip.animated(prop)
    return keyframes.value_at(frames, u) if frames else clip.static_value(prop)


def _atempo_chain(speed: float) -> list[str]:
    chain, s = [], speed
    while s > 2.0 + EPS:
        chain.append("atempo=2.0")
        s /= 2.0
    while s < 0.5 - EPS:
        chain.append("atempo=0.5")
        s /= 0.5
    if abs(s - 1.0) > EPS:
        chain.append(f"atempo={_num(s)}")
    return chain


@dataclass
class _Visible:
    clip: Clip
    offset: float  # where it starts inside the window (s, timeline time)
    into: float  # how far into the clip the window starts (s, timeline time)
    length: float  # visible length (s, timeline time)

    @property
    def src_in(self) -> float:
        return self.clip.in_point + self.into * self.clip.speed

    @property
    def src_len(self) -> float:
        return self.length * self.clip.speed


def _visible(clip: Clip, win: Window) -> Optional[_Visible]:
    a, b = max(clip.start, win.t0), min(clip.end, win.t1)
    if b - a <= EPS:
        return None
    return _Visible(clip, a - win.t0, a - clip.start, b - a)


def _prop(clip: Clip, prop: str, vis: "_Visible", single_frame: bool) -> tuple[float, Optional[list[Keyframe]]]:
    """(constant, None) when the property doesn't change inside the visible
    window, else (value at window start, keyframes) for a per-frame curve."""
    frames = clip.animated(prop)
    if not frames:
        return clip.static_value(prop), None
    u0, u1 = vis.into, vis.into + vis.length
    if single_frame or len(frames) == 1 or u0 >= frames[-1].t or u1 <= frames[0].t:
        return keyframes.value_at(frames, u0), None
    return keyframes.value_at(frames, u0), frames


def _signed(v: float) -> str:
    return ("+" if v >= 0 else "-") + _num(abs(v))


def _path_for(project: Project, asset: Asset, win: Window) -> Optional[Path]:
    p = media.preview_source(project.id, asset) if win.use_proxies else media.source_path(project.id, asset)
    return p if p.is_file() else None


@dataclass
class _Plan:
    """An active transition: A's end cut into B, occupying [a, b] on the timeline."""

    track_id: str
    A: Clip
    B: Clip
    a: float
    b: float
    kind: str
    audio: bool = True


def plan_transitions(project: Project) -> list[_Plan]:
    """Transitions whose clips actually touch (same track, B starts at A's end)."""
    fps = project.settings.fps
    by_track: dict[str, list[Clip]] = {}
    for c in project.clips:
        if c.is_visual:
            by_track.setdefault(c.track_id, []).append(c)
    plans = []
    for tid, lst in by_track.items():
        lst.sort(key=lambda c: c.start)
        for A, B in zip(lst, lst[1:]):
            if A.transition is None or abs(B.start - A.end) > 0.5 / fps:
                continue
            d = min(A.transition.duration, A.duration, B.duration)
            if d < 1 / fps:
                continue
            plans.append(_Plan(tid, A, B, A.end - d / 2, A.end + d / 2, A.transition.kind, A.transition.audio))
    return plans


def _nested_asset(project: Project, clip: Clip, stack: tuple[str, ...]) -> Optional[Asset]:
    """A virtual asset describing a nested sequence (None if missing / a loop)."""
    child = project.sequence(clip.sequence_id)
    if child is None or child.id in stack:
        return None
    return Asset(
        id=f"seq:{child.id}", kind="video", filename="", original_name=child.name, status="ready",
        duration=child.duration, width=child.settings.width, height=child.settings.height, fps=child.settings.fps,
        has_video=True, has_audio=nested.has_audio(project, child.id),
    )


def _nested_height(project: Project, clip: Clip, win: Window) -> int:
    """Resolution to render a nested sequence at: what the parent will show."""
    child = project.sequence(clip.sequence_id)
    assert child is not None
    st = project.settings
    fit = min(st.width / child.settings.width, st.height / child.settings.height)
    frames = clip.animated("scale")
    scale = max([k.v for k in frames] + [clip.transform.scale]) if frames else clip.transform.scale
    return nested.render_height(child.settings.height, child.settings.height * fit * max(1.0, scale) * win.scale)


def _add_video_input(
    g: Graph, project: Project, clip: Clip, asset: Optional[Asset], vis: _Visible, win: Window,
    single_frame: bool, extend: bool = False, stack: tuple[str, ...] = (),
) -> Optional[tuple[int, list[str], Optional[tuple[int, int]]]]:
    """Add the input for a clip's picture. Returns (input index, filters to run
    right after timing is normalised, text canvas size). With ``extend`` the clip
    may be asked for time before its start / after its end (transitions): real
    footage is used where it exists, otherwise the edge frame is held."""
    fps = project.settings.fps
    if clip.type == "sequence":
        return _add_nested_input(g, project, clip, asset, vis, win, single_frame, stack)
    if clip.type == "text":
        if clip.text is None:
            return None
        if clip.text_animated and not single_frame:
            n = max(1, math.ceil(vis.length * fps)) + 1
            styles = [keyframes.text_style_at(clip, vis.into + i / fps) for i in range(n)]
            seq, cw, ch = text.animated_sequence(styles, fps)
            return g.add_input("-f", "concat", "-safe", "0", "-i", str(seq)), [], (cw, ch)
        png, _, _ = text.render_text(keyframes.text_style_at(clip, vis.into))
        return g.add_input("-loop", "1", "-framerate", _num(fps), "-t", _num(vis.length + 1 / fps), "-i", str(png)), [], None
    if asset is None:
        return None
    path = _path_for(project, asset, win)
    if path is None:
        return None
    if asset.kind == "image":
        return g.add_input("-loop", "1", "-framerate", _num(fps), "-t", _num(vis.length + 1 / fps), "-i", str(path)), [], None
    pad = 2 / fps * clip.speed
    if not extend:
        return g.add_input("-ss", _num(vis.src_in), "-t", _num(vis.src_len + pad), "-i", str(path)), [], None
    # Transition: clamp the read to real footage and hold edge frames for the rest.
    want = vis.src_in
    last = max(0.0, asset.duration - 1 / fps)
    start = min(max(want, 0.0), last)
    pre = max(0.0, (start - want) / clip.speed)  # timeline seconds to hold the first frame
    read = max(1 / fps * clip.speed, min(vis.src_len - pre * clip.speed, asset.duration - start))
    post = max(0.0, vis.length - pre - read / clip.speed) + 2 / fps
    extra = []
    if pre > 0 or post > 0:
        extra.append(
            f"tpad=start_mode=clone:start_duration={pre:.4f}:stop_mode=clone:stop_duration={post:.4f}"
        )
    return g.add_input("-ss", _num(start), "-t", _num(read + pad), "-i", str(path)), extra, None


def _add_nested_input(
    g: Graph, project: Project, clip: Clip, asset: Optional[Asset], vis: _Visible, win: Window,
    single_frame: bool, stack: tuple[str, ...],
) -> Optional[tuple[int, list[str], Optional[tuple[int, int]]]]:
    """Input for a nested sequence: a rendered still or range of the child."""
    if asset is None:
        return None
    fps = project.settings.fps
    height = _nested_height(project, clip, win)
    draft = win.use_proxies
    if single_frame and prerender.usable(project, clip.sequence_id, height, draft) is None:
        png = nested.render_still(project, clip.sequence_id, max(0.0, vis.src_in), height, draft, stack)
        if png is None:
            return None
        return g.add_input("-loop", "1", "-framerate", _num(fps), "-t", _num(vis.length + 1 / fps), "-i", str(png)), [], None
    # Clamp to the child's own timeline and hold edge frames beyond it (as for footage).
    want = vis.src_in
    child_fps = asset.fps or fps
    last = max(0.0, asset.duration - 1 / child_fps)
    start = min(max(want, 0.0), last)
    pre = max(0.0, (start - want) / clip.speed)
    read = max(1 / child_fps * clip.speed, min(vis.src_len - pre * clip.speed, asset.duration - start))
    post = max(0.0, vis.length - pre - read / clip.speed) + 2 / fps
    src = nested.render_range(project, clip.sequence_id, start, read + 2 / child_fps, height, draft, stack)
    if src is None:
        return None
    extra = []
    if pre > 0 or post > 0:
        extra.append(f"tpad=start_mode=clone:start_duration={pre:.4f}:stop_mode=clone:stop_duration={post:.4f}")
    seek = ["-ss", _num(src.offset)] if src.offset > 0 else []
    return g.add_input(*seek, "-t", _num(read + 2 / child_fps), "-i", str(src.path)), extra, None


def _key_filters(key: ChromaKey, idx: int) -> list[str]:
    """Colour-difference keyer with unmixing (the Keylight / Nuke IBK approach).

    * Matte: how much more of the screen's primary colour a pixel has than the
      other two, relative to the screen itself: 1 - (P - (O1 + O2) / 2) / D,
      then clip black / white levels. Keeps hair, motion blur and soft edges
      far better than a colour-distance key.
    * Unmix: semi-transparent pixels are part screen, so the screen's share,
      (1 - alpha) * screen colour, is subtracted and the rest divided by alpha:
      the true foreground colour (no green fringe).
    * Despill (strength-controlled) removes the screen's cast from opaque parts.

    Measured on this project's test set against a ground-truth matte: about
    half the edge error of FFmpeg's chromakey, and faster (all per-pixel
    linear maths: colour mixer, LUTs and blend).
    """
    rgb = [int(key.color[i:i + 2], 16) for i in (1, 3, 5)]
    p = 2 if rgb[2] > rgb[1] else 1  # primary: green (1) or blue (2)
    others = [c for c in (0, 1, 2) if c != p]
    diff = max(12.0, rgb[p] - 0.5 * (rgb[others[0]] + rgb[others[1]])) / 255
    coef = {c: (1 / diff if c == p else -0.5 / diff) for c in (0, 1, 2)}
    lo, hi = key.clip_black, max(key.clip_black + 0.02, key.clip_white)
    i, k, a1, a2, a3, q, g, pm, ag, f = (f"{n}{idx}" for n in ("ki", "kk", "ka", "kb", "kc", "kq", "kg", "kp", "kn", "kf"))
    sr, sg, sb = (_num(v / 255) for v in rgb)
    out = [
        "format=rgba",
        f"split=2[{i}][{k}];"
        # matte (0..1 in the alpha plane), then clip levels
        f"[{k}]colorchannelmixer=aa=0:ar={_num(coef[0])}:ag={_num(coef[1])}:ab={_num(coef[2])},"
        f"lutrgb=a='clip((maxval-val-{_num(lo)}*maxval)/{_num(hi - lo)},0,maxval)',"
        f"alphaextract,split=3[{a1}][{a2}][{a3}];"
        # unmix: F = (I - (1 - alpha) * screen) / alpha
        f"[{a1}]negate,format=rgb24,colorchannelmixer=rr={sr}:gg={sg}:bb={sb},format=gbrp[{q}];"
        f"[{i}]format=gbrp[{g}];[{g}][{q}]blend=all_mode=subtract[{pm}];"
        f"[{a2}]format=gbrp[{ag}];[{pm}][{ag}]blend=all_mode=divide[{f}];"
        f"[{f}][{a3}]alphamerge",
        "format=rgba",
    ]
    kind = "blue" if p == 2 else "green"
    if key.spill > EPS:
        # despill mix=1 limits green (blue) to max(red, blue) - the usual limiter;
        # strength crossfades between the unmixed and the despilled colour.
        if key.spill >= 1 - EPS:
            out.append(f"despill=type={kind}:mix=1:expand=0")
        else:
            s_ = _num(key.spill)
            o, d, x = f"ko{idx}", f"kd{idx}", f"kx{idx}"
            out.append(
                f"split=2[{o}][{d}];[{d}]despill=type={kind}:mix=1:expand=0[{x}];"
                f"[{o}][{x}]blend=all_expr='A*(1-{s_})+B*{s_}'"
            )
    if key.choke > EPS or key.feather > EPS:
        out.append("format=gbrap")  # planar: the alpha plane is plane 3
        # 3x3 erosion per pass; thresholds 0 leave the colour planes untouched.
        out += ["erosion=threshold0=0:threshold1=0:threshold2=0"] * round(key.choke)
        if key.feather > EPS:
            out.append(f"gblur=sigma={_num(key.feather / 2)}:planes=8")
    if key.matte:
        out += ["format=gbrap", "alphaextract", "format=gray"]  # pinned: blend leaves it ambiguous
    out.append("format=rgba")
    return out


def _ramp_expr(values: list[float], tol: float = 0.05) -> str:
    """A per-frame series as a compact FFmpeg expression of the frame number
    ``in``: piecewise-linear knots (Ramer-Douglas-Peucker, within ``tol``)
    written as a flat sum of ramps (no deep nesting)."""
    n = len(values)
    keep = {0, n - 1}
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        va, vb = values[a], values[b]
        worst, at = 0.0, -1
        for i in range(a + 1, b):
            d = abs(values[i] - (va + (vb - va) * (i - a) / (b - a)))
            if d > worst:
                worst, at = d, i
        if worst > tol:
            keep.add(at)
            stack += [(a, at), (at, b)]
    knots = sorted(keep)
    expr = f"{values[0]:.3f}"
    for a, b in zip(knots, knots[1:]):
        slope = (values[b] - values[a]) / (b - a)
        if abs(slope) > 1e-9:
            expr += f"{slope:+.5f}*clip(in-{a},0,{b - a})"
    return expr


def _pinned_layer(g: Graph, idx: int, chain: list[str], sendcmd_at: int, corners: list, win: "Window", fps: float,
                  op0: float, op_kf, sample, cmds: "_Commands", label: str) -> tuple[str, str, str, str]:
    """Corner pin: the (cropped / keyed) picture stretched onto the tracked
    quad, per frame, on a canvas-sized transparent layer placed at 0,0."""
    import cv2  # only needed here
    import numpy as np

    W, H = g.width, g.height
    k = win.scale
    # The picture fills [2, W-2] x [2, H-2] of a W x H frame with a transparent
    # border, so the edges perspective() repeats outside the quad are clear.
    inner = np.float32([[2, 2], [W - 2, 2], [W - 2, H - 2], [2, H - 2]])
    outer = np.float32([[0, 0], [W, 0], [W, H], [0, H]]).reshape(-1, 1, 2)
    series: list[list[float]] = [[] for _ in range(8)]
    for quad in corners:
        dst = np.float32([[x * k, y * k] for x, y in quad])
        Hm = cv2.getPerspectiveTransform(inner, dst)
        pts = cv2.perspectiveTransform(outer, Hm).reshape(-1, 2)
        # FFmpeg's corner order: top-left, top-right, bottom-left, bottom-right.
        for j, p in enumerate((pts[0], pts[1], pts[3], pts[2])):
            series[2 * j].append(float(p[0]))
            series[2 * j + 1].append(float(p[1]))
    names = ["x0", "y0", "x1", "y1", "x2", "y2", "x3", "y3"]
    persp = ":".join(f"{nm}='{_ramp_expr(vals)}'" for nm, vals in zip(names, series))
    chain += [
        "format=rgba", f"scale={W - 4}:{H - 4}", "pad=w=iw+4:h=ih+4:x=2:y=2:color=black@0",
        f"fps={_num(fps)}",  # one frame per output frame, so ``in`` counts them
        f"perspective={persp}:sense=destination:eval=frame:interpolation=linear",
        "format=rgba",
    ]
    if op_kf:
        ops = [min(1.0, max(0.0, v)) for v in sample(op_kf)]
        cmds.add(f"colorchannelmixer@op{idx}", "aa", [f"{v:.4f}" for v in ops])
        chain.append(f"colorchannelmixer@op{idx}=aa={ops[0]:.4f}")
    elif op0 < 1:
        chain.append(f"colorchannelmixer=aa={_num(op0)}")
    cmd_file = cmds.write()
    if cmd_file is not None:
        chain.insert(sendcmd_at, f"sendcmd=f='{cmd_file}'")
    g.filters.append(f"[{idx}:v]{','.join(chain)}[{label}]")
    return label, f"overlay@ov{idx}", "0", "0"


def _video_layer(
    g: Graph, project: Project, clip: Clip, vis: _Visible, win: Window, idx: int, pre: list[str],
    text_canvas: Optional[tuple[int, int]], single_frame: bool,
) -> Optional[tuple[str, str, str, str]]:
    """Filter chain for one clip's picture. Returns (label, overlay name, x, y)."""
    st = project.settings
    k = win.scale
    fps = st.fps
    base = base_size(project, clip, vis.into, text_canvas)
    if base is None:
        return None
    label = f"v{idx}"
    scale0, scale_kf = _prop(clip, "scale", vis, single_frame)
    rot0, rot_kf = _prop(clip, "rotation", vis, single_frame)
    op0, op_kf = _prop(clip, "opacity", vis, single_frame)
    x0, x_kf = _prop(clip, "x", vis, single_frame)
    y0, y_kf = _prop(clip, "y", vis, single_frame)
    bw, bh = base[0] * k, base[1] * k
    # Animated properties are sampled once per output frame and sent to the
    # filters as timed commands (exact for any curve shape).
    n = max(1, math.ceil(vis.length * fps)) + 1
    sample = lambda fr: keyframes.samples(fr, vis.into, n, fps)  # noqa: E731
    cmds = _Commands(vis.offset, fps)
    us = [vis.into + i / fps for i in range(n)]

    # Per-frame values (None = constant): keyframes, plus motion from trackers.
    xs = sample(x_kf) if x_kf else None
    ys = sample(y_kf) if y_kf else None
    ss = sample(scale_kf) if scale_kf else None
    rds = sample(rot_kf) if rot_kf else None
    for m in (trackapply.follow_offsets(project, clip, us), trackapply.stabilize_offsets(project, clip, us)):
        if not m:
            continue
        if any(abs(v) > 1e-6 for v in m["dx"] + m["dy"]):
            xs = [(xs[i] if xs else x0) + m["dx"][i] for i in range(n)]
            ys = [(ys[i] if ys else y0) + m["dy"][i] for i in range(n)]
        if any(abs(v) > 1e-6 for v in m["drot"]):
            rds = [(rds[i] if rds else rot0) + m["drot"][i] for i in range(n)]
        if any(abs(v - 1) > 1e-6 for v in m["dscale"]):
            ss = [(ss[i] if ss else scale0) * m["dscale"][i] for i in range(n)]
    if single_frame:  # a still: plain values, no per-frame commands
        x0, y0 = (xs[0] if xs else x0), (ys[0] if ys else y0)
        scale0, rot0 = (ss[0] if ss else scale0), (rds[0] if rds else rot0)
        xs = ys = ss = rds = None

    corners = trackapply.pin_corners(project, clip, us)

    chain = [f"setpts=(PTS-STARTPTS)/{_num(clip.speed)}", *pre, f"setpts=PTS+{_num(vis.offset)}/TB"]
    sendcmd_at = len(chain)
    c = clip.crop
    if not c.is_identity():
        chain.append(
            f"crop=iw*{_num(c.width_fraction())}:ih*{_num(c.height_fraction())}"
            f":iw*{_num(c.left)}:ih*{_num(c.top)}"
        )
    key = clip.chroma_key
    keyed = key is not None and key.enabled and clip.type in ("video", "image", "sequence")
    if keyed:
        chain.extend(_key_filters(key, idx))  # type: ignore[arg-type]
    if corners is not None:
        return _pinned_layer(g, idx, chain, sendcmd_at, corners, win, fps, op0, op_kf, sample, cmds, label)
    tr = clip.transform
    if ss is not None:
        # Animated size, padded onto a fixed transparent canvas so the overlay
        # always receives frames of one size.
        ss = [max(0.001, v) for v in ss]
        lw, lh = _even(bw * max(ss)), _even(bh * max(ss))
        cmds.add(f"scale@s{idx}", "w", [str(_even(bw * v)) for v in ss])
        cmds.add(f"scale@s{idx}", "h", [str(_even(bh * v)) for v in ss])
        chain.append(f"scale@s{idx}=w={_even(bw * ss[0])}:h={_even(bh * ss[0])}")
    else:
        lw, lh = _even(bw * scale0), _even(bh * scale0)
        chain.append(f"scale={lw}:{lh}")
    if tr.flip_h:
        chain.append("hflip")
    if tr.flip_v:
        chain.append("vflip")
    rotating = rds is not None or abs(rot0 % 360) > EPS
    needs_alpha = (
        clip.type in ("image", "text", "sequence") or op0 < 1 or bool(op_kf) or rotating or ss is not None or keyed
    )
    if needs_alpha:
        chain.append("format=rgba")
    if ss is not None:
        chain.append(f"pad=w={lw}:h={lh}:x=(ow-iw)/2:y=(oh-ih)/2:color=black@0:eval=frame")
    if op_kf:
        ops = [min(1.0, max(0.0, v)) for v in sample(op_kf)]
        cmds.add(f"colorchannelmixer@op{idx}", "aa", [f"{v:.4f}" for v in ops])
        chain.append(f"colorchannelmixer@op{idx}=aa={ops[0]:.4f}")
    elif op0 < 1:
        chain.append(f"colorchannelmixer=aa={_num(op0)}")
    if rds is not None:
        side = _even(math.hypot(lw, lh)) + 2
        rs = [math.radians(v) for v in rds]
        cmds.add(f"rotate@r{idx}", "a", [f"{v:.5f}" for v in rs])
        chain.append(f"rotate@r{idx}=a={rs[0]:.5f}:c=0x00000000:ow={side}:oh={side}")
    elif rotating:
        rad = _num(math.radians(rot0))
        chain.append(f"rotate={rad}:c=0x00000000:ow=rotw({rad}):oh=roth({rad})")
    W2, H2 = st.width / 2, st.height / 2
    if xs is not None:
        cmds.add(f"overlay@ov{idx}", "x", [f"{(W2 + v) * k:.2f}-w/2" for v in xs])
    if ys is not None:
        cmds.add(f"overlay@ov{idx}", "y", [f"{(H2 + v) * k:.2f}-h/2" for v in ys])
    ox = f"{(W2 + x0) * k:.2f}-w/2"
    oy = f"{(H2 + y0) * k:.2f}-h/2"
    cmd_file = cmds.write()
    if cmd_file is not None:
        chain.insert(sendcmd_at, f"sendcmd=f='{cmd_file}'")
    g.filters.append(f"[{idx}:v]{','.join(chain)}[{label}]")
    return label, f"overlay@ov{idx}", ox, oy


def _audio_chain(
    g: Graph, clip: Clip, vis: _Visible, idx: int, t0: float = 0.0,
    xfades: tuple[tuple[str, float, float], ...] = (),
) -> str:
    """``xfades``: ("in" | "out", a, b) equal-power crossfades over timeline [a, b]."""
    label = f"a{idx}"
    chain = ["asetpts=PTS-STARTPTS", *_atempo_chain(clip.speed)]
    chain += [
        f"aresample={AUDIO_RATE}",
        "aformat=sample_fmts=fltp:channel_layouts=stereo",
        f"atrim=duration={_num(vis.length)}",
    ]
    o, cd = _num(vis.into), _num(clip.duration)
    vol0, vol_kf = _prop(clip, "volume", vis, False)
    vol = "1" if vol_kf else _num(vol0)
    expr = vol
    if clip.fade_in > EPS:
        expr += f"*max(0,min(1,(t+{o})/{_num(clip.fade_in)}))"
    if clip.fade_out > EPS:
        expr += f"*max(0,min(1,({cd}-t-{o})/{_num(clip.fade_out)}))"
    for kind, a, b in xfades:
        # timeline time of this sample = window start + clip offset in window + t
        prog = f"clip((t+{_num(t0 + vis.offset - a)})/{_num(max(EPS, b - a))},0,1)"
        expr += f"*{'sin' if kind == 'in' else 'cos'}(PI/2*{prog})"
    if expr != vol:
        chain.append(f"volume='{expr}':eval=frame")
    elif not vol_kf:
        chain.append(f"volume={vol}")
    if vol_kf:
        # Keyframed gain, sampled at 100 Hz and applied by command.
        rate = 100.0
        n = max(1, math.ceil(vis.length * rate)) + 1
        gains = keyframes.samples(vol_kf, vis.into, n, rate)
        acmds = _Commands(0.0, rate)
        acmds.add(f"volume@kv{idx}", "volume", [f"{max(0.0, v):.4f}" for v in gains])
        chain.append(f"asendcmd=f='{acmds.write()}'")
        chain.append(f"volume@kv{idx}=volume={max(0.0, gains[0]):.4f}:eval=frame")
    delay_ms = int(round(vis.offset * 1000))
    if delay_ms > 0:
        chain.append(f"adelay={delay_ms}:all=1")
    g.filters.append(f"[{idx}:a]{','.join(chain)}[{label}]")
    return label


# Blend mode -> (ffmpeg blend options, top layer as the first input?). FFmpeg is
# inconsistent about which input is the "top" one, so each mode's order was
# checked against the Photoshop formulas (tests/test_blend.py).
BLEND_MODES: dict[str, tuple[str, bool]] = {
    "darken": ("all_mode=darken", True),
    "multiply": ("all_mode=multiply", True),
    "color_burn": ("all_mode=burn", True),
    "linear_burn": ("all_expr='max(0,A+B-255)'", True),
    "lighten": ("all_mode=lighten", True),
    "screen": ("all_mode=screen", True),
    "color_dodge": ("all_mode=dodge", True),
    "add": ("all_mode=addition", True),
    "overlay": ("all_mode=overlay", False),
    "soft_light": ("all_mode=softlight", False),
    "hard_light": ("all_mode=hardlight", False),
    "vivid_light": ("all_mode=vividlight", True),
    "linear_light": ("all_mode=linearlight", True),
    "pin_light": ("all_mode=pinlight", False),
    "hard_mix": ("all_mode=hardmix", True),
    "difference": ("all_mode=difference", True),
    "exclusion": ("all_mode=exclusion", True),
    "subtract": ("all_mode=subtract", False),
    "divide": ("all_mode=divide", False),
}


def _blend_layer(g: Graph, n: int, current: str, label: str, name: str, ox: str, oy: str, enable: str,
                 mode: str, fps: float, dur: float, transparent: bool) -> str:
    """Composite a layer onto ``current`` with a blend mode; returns the output label.

    The layer is placed on a full-size transparent canvas, blended with the
    whole picture below, and the result is laid over it through the layer's
    own alpha (so opacity, crop and shape still apply). On a transparent
    canvas (nested sequences) the layer shows normally where nothing is
    below it, as in After Effects.
    """
    opts, top_first = BLEND_MODES[mode]
    W, H = g.width, g.height
    fmt = "rgba" if transparent else "yuv420p"
    extra = 1 if transparent else 0
    g.filters.append(f"color=c=black@0:s={W}x{H}:r={_num(fps)}:d={_num(dur)},format=rgba[bc{n}]")
    g.filters.append(
        f"[bc{n}][{label}]{name}=x={ox}:y={oy}:format=rgb:eof_action=pass:{enable},format=gbrap,"
        f"split={2 + extra}[bt{n}][bm{n}]{'[bk' + str(n) + ']' if transparent else ''}"
    )
    g.filters.append(f"[bm{n}]alphaextract[ba{n}]")
    g.filters.append(f"[{current}]format=gbrap,split={2 + extra}[bb{n}][bo{n}]{'[bq' + str(n) + ']' if transparent else ''}")
    pair = f"[bt{n}][bb{n}]" if top_first else f"[bb{n}][bt{n}]"
    g.filters.append(f"{pair}blend={opts},format=gbrp[bl{n}]")
    mixed = f"bl{n}"
    if transparent:
        # Where the canvas below is see-through, use the layer's own colour.
        g.filters.append(f"[bq{n}]alphaextract,format=gbrp[bw{n}]")
        g.filters.append(f"[bk{n}]format=gbrp[bn{n}]")
        g.filters.append(f"[bn{n}][bl{n}][bw{n}]maskedmerge[bv{n}]")
        mixed = f"bv{n}"
    g.filters.append(f"[{mixed}][ba{n}]alphamerge[bx{n}]")
    g.filters.append(f"[bo{n}][bx{n}]overlay=format=rgb:eof_action=pass,format={fmt}[ov{n}]")
    return f"ov{n}"


def build(project: Project, win: Window, stack: tuple[str, ...] = (), transparent: bool = False) -> Graph:
    """``stack``: sequences already being rendered further up (loop guard).
    ``transparent``: no background colour (nested sequences, like After
    Effects precomps) — the result carries alpha."""
    st = project.settings
    g = Graph()
    k = win.scale
    g.width, g.height = _even(st.width * k), _even(st.height * k)
    fps = st.fps
    dur = win.duration
    single_frame = win.duration <= 1.5 / fps
    stack = stack + (project.main_sequence_id,)
    # Track order: tracks[0] is the top layer, so draw from the end of the list.
    track_rank = {t.id: i for i, t in enumerate(project.tracks)}
    tracks = {t.id: t for t in project.tracks}
    clips = [c for c in project.clips if c.track_id in tracks]

    # Transitions take over [a, b] around their cut from the two clips.
    plans = [p for p in plan_transitions(project) if p.track_id in tracks]
    lo: dict[str, float] = {}
    hi: dict[str, float] = {}
    audio_out: dict[str, tuple[float, float]] = {}
    audio_in: dict[str, tuple[float, float]] = {}
    for p in plans:
        hi[p.A.id] = p.a
        lo[p.B.id] = p.b
        if p.audio:
            audio_out[p.A.id] = (p.a, p.b)
            audio_in[p.B.id] = (p.a, p.b)

    # (rank, time, overlay spec, blend mode) — composited bottom track first, then by time.
    items: list[tuple[int, float, str, str, str, str, float, float, str]] = []
    audio_labels: list[str] = []

    for clip in clips:
        track = tracks[clip.track_id]
        if clip.type == "sequence":
            asset = _nested_asset(project, clip, stack)
            if asset is None:
                continue  # missing or would contain itself
        else:
            asset = project.asset(clip.asset_id) if clip.asset_id else None

        # ---- picture ----------------------------------------------------------------
        if win.video and clip.is_visual and not track.hidden and (
            asset is None or asset.has_video or asset.kind == "image" or clip.type == "text"
        ):
            a = max(clip.start, lo.get(clip.id, clip.start), win.t0)
            b = min(clip.end, hi.get(clip.id, clip.end), win.t1)
            if b - a > EPS:
                vis = _Visible(clip, a - win.t0, a - clip.start, b - a)
                inp = _add_video_input(g, project, clip, asset, vis, win, single_frame, stack=stack)
                if inp is not None:
                    idx, pre, canvas = inp
                    layer = _video_layer(g, project, clip, vis, win, idx, pre, canvas, single_frame)
                    if layer is not None:
                        label, name, ox, oy = layer
                        items.append((-track_rank[clip.track_id], clip.start, label, name, ox, oy,
                                      vis.offset, vis.offset + vis.length, clip.blend))

        # ---- sound (crossfades through transitions that have audio on) -------------------
        vol_frames = clip.animated("volume")
        audible = max(kf.v for kf in vol_frames) > 0 if vol_frames else clip.volume > 0
        if (
            win.audio and not track.muted and not clip.muted and audible and not clip.audio_detached
            and clip.type in ("video", "audio", "sequence") and asset is not None and asset.has_audio
        ):
            fade_in = audio_in.get(clip.id)
            fade_out = audio_out.get(clip.id)
            s = max(fade_in[0] if fade_in else clip.start, win.t0)
            e = min(fade_out[1] if fade_out else clip.end, win.t1)
            into = s - clip.start
            src = clip.in_point + into * clip.speed
            if src < 0:  # no footage before the source start: begin later
                s -= src / clip.speed
                into = s - clip.start
                src = 0.0
            if asset.duration > 0:  # ...and none past its end
                e = min(e, s + (asset.duration - src) / clip.speed)
            if clip.type == "sequence":
                if e - s > EPS:
                    avis = _Visible(clip, s - win.t0, into, e - s)
                    pad = 2 / fps * clip.speed
                    src_a = nested.render_range(project, clip.sequence_id, avis.src_in, avis.src_len + pad,
                                                2, win.use_proxies, stack, video=False)
                    if src_a is not None:
                        seek = ["-ss", _num(src_a.offset)] if src_a.offset > 0 else []
                        idx = g.add_input(*seek, "-t", _num(avis.src_len + pad), "-i", str(src_a.path))
                        xf = tuple(x for x in (("in", *fade_in) if fade_in else None,
                                               ("out", *fade_out) if fade_out else None) if x)
                        audio_labels.append(_audio_chain(g, clip, avis, idx, win.t0, xf))
                continue
            path = _path_for(project, asset, win)
            if e - s > EPS and path is not None:
                avis = _Visible(clip, s - win.t0, into, e - s)
                pad = 2 / fps * clip.speed
                idx = g.add_input("-ss", _num(avis.src_in), "-t", _num(avis.src_len + pad), "-i", str(path))
                xf = tuple(x for x in (("in", *fade_in) if fade_in else None, ("out", *fade_out) if fade_out else None) if x)
                audio_labels.append(_audio_chain(g, clip, avis, idx, win.t0, xf))

    # ---- transitions ----------------------------------------------------------------------
    if win.video:
        for n, p in enumerate(plans):
            track = tracks[p.track_id]
            s0, s1 = max(p.a, win.t0), min(p.b, win.t1)
            if track.hidden or s1 - s0 <= EPS:
                continue
            D = p.b - p.a
            fulls = []
            for side, clip in (("a", p.A), ("b", p.B)):
                full = f"tf{n}{side}"
                g.filters.append(
                    f"color=c=black@0:s={g.width}x{g.height}:r={_num(fps)}:d={_num(D)},format=rgba[tc{n}{side}]"
                )
                asset = (_nested_asset(project, clip, stack) if clip.type == "sequence"
                         else project.asset(clip.asset_id) if clip.asset_id else None)
                vis = _Visible(clip, 0.0, p.a - clip.start, D)
                inp = _add_video_input(g, project, clip, asset, vis, win, False, extend=True, stack=stack)
                layer = None
                if inp is not None:
                    idx, pre, canvas = inp
                    layer = _video_layer(g, project, clip, vis, win, idx, pre, canvas, False)
                if layer is None:
                    g.filters.append(f"[tc{n}{side}]null[{full}]")
                else:
                    label, name, ox, oy = layer
                    g.filters.append(
                        f"[tc{n}{side}][{label}]{name}=x={ox}:y={oy}:format=rgb:eof_action=pass,format=rgba[{full}]"
                    )
                fulls.append(full)
            out = f"tx{n}"
            g.filters.extend(
                transitions.build_filters(p.kind, fulls[0], fulls[1], out, D, fps, g.width, g.height, f"{n}")
            )
            g.filters.append(
                f"[{out}]trim=start={s0 - p.a:.6f}:end={s1 - p.a:.6f},"
                f"setpts=PTS-STARTPTS+{s0 - win.t0:.6f}/TB[{out}w]"
            )
            items.append((-track_rank[p.track_id], p.a, f"{out}w", "overlay", "0", "0", s0 - win.t0, s1 - win.t0,
                          p.A.blend if p.A.blend == p.B.blend else "normal"))

    # ---- composite video ------------------------------------------------------------
    if win.video:
        g.has_video = True
        bg = "black@0" if transparent else ffmpeg_color(st.background)
        g.filters.append(
            f"color=c={bg}:s={g.width}x{g.height}:r={_num(fps)}:d={_num(dur)},"
            f"format={'rgba' if transparent else 'yuv420p'}[base]"
        )
        current = "base"
        blend = ":format=rgb" if transparent else ""  # keep the canvas alpha
        items.sort(key=lambda it: (it[0], it[1]))
        for n, (_, _, label, name, ox, oy, a, b, mode) in enumerate(items):
            enable = f"enable='between(t,{_num(a - EPS)},{_num(b - EPS)})'"
            if mode in BLEND_MODES:
                current = _blend_layer(g, n, current, label, name, ox, oy, enable, mode, fps, dur, transparent)
                continue
            out = f"ov{n}"
            g.filters.append(f"[{current}][{label}]{name}=x={ox}:y={oy}{blend}:eof_action=pass:{enable}[{out}]")
            current = out
        g.filters.append(f"[{current}]format={'yuva420p' if transparent else 'yuv420p'}[vout]")

    # ---- mix audio --------------------------------------------------------------------
    if win.audio:
        g.has_audio = True
        g.filters.append(
            f"anullsrc=r={AUDIO_RATE}:cl=stereo,atrim=duration={_num(dur)},aformat=sample_fmts=fltp[abase]"
        )
        if audio_labels:
            ins = "".join(f"[{l}]" for l in ["abase", *audio_labels])
            g.filters.append(
                f"{ins}amix=inputs={len(audio_labels) + 1}:duration=first:normalize=0:dropout_transition=0[aout]"
            )
        else:
            g.filters.append("[abase]anull[aout]")
    return g
