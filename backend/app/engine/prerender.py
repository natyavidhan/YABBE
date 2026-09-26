"""Full pre-renders of sequences (phase 3). Until then nothing is pre-rendered."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from ..models import Project


def usable(project: Project, sequence_id: str, height: int, draft: bool) -> Optional[Path]:
    """A fresh full render of the sequence good enough for ``height`` (and full
    quality when not ``draft``), or None."""
    return None
