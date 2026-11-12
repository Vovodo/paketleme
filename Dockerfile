# ==============================================================================
# Stage 1: React (Vite) Frontend Build
# ==============================================================================
FROM node:22-alpine AS frontend-builder

WORKDIR /build/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


# ==============================================================================
# Stage 2: FastAPI Production Runtime (Serves API + Built React SPA)
# ==============================================================================
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r ./backend/requirements.txt

COPY backend/ ./backend/
COPY --from=frontend-builder /build/frontend/dist ./frontend/dist

WORKDIR /app/backend

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8000}/api/health || exit 1

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
