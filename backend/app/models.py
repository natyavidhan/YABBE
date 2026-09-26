"""Project document schema shared by storage, API and the render engine."""

from __future__ import annotations

import time
import uuid
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


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


ClipType = Literal["video", "audio", "image", "text"]


class Clip(_Model):
    id: str = Field(default_factory=lambda: new_id("c_"))
    track_id: str
    type: ClipType
    asset_id: Optional[str] = None
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

    @property
    def end(self) -> float:
        return self.start + self.duration

    @property
    def is_visual(self) -> bool:
        return self.type in ("video", "image", "text")


class Project(_Model):
    id: str = Field(default_factory=lambda: new_id("p_"))
    name: str = "Untitled project"
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    settings: ProjectSettings = Field(default_factory=ProjectSettings)
    assets: list[Asset] = Field(default_factory=list)
    tracks: list[Track] = Field(default_factory=list)
    clips: list[Clip] = Field(default_factory=list)

    @property
    def duration(self) -> float:
        return max((c.end for c in self.clips), default=0.0)

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
    settings: Optional[ProjectSettings] = None
    tracks: Optional[list[Track]] = None
    clips: Optional[list[Clip]] = None
