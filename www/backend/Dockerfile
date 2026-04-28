FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        libmagic1 curl build-essential \
    && rm -rf /var/lib/apt/lists/*

# Dependencies werden aus pyproject.toml installiert (zur Build-Zeit).
# Der Anwendungscode wird per bind-mount auf /app gehängt (siehe docker-compose.yml).
COPY pyproject.toml ./
RUN pip install --no-cache-dir uv && uv pip install --system ".[dev]"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -fsS http://localhost:8000/healthz || exit 1

CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload --proxy-headers"]
