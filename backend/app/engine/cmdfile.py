"""Timed filter commands (sendcmd / asendcmd files) for per-frame animation."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Optional

from .. import config


class Commands:
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


