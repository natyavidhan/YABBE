"""Thin wrappers around the ffmpeg / ffprobe binaries."""

from __future__ import annotations

import collections
import json
import logging
import subprocess
import threading
from typing import Callable, Optional, Sequence

from .. import config

log = logging.getLogger("yabbe.ffmpeg")


class FFmpegError(RuntimeError):
    def __init__(self, message: str, stderr: str = ""):
        super().__init__(message)
        self.stderr = stderr


def _tail_error(stderr: str, lines: int = 6) -> str:
    useful = [l for l in stderr.strip().splitlines() if l.strip()]
    return "\n".join(useful[-lines:]) or "ffmpeg failed"


def run(args: Sequence[str], *, input_bytes: Optional[bytes] = None, timeout: Optional[float] = None) -> bytes:
    """Run ffmpeg to completion and return stdout. Raises FFmpegError."""
    cmd = [config.FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", *args]
    log.debug("ffmpeg %s", " ".join(cmd))
    try:
        proc = subprocess.run(cmd, input=input_bytes, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise FFmpegError("ffmpeg timed out") from exc
    if proc.returncode != 0:
        err = proc.stderr.decode(errors="replace")
        raise FFmpegError(_tail_error(err), err)
    return proc.stdout


def run_with_progress(
    args: Sequence[str],
    duration: float,
    on_progress: Callable[[float], None],
    should_cancel: Callable[[], bool] = lambda: False,
) -> None:
    """Run ffmpeg, reporting progress (0..1) parsed from ``-progress pipe:1``.

    ``on_progress`` may raise (e.g. JobCancelled) - the process is killed then.
    """
    cmd = [
        config.FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error",
        "-progress", "pipe:1", "-nostats", *args,
    ]
    log.debug("ffmpeg %s", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    stderr_tail: collections.deque[str] = collections.deque(maxlen=50)

    def drain_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_tail.append(line)

    t = threading.Thread(target=drain_stderr, daemon=True)
    t.start()
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if should_cancel():
                proc.kill()
                break
            key, _, value = line.strip().partition("=")
            if key in ("out_time_us", "out_time_ms") and value.isdigit() and duration > 0:
                # Both keys are in microseconds (out_time_ms is misnamed upstream).
                on_progress(min(1.0, int(value) / 1_000_000 / duration))
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    code = proc.wait()
    t.join(timeout=2)
    if should_cancel():
        return
    if code != 0:
        err = "".join(stderr_tail)
        raise FFmpegError(_tail_error(err), err)


def probe(path: str) -> dict:
    cmd = [
        config.FFPROBE, "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=60)
    if proc.returncode != 0:
        raise FFmpegError(_tail_error(proc.stderr.decode(errors="replace")))
    return json.loads(proc.stdout or b"{}")


def version() -> str:
    try:
        out = subprocess.run([config.FFMPEG, "-version"], capture_output=True, timeout=10).stdout
        return out.decode(errors="replace").splitlines()[0]
    except Exception:  # noqa: BLE001
        return "unavailable"
