"""Roto brush: select an object on a frame, follow it through the clip.

Model: EdgeTAM (Meta, CVPR 2025, Apache-2.0) - a Segment-Anything-2 style
video segmenter built for phones: 22x faster than SAM 2 at 87.7 J&F on DAVIS
2017. Chosen after benchmarking on a dual-core CPU: SAM 2.1-tiny's encoder took
82 s per frame here, EdgeTAM's whole step ~1.4 s. It runs with ONNX Runtime
(graphs from backend/tools/export_edgetam.py, checked against Meta's own
predictor: mean IoU 0.99), so no PyTorch at runtime.

* Prompts (box and/or include / exclude clicks) on one or more frames become
  conditioning frames; the rest are tracked forward from the first prompted
  frame, then backward from it, with SAM 2's memory bank (conditioning frames,
  the six previous frames, sixteen object pointers).
* Masks are stored as a small lossless grey video (per content key), soft at
  the edges; the compositor refines them against the picture (guided filter),
  so hair and soft edges follow the image, and applies shrink / feather / invert.
"""

from __future__ import annotations

import hashlib
import io
import json
import subprocess
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Callable, Iterator, Optional

import cv2
import numpy as np

from .. import config, storage
from ..models import Asset, Roto, RotoPrompt
from . import media

VERSION = "r1"
NUM_MASKMEM, MAX_PTRS = 7, 16
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
MASK_HEIGHT = 540  # stored mask resolution (the model itself sees 1024x1024, masks at 256x256)

_models = None
_models_lock = threading.Lock()
_features: "OrderedDict[tuple, tuple]" = OrderedDict()  # (asset, frame) -> encoder outputs
_features_lock = threading.Lock()


def model_dir() -> Path:
    return config.MODELS_DIR / "edgetam"


def available() -> bool:
    d = model_dir()
    return all((d / f).is_file() for f in ("image_encoder.onnx", "decoder_single.onnx", "decoder_multi.onnx",
                                           "memory_encoder.onnx", "memory_attention.onnx", "constants.npz"))


class _Models:
    def __init__(self, d: Path):
        import onnxruntime as ort

        so = ort.SessionOptions()
        if config.ROTO_THREADS:
            so.intra_op_num_threads = config.ROTO_THREADS
        s = lambda n: ort.InferenceSession(str(d / f"{n}.onnx"), so, providers=["CPUExecutionProvider"])  # noqa: E731
        self.enc, self.dec1, self.decm = s("image_encoder"), s("decoder_single"), s("decoder_multi")
        self.menc, self.matt = s("memory_encoder"), s("memory_attention")
        c = np.load(d / "constants.npz")
        self.tpos, self.no_mem = c["maskmem_tpos_enc"], c["no_mem_embed"]


def models() -> _Models:
    global _models
    with _models_lock:
        if _models is None:
            if not available():
                raise RuntimeError("The roto brush model isn't installed (see backend/tools/export_edgetam.py)")
            _models = _Models(model_dir())
        return _models


# --------------------------------------------------------------------------- keys


def key(asset: Asset, roto: Roto) -> str:
    params = roto.model_dump_json(include={"prompts", "start", "end"})
    return hashlib.sha1(f"{VERSION}|{asset.id}|{asset.duration}|{params}".encode()).hexdigest()[:20]


def result_path(project_id: str, k: str) -> Path:
    return storage.cache_dir(project_id) / "roto" / f"{k}.mkv"


def meta_path(project_id: str, k: str) -> Path:
    return storage.cache_dir(project_id) / "roto" / f"{k}.json"


def load_meta(project_id: str, k: str) -> Optional[dict]:
    p = meta_path(project_id, k)
    if not p.is_file() or not result_path(project_id, k).is_file():
        return None
    return json.loads(p.read_text())


def track_range(asset: Asset, roto: Roto) -> tuple[float, float, float]:
    """(start, end, fps) of the analysed source range."""
    fps = asset.fps or 25.0
    start = max(0.0, roto.start if roto.start is not None else 0.0)
    end = min(asset.duration, roto.end if roto.end is not None else asset.duration)
    return start, max(start + 1 / fps, end), fps


def mask_size(asset: Asset) -> tuple[int, int]:
    h = min(asset.height or MASK_HEIGHT, MASK_HEIGHT)
    h -= h % 2
    w = round((asset.width or 16) * h / max(1, asset.height or 9) / 2) * 2
    return max(2, w), max(2, h)


# --------------------------------------------------------------------------- frames


def _frames(project_id: str, asset: Asset, start: float, end: float, fps: float) -> Iterator[np.ndarray]:
    """RGB frames, already resized to the model's 1024x1024 input."""
    src = media.source_path(project_id, asset)
    cmd = [config.FFMPEG, "-v", "error", "-nostdin", "-ss", f"{start:.6f}", "-i", str(src),
           "-t", f"{max(0.0, end - start):.6f}", "-an",
           "-vf", f"fps={fps},scale=1024:1024:flags=bicubic,format=rgb24", "-f", "rawvideo", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = 1024 * 1024 * 3
    try:
        assert proc.stdout is not None
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(1024, 1024, 3)
    finally:
        proc.kill()
        proc.wait()


def _frames_backward(project_id: str, asset: Asset, start: float, end: float, fps: float) -> Iterator[np.ndarray]:
    """From ``end`` back to ``start``, a second at a time (bounded memory)."""
    t1 = end
    while t1 > start + 1e-6:
        t0 = max(start, t1 - 1.0)
        yield from reversed(list(_frames(project_id, asset, t0, t1, fps)))
        t1 = t0


def _prep(rgb: np.ndarray) -> np.ndarray:
    return ((rgb.astype(np.float32) / 255.0 - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)


# --------------------------------------------------------------------------- model steps


def _encode(rgb: np.ndarray) -> tuple:
    return tuple(models().enc.run(None, {"image": _prep(rgb)}))


def _prompt_arrays(prompt: RotoPrompt) -> tuple[np.ndarray, np.ndarray]:
    """Model inputs: box corners (labels 2, 3) then clicks, in 1024-px coordinates."""
    coords, labels = [], []
    if prompt.box:
        x0, y0, x1, y1 = prompt.box
        coords += [[min(x0, x1), min(y0, y1)], [max(x0, x1), max(y0, y1)]]
        labels += [2, 3]
    for x, y, lab in prompt.points:
        coords.append([x, y])
        labels.append(1 if lab >= 0.5 else 0)
    c = np.array(coords, np.float32).reshape(1, -1, 2) * 1024
    return c, np.array(labels, np.int32).reshape(1, -1)


def _decode(pix, hi0, hi1, coords, labels, multimask):
    m = models()
    d = m.decm if multimask else m.dec1
    low, _iou, ptr, score = d.run(None, {"pix_feat": pix, "coords": coords, "labels": labels, "hi0": hi0, "hi1": hi1})
    return low, ptr[0], score


def _memory(vf, low, from_points: bool):
    mem, pos = models().menc.run(None, {"vision_feat": vf, "low_res_mask": low,
                                        "from_points": np.array([1.0 if from_points else 0.0], np.float32)})
    return mem, pos


def _condition_frame(feats, prompt: RotoPrompt):
    vf, vp, hi0, hi1 = feats
    m = models()
    pix = (vf + m.no_mem).transpose(1, 2, 0).reshape(1, 256, 64, 64)
    coords, labels = _prompt_arrays(prompt)
    low, ptr, _ = _decode(pix, hi0, hi1, coords, labels, multimask=labels.shape[1] <= 1)
    mem, pos = _memory(vf, low, True)
    return low, {"mem": mem, "pos": pos, "ptr": ptr}


def _track_frame(t: int, feats, cond: dict, prev: dict, n: int, reverse: bool):
    """One tracked frame (sam2_base._prepare_memory_conditioned_features + track_step),
    padded to the exported fixed memory size (7 frames, 16 pointers)."""
    vf, vp, hi0, hi1 = feats
    m = models()
    sign = -1 if reverse else 1
    cond_sel = sorted(cond, key=lambda c: abs(c - t))[:2]  # the closest conditioning frames
    spatial = [(0, cond[c]) for c in cond_sel]
    for t_pos in range(1, NUM_MASKMEM):
        f = t - sign * (NUM_MASKMEM - t_pos)
        out = prev.get(f) or (cond.get(f) if f not in cond_sel else None)
        if out is not None:
            spatial.append((t_pos, out))
    spatial = spatial[:NUM_MASKMEM]
    mems = [o["mem"] for _, o in spatial]
    poss = [o["pos"] + m.tpos[NUM_MASKMEM - tp - 1] for tp, o in spatial]
    while len(mems) < NUM_MASKMEM:
        mems.append(mems[-1])
        poss.append(poss[-1])
    ptrs = [cond[c]["ptr"] for c in cond_sel if (c >= t if reverse else c <= t)]
    for dlt in range(1, min(n, MAX_PTRS)):
        f = t - sign * dlt
        if f < 0 or f >= n:
            break
        o = prev.get(f) or cond.get(f)
        if o is not None and f not in cond_sel:
            ptrs.append(o["ptr"])
    ptrs = (ptrs or [cond[cond_sel[0]]["ptr"]])[:MAX_PTRS]
    while len(ptrs) < MAX_PTRS:
        ptrs.append(ptrs[-1])
    tok = np.stack(ptrs, 0).reshape(MAX_PTRS, 1, 4, 64).transpose(0, 2, 1, 3).reshape(MAX_PTRS * 4, 1, 64)
    memory = np.concatenate(mems + [tok], 0).astype(np.float32)
    memory_pos = np.concatenate(poss + [np.zeros_like(tok)], 0).astype(np.float32)
    (pix,) = m.matt.run(None, {"curr": vf, "curr_pos": vp, "memory": memory, "memory_pos": memory_pos})
    low, ptr, _ = _decode(pix, hi0, hi1, np.zeros((1, 1, 2), np.float32), -np.ones((1, 1), np.int32), True)
    mem, pos = _memory(vf, low, False)
    return low, {"mem": mem, "pos": pos, "ptr": ptr}


def _to_mask(low: np.ndarray, w: int, h: int) -> np.ndarray:
    """Low-res logits -> soft 8-bit mask at (w, h) (bilinear on logits, then sigmoid)."""
    logits = cv2.resize(low[0, 0], (w, h), interpolation=cv2.INTER_LINEAR)
    return (255.0 / (1.0 + np.exp(-np.clip(logits, -30, 30)))).astype(np.uint8)


# --------------------------------------------------------------------------- single frame preview


def preview(project_id: str, asset: Asset, prompt: RotoPrompt) -> bytes:
    """Mask for one frame as a PNG (grey), for instant feedback while clicking.
    The frame's image features are cached, so extra clicks only run the decoder."""
    fps = asset.fps or 25.0
    frame_t = round(prompt.t * fps) / fps
    ck = (project_id, asset.id, round(frame_t * 1000))
    with _features_lock:
        feats = _features.get(ck)
        if feats is not None:
            _features.move_to_end(ck)
    if feats is None:
        rgb = next(_frames(project_id, asset, frame_t, frame_t + 1 / fps, fps), None)
        if rgb is None:
            raise ValueError("Could not read that frame")
        feats = _encode(rgb)
        with _features_lock:
            _features[ck] = feats
            while len(_features) > 4:
                _features.popitem(last=False)
    if not prompt.box and not prompt.points:
        low = np.full((1, 1, 256, 256), -30.0, np.float32)
    else:
        low, _ = _condition_frame(feats, prompt)
    w, h = mask_size(asset)
    ok, png = cv2.imencode(".png", _to_mask(low, w, h))
    return png.tobytes()


# --------------------------------------------------------------------------- propagation job


def run(project_id: str, asset: Asset, roto: Roto, on_progress: Callable[[float], None],
        cancelled: Callable[[], bool] = lambda: False) -> dict:
    """Track the object through the range and store the mask video."""
    if not roto.prompts:
        raise ValueError("Select the object first")
    k = key(asset, roto)
    start, end, fps = track_range(asset, roto)
    n = max(1, round((end - start) * fps))
    w, h = mask_size(asset)
    # conditioning frames: index -> prompt (the last prompt on a frame wins)
    prompts: dict[int, RotoPrompt] = {}
    for p in roto.prompts:
        if p.box or p.points:
            prompts[min(n - 1, max(0, round((p.t - start) * fps)))] = p
    if not prompts:
        raise ValueError("Select the object first")
    total = n + len(prompts)
    done = [0]

    def tick():
        done[0] += 1
        on_progress(min(0.99, done[0] / total))
        if cancelled():
            raise InterruptedError()

    cond: dict[int, dict] = {}
    masks: dict[int, bytes] = {}

    def keep(i: int, low: np.ndarray) -> None:
        ok, png = cv2.imencode(".png", _to_mask(low, w, h))
        masks[i] = png.tobytes()

    for i, p in sorted(prompts.items()):
        rgb = next(_frames(project_id, asset, start + i / fps, start + (i + 1) / fps, fps), None)
        if rgb is None:
            raise ValueError("Could not read a prompted frame")
        low, out = _condition_frame(_encode(rgb), p)
        cond[i] = out
        keep(i, low)
        tick()
    first = min(prompts)
    prev: dict[int, dict] = {}
    # forward from the first prompted frame (other prompted frames re-anchor it)
    for j, rgb in enumerate(_frames(project_id, asset, start + first / fps, end, fps)):
        i = first + j
        if i >= n:
            break
        if i not in cond:
            low, out = _track_frame(i, _encode(rgb), cond, prev, n, reverse=False)
            prev[i] = out
            keep(i, low)
        _trim(prev, i, reverse=False)
        tick()
    # backward from the first prompted frame to the start
    prev = {}
    for j, rgb in enumerate(_frames_backward(project_id, asset, start, start + first / fps, fps)):
        i = first - 1 - j
        if i < 0:
            break
        low, out = _track_frame(i, _encode(rgb), cond, prev, n, reverse=True)
        prev[i] = out
        keep(i, low)
        _trim(prev, i, reverse=True)
        tick()
    _write(project_id, k, masks, n, w, h, fps, start)
    on_progress(1.0)
    return {"key": k, "frames": n}


def _trim(prev: dict, i: int, reverse: bool) -> None:
    """Only the last MAX_PTRS frames are ever looked at again."""
    for f in [f for f in prev if (f > i + MAX_PTRS if reverse else f < i - MAX_PTRS)]:
        del prev[f]


def _write(project_id: str, k: str, masks: dict[int, bytes], n: int, w: int, h: int, fps: float, start: float) -> None:
    out = result_path(project_id, k)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.stem + ".part.mkv")
    proc = subprocess.Popen([config.FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray",
                             "-s", f"{w}x{h}", "-r", f"{fps}", "-i", "-", "-c:v", "ffv1", "-level", "3",
                             "-g", "1", "-pix_fmt", "gray", str(tmp)], stdin=subprocess.PIPE)
    assert proc.stdin is not None
    empty = np.zeros((h, w), np.uint8).tobytes()
    for i in range(n):
        png = masks.get(i)
        proc.stdin.write(cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE).tobytes() if png else empty)
    proc.stdin.close()
    if proc.wait() != 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("Could not write the mask video")
    tmp.replace(out)
    meta_path(project_id, k).write_text(json.dumps({"start": start, "fps": fps, "frames": n, "width": w, "height": h}))
