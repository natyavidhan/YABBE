# YABBE — Yet Another Browser Based Editor
# One image = UI + API + FFmpeg. Run it with:
#   docker run -d -p 8000:8000 -v yabbe-data:/data ghcr.io/natyavidhan/yabbe:latest

# ---- build the UI (always on the build machine's arch; output is static files) -----
FROM --platform=$BUILDPLATFORM node:22-slim AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- roto brush model: Meta's EdgeTAM (Apache-2.0) exported to ONNX -------------------
# PyTorch is only needed here, to export; the app runs the graphs with ONNX Runtime.
FROM python:3.12-slim AS models
ARG EDGETAM_COMMIT=7711e012a30a2402c4eaab637bdb00a521302c91
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir onnx hydra-core iopath pillow tqdm timm huggingface_hub setuptools
RUN git clone https://github.com/facebookresearch/EdgeTAM.git /edgetam \
 && cd /edgetam && git checkout "$EDGETAM_COMMIT" \
 && SAM2_BUILD_CUDA=0 pip install --no-cache-dir --no-deps --no-build-isolation -e .
COPY backend/tools/export_edgetam.py /export_edgetam.py
RUN mkdir -p /models/edgetam && cd /edgetam \
 && python /export_edgetam.py /models/edgetam \
 && cp LICENSE /models/edgetam/LICENSE

# ---- runtime: FastAPI + FFmpeg ------------------------------------------------------
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini fontconfig fonts-dejavu-core fonts-liberation fonts-noto-core \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 yabbe \
 && useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin yabbe

# Static, multi-arch FFmpeg build (far smaller than Debian's ffmpeg + libs).
COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /ffprobe /usr/local/bin/

WORKDIR /app/backend
ENV UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/local/bin/python3 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
COPY backend/pyproject.toml backend/uv.lock ./
# uv is only needed at build time, so mount it instead of shipping it.
RUN --mount=from=ghcr.io/astral-sh/uv:0.12,source=/uv,target=/usr/local/bin/uv \
    uv sync --frozen --no-dev --no-install-project && rm -rf /root/.cache
COPY backend/app ./app
COPY --from=ui /ui/dist /app/frontend/dist
COPY --from=models /models /app/models
COPY docker/entrypoint.sh /usr/local/bin/yabbe-entrypoint
RUN chmod +x /usr/local/bin/yabbe-entrypoint && mkdir -p /data && chown yabbe:yabbe /data

ENV YABBE_DATA_DIR=/data \
    YABBE_MODELS_DIR=/app/models \
    YABBE_STATIC_DIR=/app/frontend/dist \
    PATH="/app/backend/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PUID=1000 \
    PGID=1000

VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"

# tini reaps the ffmpeg child processes and forwards signals for clean shutdown.
ENTRYPOINT ["tini", "--", "yabbe-entrypoint"]
# A single process on purpose: background jobs live in memory.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "30", "--proxy-headers", "--forwarded-allow-ips", "*"]
