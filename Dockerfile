# Build from the repository root:  docker build -t inbox-pos .
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

# Run as an unprivileged user.
RUN useradd --create-home --uid 10001 appuser
WORKDIR /app

COPY fastapi/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip && pip install --no-cache-dir -r requirements.txt

# Only the deployed application tree is copied (see .dockerignore for exclusions).
COPY --chown=appuser:appuser fastapi/ ./fastapi/
WORKDIR /app/fastapi
USER appuser

EXPOSE 8000

# Liveness only: no database detail is disclosed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT','8000'), timeout=4).status==200 else 1)"

# Schema migrations are a separate release step (docs/DEPLOYMENT.md), never run at container start.
# Behind a reverse proxy set TRUSTED_PROXY_COUNT (see .env.example) so rate limits see the real client IP.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
