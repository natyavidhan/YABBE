"""Writes tests/fixtures/curves.json: sampled keyframe curves that the Python
engine (app/engine/curves.py) and the frontend (src/editor/curves.ts) must
both reproduce. Regenerate after changing curve maths:

    uv run python tests/gen_curve_fixture.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.engine import curves  # noqa: E402
from app.engine.keyframes import color_at  # noqa: E402
from app.models import Keyframe  # noqa: E402

EASES = ["linear", "hold", "ease_in", "ease_out", "ease_in_out", "back_in", "back_out", "back_in_out",
         "elastic_in", "elastic_out", "elastic_in_out", "bounce_in", "bounce_out", "bounce_in_out"]


def cases() -> list[dict]:
    out: list[dict] = []
    for e in EASES:
        out.append({"name": e, "frames": [{"t": 0.5, "v": -20, "ease": e}, {"t": 2.5, "v": 180, "ease": "linear"}]})
    out.append({"name": "elastic params", "frames": [
        {"t": 0, "v": 0, "ease": "elastic_out", "ep": [5, 6]}, {"t": 1, "v": 1}]})
    out.append({"name": "back params", "frames": [{"t": 0, "v": 0, "ease": "back_in_out", "ep": [3]}, {"t": 1, "v": 10}]})
    out.append({"name": "bezier default handles", "frames": [{"t": 0, "v": 0, "ease": "bezier"}, {"t": 2, "v": 100}]})
    out.append({"name": "bezier easy ease", "frames": [
        {"t": 0, "v": 0, "ease": "bezier", "ho": [0.6667, 0]}, {"t": 2, "v": 100, "hi": [-0.6667, 0]}]})
    out.append({"name": "bezier overshoot + bump", "frames": [
        {"t": 0, "v": 10, "ease": "bezier", "ho": [0.3, 120]}, {"t": 1.5, "v": 10, "ease": "bezier", "hi": [-0.4, -60],
                                                              "ho": [0.2, 30]},
        {"t": 3, "v": -40, "hi": [-2.5, 0]}]})
    out.append({"name": "mixed", "frames": [
        {"t": 0, "v": 0, "ease": "hold"}, {"t": 1, "v": 5, "ease": "bounce_out"}, {"t": 2, "v": 1, "ease": "bezier",
                                                                               "ho": [0.1, 4]},
        {"t": 3, "v": 3}]})
    return out


def build() -> dict:
    result = []
    for case in cases():
        frames = [Keyframe(**f) for f in case["frames"]]
        t0, t1 = frames[0].t - 0.25, frames[-1].t + 0.25
        us = [round(t0 + (t1 - t0) * i / 60, 6) for i in range(61)]
        result.append({**case, "samples": [[u, round(curves.value_at(frames, u), 9)] for u in us]})
    color_frames = [{"t": 0, "c": "#ffffff", "ease": "bezier", "ho": [0.3, 0.6]}, {"t": 1, "c": "#ff000080",
                                                                                 "ease": "bounce_out"},
                    {"t": 2, "c": "#00ff00"}]
    fr = [Keyframe(**f) for f in color_frames]
    colors = [[round(u / 20, 6), color_at(fr, u / 20)] for u in range(-2, 45)]
    return {"version": 1, "numeric": result, "color": {"frames": color_frames, "samples": colors}}


if __name__ == "__main__":
    path = Path(__file__).parent / "fixtures" / "curves.json"
    path.write_text(json.dumps(build(), indent=1) + "\n")
    print("wrote", path)
