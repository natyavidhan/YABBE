"""Download the models lyrics timing uses into ``<dir>`` (default: models/lyrics).

    python backend/tools/get_lyrics_models.py [dir]

* aligner.onnx - Meta's MMS-300m forced aligner (1130 languages), 4-bit ONNX
  build from onnx-community. License: CC-BY-NC-4.0 (non-commercial use only).
* vocals.onnx - Kim_Vocal_2, an MDX-Net vocal separation model from the
  Ultimate Vocal Remover project.

Files are pinned by URL (commit) and checked by SHA-256.
"""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

HF = "https://huggingface.co/onnx-community/mms-300m-1130-forced-aligner-ONNX/resolve/2100fb247d8e43962eef24491597fbeb8b469531"
FILES = {
    "aligner.onnx": (f"{HF}/onnx/model_q4.onnx", "b6ebc85a3c80059474f14747b8e72f944b49238d32a1c413b9b958e618e204b2"),
    "vocab.json": (f"{HF}/vocab.json", "0ff83fc9d044537f7c72d92db15b04917f1e50cada799957963bca61e4305971"),
    "aligner_config.json": (f"{HF}/preprocessor_config.json",
                            "a2254a5b58f72cd4de3632f8eee64f3f098b7c1402128d2f419e7d00ae13e335"),
    "vocals.onnx": ("https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx",
                    "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b"),
}
NOTICE = """\
aligner.onnx, vocab.json, aligner_config.json:
  MMS-300m forced aligner (Meta AI; ONNX build by onnx-community,
  https://huggingface.co/onnx-community/mms-300m-1130-forced-aligner-ONNX).
  License: CC-BY-NC-4.0 - non-commercial use only.
vocals.onnx:
  Kim_Vocal_2 (MDX-Net) from Ultimate Vocal Remover,
  https://github.com/TRvlvr/model_repo
"""


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "models" / "lyrics")
    out.mkdir(parents=True, exist_ok=True)
    for name, (url, digest) in FILES.items():
        dest = out / name
        if dest.is_file() and sha256(dest) == digest:
            print(f"{name}: already there")
            continue
        print(f"{name}: downloading {url}")
        tmp = dest.with_suffix(dest.suffix + ".part")
        req = urllib.request.Request(url, headers={"User-Agent": "yabbe-model-fetch"})
        with urllib.request.urlopen(req, timeout=120) as res, open(tmp, "wb") as fh:
            while chunk := res.read(1 << 20):
                fh.write(chunk)
        got = sha256(tmp)
        if got != digest:
            tmp.unlink()
            sys.exit(f"{name}: checksum mismatch ({got})")
        tmp.replace(dest)
    (out / "NOTICE").write_text(NOTICE)
    print("done:", out)


if __name__ == "__main__":
    main()
