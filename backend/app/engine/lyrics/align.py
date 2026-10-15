"""Word timing: CTC forced alignment of known lyrics to the (vocal) audio.

Model: Meta's MMS-300m forced aligner (1130 languages; CC-BY-NC-4.0), as a
4-bit ONNX graph. Text in any script is romanised with uroman first (the model
spells in Latin letters); languages written without spaces (Chinese, Japanese,
Thai, ...) are timed per character.

The aligner hears 50 frames a second. The lyrics become one long token sequence
and the most likely path through the audio is found with a CTC Viterbi pass,
so a word can never be out of order and every word gets a time. Where the
audio doesn't support the words (ad-libs, wrong lyrics) the path squeezes them
- those words get low confidence, and :mod:`pipeline` falls back to line timing
there.
"""

from __future__ import annotations

import json
import re
import threading
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from typing import Callable, Optional

import numpy as np

from ... import config

SR = 16000
FPS = 50  # emission frames per second (the model's stride is 320 samples)
WINDOW_S, CONTEXT_S = 30, 2  # audio per model call, + context each side
# scripts without spaces between words: each character is its own "word"
_NO_SPACE = re.compile(r"([぀-ヿ㐀-䶿一-鿿豈-﫿฀-๿຀-໿"
                       r"က-႟ក-៿가-힯])")


@lru_cache(maxsize=1)
def _vocab() -> dict[str, int]:
    return json.loads((config.MODELS_DIR / "lyrics" / "vocab.json").read_text())


_uroman = None
_uroman_lock = threading.Lock()


def romanize(text: str) -> str:
    global _uroman
    with _uroman_lock:
        if _uroman is None:
            import uroman

            _uroman = uroman.Uroman()
        return _uroman.romanize_string(text)


def split_words(line: str) -> list[str]:
    """A lyric line → its words as shown (CJK etc.: per character)."""
    spaced = _NO_SPACE.sub(r" \1 ", line)
    return [w for w in spaced.split() if w]


def spell(word: str) -> str:
    """How the aligner spells ``word``: romanised, lower case, letters it knows."""
    vocab = _vocab()
    rom = romanize(unicodedata.normalize("NFC", word)).lower()
    rom = unicodedata.normalize("NFKD", rom)
    return "".join(c for c in rom if c in vocab and len(c) == 1 and c not in "<>")


def session():
    import onnxruntime as ort

    so = ort.SessionOptions()
    if config.ROTO_THREADS:
        so.intra_op_num_threads = config.ROTO_THREADS
    return ort.InferenceSession(str(config.MODELS_DIR / "lyrics" / "aligner.onnx"), so,
                                providers=["CPUExecutionProvider"])


def emissions(audio: np.ndarray, sess, on_progress: Optional[Callable[[float], None]] = None) -> np.ndarray:
    """16 kHz mono audio → log-probabilities [frames, vocab] at 50 fps."""
    n_frames = int(np.ceil(len(audio) / SR * FPS))
    out = np.full((n_frames, len(_vocab())), -1e4, np.float32)
    step, ctx = WINDOW_S * SR, CONTEXT_S * SR
    starts = list(range(0, max(1, len(audio)), step))
    for k, s in enumerate(starts):
        a, b = max(0, s - ctx), min(len(audio), s + step + ctx)
        x = audio[a:b].astype(np.float32)
        x = (x - x.mean()) / np.sqrt(x.var() + 1e-7)
        if len(x) < 400:
            x = np.pad(x, (0, 400 - len(x)))
        logits = sess.run(None, {"input_values": x[None]})[0][0]
        logits = logits - logits.max(-1, keepdims=True)
        logp = logits - np.log(np.exp(logits).sum(-1, keepdims=True))
        # keep this window's own frames (drop the context)
        f0 = int(round((s - a) / SR * FPS))
        own = int(round(min(step, len(audio) - s) / SR * FPS))
        dst = int(round(s / SR * FPS))
        own = min(own, len(logp) - f0, n_frames - dst)
        out[dst:dst + own] = logp[f0:f0 + own]
        if on_progress:
            on_progress((k + 1) / len(starts))
    return out


@dataclass
class Token:
    word: int  # index of the word it spells
    id: int


def forced_align(logp: np.ndarray, tokens: list[int]) -> tuple[np.ndarray, np.ndarray]:
    """Viterbi CTC alignment. Returns, per token, its first frame and its peak
    log-probability (how clearly the letter was heard). ``logp`` [T, V] (blank = 0)."""
    T = logp.shape[0]
    L = len(tokens)
    if L == 0:
        return np.zeros(0, int), np.zeros(0)
    labels = np.zeros(2 * L + 1, np.int64)  # blank, t0, blank, t1, ..., blank
    labels[1::2] = tokens
    S = len(labels)
    # a skip (s-2 → s) is allowed into a token unless it repeats the previous token
    skip = np.zeros(S, bool)
    skip[3::2] = np.array(tokens[1:]) != np.array(tokens[:-1])
    neg = -np.inf
    alpha = np.full(S, neg, np.float64)
    alpha[0] = logp[0, labels[0]]
    alpha[1] = logp[0, labels[1]]
    back = np.zeros((T, S), np.int8)  # 0 stay, 1 from s-1, 2 from s-2
    for t in range(1, T):
        stay = alpha
        prev1 = np.concatenate(([neg], alpha[:-1]))
        prev2 = np.where(skip, np.concatenate(([neg, neg], alpha[:-2])), neg)
        cand = np.stack([stay, prev1, prev2])
        choice = cand.argmax(0)
        alpha = cand[choice, np.arange(S)] + logp[t, labels]
        back[t] = choice
    # end in the last token or the trailing blank
    s = int(S - 1 if alpha[S - 1] >= alpha[S - 2] else S - 2)
    path = np.empty(T, np.int64)
    for t in range(T - 1, -1, -1):
        path[t] = s
        s -= int(back[t, s])
    starts = np.full(L, -1, np.int64)
    best = np.full(L, -30.0)
    for t in range(T):
        s = path[t]
        if s % 2 == 1:
            i = s // 2
            if starts[i] < 0:
                starts[i] = t
            best[i] = max(best[i], logp[t, labels[s]])
    # tokens never visited (can't happen on a valid path, but be safe)
    for i in range(L):
        if starts[i] < 0:
            starts[i] = starts[i - 1] if i else 0
    return starts, best


@dataclass
class WordTime:
    start: float
    end: float
    score: float  # mean peak log-probability of its letters (0 = certain)


def align_words(logp: np.ndarray, words: list[str], t0: float = 0.0) -> list[Optional[WordTime]]:
    """Time each word within ``logp`` (which starts at ``t0`` seconds). Words
    with nothing the aligner can spell (numbers in some scripts, symbols) get
    None and are placed by the caller."""
    vocab = _vocab()
    ids: list[int] = []
    owner: list[int] = []
    for i, w in enumerate(words):
        for c in spell(w):
            ids.append(vocab[c])
            owner.append(i)
    if not ids:
        return [None] * len(words)
    if len(ids) > logp.shape[0]:  # more letters than frames: can't fit
        return [None] * len(words)
    starts, scores = forced_align(logp, ids)
    owner_a = np.array(owner)
    out: list[Optional[WordTime]] = [None] * len(words)
    for i in range(len(words)):
        idx = np.nonzero(owner_a == i)[0]
        if not len(idx):
            continue
        first, last = idx[0], idx[-1]
        start = starts[first] / FPS
        # a word ends where the next word's first letter starts (or its own last letter + a bit)
        nxt = starts[last + 1] if last + 1 < len(starts) else min(starts[last] + 12, logp.shape[0])
        end = max(start + 1 / FPS, min(nxt, starts[last] + 25) / FPS)
        out[i] = WordTime(t0 + start, t0 + end, float(scores[idx].mean()))
    return out
