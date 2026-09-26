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
from ..models import Asset, Clip, Keyframe, Project
from . import keyframes, media, text

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
            out += ["-filter_complex", ";".join(self.filters)]
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


class _Commands:
    """Per-frame filter commands for one layer, written as a sendcmd file.

    Each channel is a list of values (one per output frame) sent to
    ``target``/``command`` only when the formatted value changes."""

    def __init__(self, start: float, fps: float):
        self.start, self.fps = start, fps
        self.channels: list[tuple[str, str, list[str]]] = []

    def add(self, target: str, command: str, values: list[str]) -> None:
        self.channels.append((target, command, values))

    def write(self) -> Optional[Path]:
        if not self.channels:
            return None
        n = max(len(v) for _, _, v in self.channels)
        last: dict[int, str] = {}
        lines = []
        for i in range(n):
            cmds = []
            for c, (target, command, values) in enumerate(self.channels):
                v = values[min(i, len(values) - 1)]
                if last.get(c) != v:
                    cmds.append(f"{target} {command} {v}")
                    last[c] = v
            if cmds:
                lines.append(f"{self.start + i / self.fps:.6f} " + ", ".join(cmds) + ";")
        body = "\n".join(lines) + "\n"
        d = config.DATA_DIR / "cache" / "cmd"
        d.mkdir(parents=True, exist_ok=True)
        path = d / (hashlib.sha1(body.encode()).hexdigest()[:20] + ".txt")
        if not path.is_file():
            tmp = path.with_suffix(".tmp")
            tmp.write_text(body)
            tmp.replace(path)
        return path


def _path_for(project: Project, asset: Asset, win: Window) -> Optional[Path]:
    p = media.preview_source(project.id, asset) if win.use_proxies else media.source_path(project.id, asset)
    return p if p.is_file() else None


def build(project: Project, win: Window) -> Graph:
    st = project.settings
    g = Graph()
    k = win.scale
    g.width, g.height = _even(st.width * k), _even(st.height * k)
    fps = st.fps
    dur = win.duration
    # Track order: tracks[0] is the top layer, so draw from the end of the list.
    track_rank = {t.id: i for i, t in enumerate(project.tracks)}
    tracks = {t.id: t for t in project.tracks}
    clips = sorted(
        (c for c in project.clips if c.track_id in tracks),
        key=lambda c: (-track_rank[c.track_id], c.start),
    )

    video_labels: list[tuple[str, _Visible, str, str, str]] = []
    single_frame = win.duration <= 1.5 / fps
    audio_labels: list[str] = []

    for clip in clips:
        track = tracks[clip.track_id]
        vis = _visible(clip, win)
        if vis is None:
            continue
        asset = project.asset(clip.asset_id) if clip.asset_id else None
        wants_video = win.video and clip.is_visual and not track.hidden
        vol_frames = clip.animated("volume")
        audible = max(k.v for k in vol_frames) > 0 if vol_frames else clip.volume > 0
        wants_audio = (
            win.audio and not track.muted and not clip.muted and audible
            and clip.type in ("video", "audio") and asset is not None and asset.has_audio
        )
        if not (wants_video or wants_audio):
            continue

        # ---- input ----------------------------------------------------------------
        idx: Optional[int] = None
        text_canvas: Optional[tuple[int, int]] = None
        if clip.type == "text":
            if clip.text is None:
                continue
            if clip.text_animated and not single_frame:
                # Style keyframes: one raster per frame on a fixed-size canvas.
                n = max(1, math.ceil(vis.length * fps)) + 1
                styles = [keyframes.text_style_at(clip, vis.into + i / fps) for i in range(n)]
                seq, cw, ch = text.animated_sequence(styles, fps)
                text_canvas = (cw, ch)
                idx = g.add_input("-f", "concat", "-safe", "0", "-i", str(seq))
            else:
                png, _, _ = text.render_text(keyframes.text_style_at(clip, vis.into))
                idx = g.add_input(
                    "-loop", "1", "-framerate", _num(fps), "-t", _num(vis.length + 1 / fps), "-i", str(png)
                )
        elif asset is not None:
            path = _path_for(project, asset, win)
            if path is None:
                continue
            if asset.kind == "image":
                idx = g.add_input("-loop", "1", "-framerate", _num(fps), "-t", _num(vis.length + 1 / fps), "-i", str(path))
            else:
                # Pad the read a little so rounding never leaves a gap at the end.
                pad = 2 / fps * clip.speed
                idx = g.add_input("-ss", _num(vis.src_in), "-t", _num(vis.src_len + pad), "-i", str(path))
        if idx is None:
            continue

        # ---- video ----------------------------------------------------------------
        if wants_video and (asset is None or asset.has_video or asset.kind == "image" or clip.type == "text"):
            base = base_size(project, clip, vis.into, text_canvas)
            if base is not None:
                label = f"v{idx}"
                scale0, scale_kf = _prop(clip, "scale", vis, single_frame)
                rot0, rot_kf = _prop(clip, "rotation", vis, single_frame)
                op0, op_kf = _prop(clip, "opacity", vis, single_frame)
                x0, x_kf = _prop(clip, "x", vis, single_frame)
                y0, y_kf = _prop(clip, "y", vis, single_frame)
                bw, bh = base[0] * k, base[1] * k
                # Animated properties are sampled once per output frame and sent
                # to the filters as timed commands (exact for any curve shape).
                n = max(1, math.ceil(vis.length * fps)) + 1
                sample = lambda fr: keyframes.samples(fr, vis.into, n, fps)  # noqa: E731
                cmds = _Commands(vis.offset, fps)

                chain = [f"setpts=(PTS-STARTPTS)/{_num(clip.speed)}+{_num(vis.offset)}/TB"]
                sendcmd_at = len(chain)
                c = clip.crop
                if not c.is_identity():
                    chain.append(
                        f"crop=iw*{_num(c.width_fraction())}:ih*{_num(c.height_fraction())}"
                        f":iw*{_num(c.left)}:ih*{_num(c.top)}"
                    )
                tr = clip.transform
                if scale_kf:
                    # Animated size, padded onto a fixed transparent canvas so the
                    # overlay always receives frames of one size.
                    ss = [max(0.001, v) for v in sample(scale_kf)]
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
                rotating = bool(rot_kf) or abs(rot0 % 360) > EPS
                needs_alpha = (
                    clip.type in ("image", "text") or op0 < 1 or bool(op_kf) or rotating or bool(scale_kf)
                )
                if needs_alpha:
                    chain.append("format=rgba")
                if scale_kf:
                    chain.append(f"pad=w={lw}:h={lh}:x=(ow-iw)/2:y=(oh-ih)/2:color=black@0:eval=frame")
                if op_kf:
                    ops = [min(1.0, max(0.0, v)) for v in sample(op_kf)]
                    cmds.add(f"colorchannelmixer@op{idx}", "aa", [f"{v:.4f}" for v in ops])
                    chain.append(f"colorchannelmixer@op{idx}=aa={ops[0]:.4f}")
                elif op0 < 1:
                    chain.append(f"colorchannelmixer=aa={_num(op0)}")
                if rot_kf:
                    side = _even(math.hypot(lw, lh)) + 2
                    rs = [math.radians(v) for v in sample(rot_kf)]
                    cmds.add(f"rotate@r{idx}", "a", [f"{v:.5f}" for v in rs])
                    chain.append(f"rotate@r{idx}=a={rs[0]:.5f}:c=0x00000000:ow={side}:oh={side}")
                elif rotating:
                    rad = _num(math.radians(rot0))
                    chain.append(f"rotate={rad}:c=0x00000000:ow=rotw({rad}):oh=roth({rad})")
                W2, H2 = st.width / 2, st.height / 2
                if x_kf:
                    cmds.add(f"overlay@ov{idx}", "x", [f"{(W2 + v) * k:.2f}-w/2" for v in sample(x_kf)])
                if y_kf:
                    cmds.add(f"overlay@ov{idx}", "y", [f"{(H2 + v) * k:.2f}-h/2" for v in sample(y_kf)])
                ox = f"{(W2 + x0) * k:.2f}-w/2"
                oy = f"{(H2 + y0) * k:.2f}-h/2"
                cmd_file = cmds.write()
                if cmd_file is not None:
                    chain.insert(sendcmd_at, f"sendcmd=f='{cmd_file}'")
                g.filters.append(f"[{idx}:v]{','.join(chain)}[{label}]")
                video_labels.append((label, vis, f"overlay@ov{idx}", ox, oy))

        # ---- audio ----------------------------------------------------------------
        if wants_audio:
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
            audio_labels.append(label)

    # ---- composite video ------------------------------------------------------------
    if win.video:
        g.has_video = True
        g.filters.append(
            f"color=c={ffmpeg_color(st.background)}:s={g.width}x{g.height}:r={_num(fps)}:d={_num(dur)},"
            f"format=yuv420p[base]"
        )
        current = "base"
        for n, (label, vis, name, ox, oy) in enumerate(video_labels):
            out = f"ov{n}"
            a, b = vis.offset, vis.offset + vis.length
            g.filters.append(
                f"[{current}][{label}]{name}=x={ox}:y={oy}"
                f":eof_action=pass:enable='between(t,{_num(a - EPS)},{_num(b - EPS)})'[{out}]"
            )
            current = out
        g.filters.append(f"[{current}]format=yuv420p[vout]")

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
