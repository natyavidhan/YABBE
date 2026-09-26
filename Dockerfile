# ---- build the UI -----------------------------------------------------------------
FROM node:22-slim AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- runtime: FastAPI + FFmpeg ------------------------------------------------------
FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu fonts-liberation fonts-noto-core fontconfig \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/app ./app
COPY --from=ui /ui/dist /app/frontend/dist

ENV YABBE_DATA_DIR=/data \
    YABBE_STATIC_DIR=/app/frontend/dist \
    PATH="/app/backend/.venv/bin:$PATH"
VOLUME /data
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "30"]
