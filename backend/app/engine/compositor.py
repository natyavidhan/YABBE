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

import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from ..models import Asset, Clip, Project
from . import media, text

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


def source_size(project: Project, clip: Clip) -> Optional[tuple[int, int]]:
    if clip.type == "text":
        if clip.text is None:
            return None
        return text.measure(clip.text)
    asset = project.asset(clip.asset_id)
    if asset is None or not asset.width or not asset.height:
        return None
    return asset.width, asset.height


def layer_geometry(project: Project, clip: Clip) -> Optional[LayerGeometry]:
    size = source_size(project, clip)
    if size is None:
        return None
    sw, sh = size
    cw, ch = sw * clip.crop.width_fraction(), sh * clip.crop.height_fraction()
    W, H = project.settings.width, project.settings.height
    fit = 1.0 if clip.type == "text" else min(W / cw, H / ch)
    s = clip.transform.scale
    return LayerGeometry(cw * fit * s, ch * fit * s, W / 2 + clip.transform.x, H / 2 + clip.transform.y)


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

    video_labels: list[tuple[str, _Visible, LayerGeometry]] = []
    audio_labels: list[str] = []

    for clip in clips:
        track = tracks[clip.track_id]
        vis = _visible(clip, win)
        if vis is None:
            continue
        asset = project.asset(clip.asset_id) if clip.asset_id else None
        wants_video = win.video and clip.is_visual and not track.hidden
        wants_audio = (
            win.audio and not track.muted and not clip.muted and clip.volume > 0
            and clip.type in ("video", "audio") and asset is not None and asset.has_audio
        )
        if not (wants_video or wants_audio):
            continue

        # ---- input ----------------------------------------------------------------
        idx: Optional[int] = None
        if clip.type == "text":
            if clip.text is None:
                continue
            png, _, _ = text.render_text(clip.text)
            idx = g.add_input("-loop", "1", "-framerate", _num(fps), "-t", _num(vis.length + 1 / fps), "-i", str(png))
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
            geo = layer_geometry(project, clip)
            if geo is not None:
                label = f"v{idx}"
                chain = [f"setpts=(PTS-STARTPTS)/{_num(clip.speed)}+{_num(vis.offset)}/TB"]
                c = clip.crop
                if not c.is_identity():
                    chain.append(
                        f"crop=iw*{_num(c.width_fraction())}:ih*{_num(c.height_fraction())}"
                        f":iw*{_num(c.left)}:ih*{_num(c.top)}"
                    )
                chain.append(f"scale={_even(geo.width * k)}:{_even(geo.height * k)}")
                tr = clip.transform
                if tr.flip_h:
                    chain.append("hflip")
                if tr.flip_v:
                    chain.append("vflip")
                needs_alpha = clip.type in ("image", "text") or tr.opacity < 1 or abs(tr.rotation) > EPS
                if needs_alpha:
                    chain.append("format=rgba")
                if tr.opacity < 1:
                    chain.append(f"colorchannelmixer=aa={_num(tr.opacity)}")
                if abs(tr.rotation % 360) > EPS:
                    rad = _num(math.radians(tr.rotation))
                    chain.append(f"rotate={rad}:c=none:ow=rotw({rad}):oh=roth({rad})")
                g.filters.append(f"[{idx}:v]{','.join(chain)}[{label}]")
                video_labels.append((label, vis, geo))

        # ---- audio ----------------------------------------------------------------
        if wants_audio:
            label = f"a{idx}"
            chain = ["asetpts=PTS-STARTPTS", *_atempo_chain(clip.speed)]
            chain += [
                f"aresample={AUDIO_RATE}",
                "aformat=sample_fmts=fltp:channel_layouts=stereo",
                f"atrim=duration={_num(vis.length)}",
            ]
            vol = _num(clip.volume)
            o, cd = _num(vis.into), _num(clip.duration)
            expr = vol
            if clip.fade_in > EPS:
                expr += f"*max(0,min(1,(t+{o})/{_num(clip.fade_in)}))"
            if clip.fade_out > EPS:
                expr += f"*max(0,min(1,({cd}-t-{o})/{_num(clip.fade_out)}))"
            chain.append(f"volume='{expr}':eval=frame" if expr != vol else f"volume={vol}")
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
        for n, (label, vis, geo) in enumerate(video_labels):
            out = f"ov{n}"
            a, b = vis.offset, vis.offset + vis.length
            g.filters.append(
                f"[{current}][{label}]overlay=x={_num(geo.cx * k)}-w/2:y={_num(geo.cy * k)}-h/2"
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
