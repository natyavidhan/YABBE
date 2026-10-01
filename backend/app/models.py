"""Project document schema shared by storage, API and the render engine."""

from __future__ import annotations

import math
import re
import time
import uuid
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def new_id(prefix: str = "") -> str:
    return prefix + uuid.uuid4().hex[:12]


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class ProjectSettings(_Model):
    width: int = Field(1920, ge=16, le=7680)
    height: int = Field(1080, ge=16, le=4320)
    fps: float = Field(30, gt=0, le=120)
    background: str = "#000000"

    @field_validator("width", "height")
    @classmethod
    def _even(cls, v: int) -> int:
        # H.264 with yuv420p needs even dimensions.
        return v - (v % 2)


AssetKind = Literal["video", "audio", "image"]
AssetStatus = Literal["processing", "ready", "error"]


class Asset(_Model):
    id: str
    kind: AssetKind
    filename: str  # stored file name inside media/
    original_name: str
    size: int = 0
    duration: float = 0.0  # 0 for images
    width: int = 0
    height: int = 0
    fps: float = 0.0
    has_video: bool = False
    has_audio: bool = False
    status: AssetStatus = "processing"
    error: Optional[str] = None
    # Filmstrip sprite layout, filled when generated.
    thumb_count: int = 0
    thumb_interval: float = 0.0
    created_at: float = Field(default_factory=time.time)
    # Made by the editor (e.g. a freeze frame), not uploaded: not listed in the media bin.
    hidden: bool = False


TrackKind = Literal["video", "audio"]


class Track(_Model):
    id: str = Field(default_factory=lambda: new_id("t_"))
    kind: TrackKind = "video"
    name: str = ""
    muted: bool = False
    hidden: bool = False
    locked: bool = False


class Transform(_Model):
    x: float = 0.0  # centre offset from canvas centre, project pixels
    y: float = 0.0
    scale: float = Field(1.0, gt=0, le=20)
    rotation: float = 0.0  # degrees, clockwise
    opacity: float = Field(1.0, ge=0, le=1)
    flip_h: bool = False
    flip_v: bool = False


class Crop(_Model):
    left: float = Field(0.0, ge=0, lt=1)
    top: float = Field(0.0, ge=0, lt=1)
    right: float = Field(0.0, ge=0, lt=1)
    bottom: float = Field(0.0, ge=0, lt=1)

    def is_identity(self) -> bool:
        return not (self.left or self.top or self.right or self.bottom)

    def width_fraction(self) -> float:
        return max(0.01, 1 - self.left - self.right)

    def height_fraction(self) -> float:
        return max(0.01, 1 - self.top - self.bottom)


class TextStyle(_Model):
    content: str = "Text"
    font: str = "DejaVu Sans"
    size: int = Field(96, ge=4, le=1000)
    color: str = "#ffffff"
    background: Optional[str] = None  # box colour behind text, None = transparent
    padding: int = Field(16, ge=0, le=500)
    stroke_color: str = "#000000"
    stroke_width: int = Field(0, ge=0, le=100)
    align: Literal["left", "center", "right"] = "center"
    bold: bool = False
    italic: bool = False
    line_spacing: float = Field(1.2, ge=0.5, le=4)


ClipType = Literal["video", "audio", "image", "text", "sequence", "shape"]
# How a clip's picture combines with what's below it (Photoshop / Premiere names).
BlendMode = Literal[
    "normal",
    "darken", "multiply", "color_burn", "linear_burn",
    "lighten", "screen", "color_dodge", "add",
    "overlay", "soft_light", "hard_light", "vivid_light", "linear_light", "pin_light", "hard_mix",
    "difference", "exclusion", "subtract", "divide",
]


class ChromaKey(_Model):
    """Green / blue screen removal (per clip; kept when toggled off)."""

    enabled: bool = True
    color: str = Field("#00b140", pattern=r"^#[0-9a-fA-F]{6}$")  # the screen colour
    # Matte levels (Keylight's "clip black / white"): below clip_black is screen
    # (cleans uneven lighting), above clip_white is solid subject (fills holes).
    clip_black: float = Field(0.15, ge=0, le=0.95)
    clip_white: float = Field(0.9, ge=0.05, le=1)
    spill: float = Field(0.6, ge=0, le=1)  # remove the screen's colour cast from the subject
    choke: float = Field(0.0, ge=0, le=10)  # shrink the matte (source pixels)
    feather: float = Field(0.0, ge=0, le=10)  # soften the matte edge (source pixels)
    matte: bool = False  # show the matte (black/white) instead; preview aid, not saved by the editor


TrackerKind = Literal["point", "transform", "corner_pin", "stabilize"]


class Tracker(_Model):
    """A motion tracker on a video clip (engine/tracking.py). Coordinates are
    normalised to the source frame (0..1); times are source seconds. The result
    is stored separately, keyed by these settings, so it's reused until they change."""

    id: str = Field(default_factory=lambda: new_id("k_"))
    name: str = Field("", max_length=80)
    kind: TrackerKind
    ref: float = Field(0.0, ge=0)  # frame the region was placed on
    box: list[float] = Field(default_factory=lambda: [0.5, 0.5, 0.08, 0.08], min_length=4, max_length=4)  # cx, cy, w, h
    quad: list[list[float]] = Field(  # corner pin: top-left, top-right, bottom-right, bottom-left
        default_factory=lambda: [[0.35, 0.35], [0.65, 0.35], [0.65, 0.65], [0.35, 0.65]], min_length=4, max_length=4
    )
    start: Optional[float] = Field(None, ge=0)  # range to track (source seconds); None = whole source
    end: Optional[float] = Field(None, ge=0)
    quality: Literal["fast", "precise"] = "fast"  # analyse the proxy, or the original up to 1080p


class FollowTrack(_Model):
    """This clip moves with a point / transform tracker (After Effects' "apply to layer")."""

    clip_id: str
    tracker_id: str
    position: bool = True
    rotation: bool = False
    scale: bool = False


class PinTrack(_Model):
    """This clip is corner-pinned onto a corner-pin tracker's surface."""

    clip_id: str
    tracker_id: str


class Stabilize(_Model):
    """Remove camera shake using a stabilize tracker on the same clip."""

    tracker_id: str
    mode: Literal["smooth", "lock"] = "smooth"
    smoothness: float = Field(1.0, ge=0.05, le=10)  # seconds of motion averaged (smooth mode)
    rotation: bool = True
    scale: bool = False
    auto_zoom: bool = True  # scale up just enough to hide the moving edges


ShapeKind = Literal["rectangle", "ellipse", "triangle", "polygon", "star", "line", "arrow"]


class ShapeStyle(_Model):
    """A vector shape clip, drawn at its size in project pixels (engine/shapes.py)."""

    kind: ShapeKind = "rectangle"
    width: float = Field(400, ge=1, le=8000)
    height: float = Field(400, ge=1, le=8000)
    fill: Optional[str] = Field("#7c5cff", pattern=r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")  # None = no fill
    stroke: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")  # outline (lines: the line)
    stroke_width: float = Field(0, ge=0, le=500)
    radius: float = Field(0, ge=0, le=0.5)  # rectangle: corner rounding, fraction of the shorter side
    sides: int = Field(6, ge=3, le=24)  # polygon sides / star points
    inner: float = Field(0.45, ge=0.05, le=0.95)  # star: inner radius / outer radius


class RotoPrompt(_Model):
    """What to select on one source frame: a box and/or clicks (normalised
    source coordinates; label 1 = part of the object, 0 = not)."""

    t: float = Field(ge=0)  # source seconds
    box: Optional[list[float]] = Field(None, min_length=4, max_length=4)  # x0, y0, x1, y1
    points: list[list[float]] = Field(default_factory=list, max_length=40)  # [x, y, label]


class Roto(_Model):
    """Roto brush: an object selected on some frames and followed through the
    clip by EdgeTAM (engine/roto.py). The mask becomes the clip's alpha."""

    enabled: bool = True
    prompts: list[RotoPrompt] = Field(default_factory=list, max_length=50)
    start: Optional[float] = Field(None, ge=0)  # tracked source range (None = whole source)
    end: Optional[float] = Field(None, ge=0)
    invert: bool = False  # keep everything except the object
    refine: bool = True  # edge-aware refinement against the picture (hair, soft edges)
    choke: float = Field(0.0, ge=-10, le=10)  # shrink (+) / grow (-) the matte, pixels
    feather: float = Field(0.0, ge=0, le=20)  # soften the edge, pixels
    matte: bool = False  # preview aid: show the matte


class Transition(_Model):
    """Transition from this clip into the next clip that touches it on the same
    track, centred on the cut (see engine/transitions.py for the kinds)."""

    kind: str = Field("mix", max_length=40)
    duration: float = Field(0.5, ge=0.04, le=5)
    # Crossfade the two clips' sound over the transition (equal power).
    audio: bool = True


class Marker(_Model):
    """A named point on a clip. ``t`` is seconds from the clip's start, kept on
    the same moment of footage through moves, trims, splits and speed changes
    (it may fall outside the clip after a trim, where it is simply hidden)."""

    id: str = Field(default_factory=lambda: new_id("m_"))
    t: float
    label: str = Field("", max_length=200)
    color: str = "#f2b84b"

    @field_validator("color")
    @classmethod
    def _color(cls, v: str) -> str:
        return v if re.fullmatch(r"#[0-9a-fA-F]{6}", v or "") else "#f2b84b"

AnimProp = Literal[
    "x", "y", "scale", "rotation", "opacity", "volume",
    # text clips: style properties (re-rasterised per frame when animated)
    "text_size", "text_stroke_width", "text_padding", "text_line_spacing",
    "text_color", "text_stroke_color", "text_background",
    # shape clips (re-drawn per frame when animated)
    "shape_width", "shape_height", "shape_stroke_width", "shape_radius",
    "shape_fill", "shape_stroke",
]
ANIM_PROPS: tuple[str, ...] = AnimProp.__args__  # type: ignore[attr-defined]

# Text style keys -> TextStyle field names.
TEXT_NUMERIC_PROPS = {
    "text_size": "size", "text_stroke_width": "stroke_width",
    "text_padding": "padding", "text_line_spacing": "line_spacing",
}
TEXT_COLOR_PROPS = {"text_color": "color", "text_stroke_color": "stroke_color", "text_background": "background"}
TEXT_INT_FIELDS = {"size", "stroke_width", "padding"}
SHAPE_NUMERIC_PROPS = {"shape_width": "width", "shape_height": "height",
                       "shape_stroke_width": "stroke_width", "shape_radius": "radius"}
SHAPE_COLOR_PROPS = {"shape_fill": "fill", "shape_stroke": "stroke"}
COLOR_PROPS = {**TEXT_COLOR_PROPS, **SHAPE_COLOR_PROPS}
Ease = Literal[
    "linear", "hold", "bezier",
    "ease_in", "ease_out", "ease_in_out",
    "back_in", "back_out", "back_in_out",
    "elastic_in", "elastic_out", "elastic_in_out",
    "bounce_in", "bounce_out", "bounce_in_out",
]
HandleMode = Literal["auto", "auto_clamped", "aligned", "free"]

# Valid ranges for animated values (same limits as the static fields).
ANIM_LIMITS: dict[str, tuple[float, float]] = {
    "x": (-100_000, 100_000),
    "y": (-100_000, 100_000),
    "scale": (0.01, 20),
    "rotation": (-100_000, 100_000),
    "opacity": (0, 1),
    "volume": (0, 4),
    "text_size": (4, 1000),
    "text_stroke_width": (0, 100),
    "text_padding": (0, 500),
    "text_line_spacing": (0.5, 4),
    "shape_width": (1, 8000),
    "shape_height": (1, 8000),
    "shape_stroke_width": (0, 500),
    "shape_radius": (0, 0.5),
}

HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")


class Keyframe(_Model):
    """A value at a time. ``t`` is seconds from the clip's start on the
    timeline (it may fall outside the clip after trims/splits, where it still
    shapes the curve); ``ease`` shapes the segment from this keyframe to the next."""

    t: float
    v: float = 0.0
    c: Optional[str] = None  # colour value (#rrggbb[aa]) for colour properties
    ease: Ease = "linear"  # shape of the segment from this key to the next
    # Bézier handles as (dt, dv) offsets from the key: incoming / outgoing.
    hi: Optional[tuple[float, float]] = None
    ho: Optional[tuple[float, float]] = None
    hm: Optional[HandleMode] = None  # how the editor keeps the handles (UI only)
    ep: Optional[list[float]] = Field(None, max_length=4)  # ease parameters (back/elastic)

    @field_validator("hi", "ho")
    @classmethod
    def _finite(cls, h):
        if h is None:
            return None
        dt, dv = h
        if not (math.isfinite(dt) and math.isfinite(dv)):
            return None
        return (dt, dv)


class Clip(_Model):
    id: str = Field(default_factory=lambda: new_id("c_"))
    track_id: str
    type: ClipType
    asset_id: Optional[str] = None
    sequence_id: Optional[str] = None  # for type == "sequence": the nested sequence
    start: float = Field(0.0, ge=0)  # position on the timeline (s)
    duration: float = Field(5.0, gt=0)  # length on the timeline (s)
    in_point: float = Field(0.0, ge=0)  # offset into the source (s, source time)
    speed: float = Field(1.0, ge=0.25, le=4)
    volume: float = Field(1.0, ge=0, le=4)
    muted: bool = False
    fade_in: float = Field(0.0, ge=0)
    fade_out: float = Field(0.0, ge=0)
    transform: Transform = Field(default_factory=Transform)
    crop: Crop = Field(default_factory=Crop)
    text: Optional[TextStyle] = None
    # Animated properties; a property with keyframes ignores its static value.
    keyframes: dict[AnimProp, list[Keyframe]] = Field(default_factory=dict)
    markers: list[Marker] = Field(default_factory=list, max_length=500)
    transition: Optional[Transition] = None
    blend: BlendMode = "normal"
    chroma_key: Optional[ChromaKey] = None
    trackers: list[Tracker] = Field(default_factory=list, max_length=20)
    follow: Optional[FollowTrack] = None
    pin: Optional[PinTrack] = None
    stabilize: Optional[Stabilize] = None
    roto: Optional[Roto] = None
    shape: Optional[ShapeStyle] = None
    # Freeze frame: show the source frame at ``in_point`` for the whole clip (silent).
    hold: bool = False
    # The sound was separated into its own audio clip: this clip is silent.
    audio_detached: bool = False
    # Clips sharing a link id are selected / moved / deleted together (editor only).
    link: Optional[str] = Field(None, max_length=40)

    @field_validator("keyframes")
    @classmethod
    def _tidy_keyframes(cls, value: dict[str, list[Keyframe]]) -> dict[str, list[Keyframe]]:
        out: dict[str, list[Keyframe]] = {}
        for prop, frames in value.items():
            if not frames:
                continue
            by_time: dict[float, Keyframe] = {}
            for k in frames:  # one keyframe per time (last wins), values clamped
                if prop in COLOR_PROPS:
                    if not k.c or not HEX_COLOR.match(k.c):
                        continue
                    by_time[round(k.t, 6)] = k.model_copy(update={"c": k.c.lower()})
                else:
                    lo, hi = ANIM_LIMITS[prop]
                    by_time[round(k.t, 6)] = k.model_copy(update={"v": min(hi, max(lo, k.v))})
            if by_time:
                out[prop] = sorted(by_time.values(), key=lambda k: k.t)
        return out

    def animated(self, prop: str) -> Optional[list[Keyframe]]:
        frames = self.keyframes.get(prop)  # type: ignore[call-overload]
        return frames or None

    def static_value(self, prop: str) -> float:
        return self.volume if prop == "volume" else float(getattr(self.transform, prop))

    @property
    def shape_animated(self) -> bool:
        return self.type == "shape" and any(self.animated(p) for p in (*SHAPE_NUMERIC_PROPS, *SHAPE_COLOR_PROPS))

    @property
    def text_animated(self) -> bool:
        return self.type == "text" and any(
            self.animated(p) for p in (*TEXT_NUMERIC_PROPS, *TEXT_COLOR_PROPS)
        )

    @property
    def end(self) -> float:
        return self.start + self.duration

    @property
    def is_visual(self) -> bool:
        return self.type in ("video", "image", "text", "sequence", "shape")


class Sequence(_Model):
    """One timeline with its own settings. A project has one or more; one is
    the main sequence (dashboard thumbnail, default export)."""

    id: str = Field(default_factory=lambda: new_id("s_"))
    name: str = Field("Sequence", max_length=120)
    settings: ProjectSettings = Field(default_factory=ProjectSettings)
    tracks: list[Track] = Field(default_factory=list)
    clips: list[Clip] = Field(default_factory=list)
    created_at: float = Field(default_factory=time.time)

    @property
    def duration(self) -> float:
        return max((c.end for c in self.clips), default=0.0)


class Project(_Model):
    id: str = Field(default_factory=lambda: new_id("p_"))
    name: str = "Untitled project"
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    assets: list[Asset] = Field(default_factory=list)
    sequences: list[Sequence] = Field(default_factory=list)
    main_sequence_id: str = ""
    auto_prerender: bool = True  # draft pre-renders of nested sequences after edits

    @model_validator(mode="before")
    @classmethod
    def _upgrade(cls, data):
        """Projects from before sequences had one top-level timeline: it
        becomes the main sequence."""
        if isinstance(data, dict) and not data.get("sequences"):
            data = dict(data)
            legacy = {k: data.pop(k) for k in ("settings", "tracks", "clips") if k in data}
            # Stable id: the file may be read (and upgraded) many times before
            # it is saved again, and clients refer to the sequence by id.
            seq = {"id": "s_main", "name": "Main", **legacy}
            data["sequences"] = [seq]
            data["main_sequence_id"] = seq["id"]
        return data

    @model_validator(mode="after")
    def _ensure_main(self):
        if not self.sequences:
            self.sequences = [Sequence(name="Main")]
        if not any(s.id == self.main_sequence_id for s in self.sequences):
            self.main_sequence_id = self.sequences[0].id
        return self

    def sequence(self, sequence_id: Optional[str]) -> Optional[Sequence]:
        return next((s for s in self.sequences if s.id == sequence_id), None)

    @property
    def main(self) -> Sequence:
        return self.sequence(self.main_sequence_id) or self.sequences[0]

    # The "current" timeline used by rendering: the main sequence, or whichever
    # sequence a view() was made for.
    @property
    def settings(self) -> ProjectSettings:
        return self.main.settings

    @property
    def tracks(self) -> list[Track]:
        return self.main.tracks

    @property
    def clips(self) -> list[Clip]:
        return self.main.clips

    @property
    def duration(self) -> float:
        return self.main.duration

    def nested_in(self, sequence_id: str) -> set[str]:
        """Sequences used directly by ``sequence_id``'s clips."""
        seq = self.sequence(sequence_id)
        return {c.sequence_id for c in seq.clips if c.type == "sequence" and c.sequence_id} if seq else set()

    def contains(self, outer: str, inner: str) -> bool:
        """Does ``outer`` use ``inner`` (directly or through other sequences)?"""
        seen: set[str] = set()
        todo = [outer]
        while todo:
            cur = todo.pop()
            for child in self.nested_in(cur):
                if child == inner:
                    return True
                if child not in seen:
                    seen.add(child)
                    todo.append(child)
        return False

    def find_cycle(self) -> Optional[str]:
        """Name of a sequence that ends up inside itself, if any."""
        for seq in self.sequences:
            if self.contains(seq.id, seq.id):
                return seq.name
        return None

    def view(self, sequence_id: str) -> "Project":
        """A copy whose settings/tracks/clips are those of ``sequence_id``."""
        return self.model_copy(update={"main_sequence_id": sequence_id})

    def asset(self, asset_id: Optional[str]) -> Optional[Asset]:
        return next((a for a in self.assets if a.id == asset_id), None)

    def track(self, track_id: str) -> Optional[Track]:
        return next((t for t in self.tracks if t.id == track_id), None)


def default_tracks() -> list[Track]:
    return [
        Track(kind="video", name="Video 2"),
        Track(kind="video", name="Video 1"),
        Track(kind="audio", name="Audio 1"),
    ]


class ProjectSummary(_Model):
    id: str
    name: str
    created_at: float
    updated_at: float
    duration: float
    width: int
    height: int
    asset_count: int
    has_thumbnail: bool


class TimelineUpdate(_Model):
    """Body accepted when the editor saves. Assets are server-owned and are not
    overwritten from the client (they are only created by uploads)."""

    name: Optional[str] = None
    auto_prerender: Optional[bool] = None
    sequences: Optional[list[Sequence]] = None
    main_sequence_id: Optional[str] = None
    # A single timeline's contents (older clients, and unsaved editor state
    # sent with render requests): applies to ``sequence_id`` or the main one.
    sequence_id: Optional[str] = None
    settings: Optional[ProjectSettings] = None
    tracks: Optional[list[Track]] = None
    clips: Optional[list[Clip]] = None
