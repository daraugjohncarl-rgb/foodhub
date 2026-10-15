# Use official lightweight Python 3.11 image
FROM python:3.11-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/fastapi \
    CARGO_HOME=/tmp/.cargo \
    PORT=8000

# Set work directory
WORKDIR /app

# Install system dependencies (curl for health check)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies (fastapi/requirements.txt is the single source of truth)
COPY fastapi/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy full application codebase (.dockerignore keeps .env files, dumps and backups out of the image)
COPY . .

# Expose default port
EXPOSE 8000

# Minimal health endpoint (reveals nothing about the database)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8000}/health || exit 1

# Schema migrations are NOT run here: apply them by hand with `alembic upgrade head` (see DEPLOYMENT.md).
# FORWARDED_ALLOW_IPS should be the reverse proxy's address; "*" is only safe when the container is reachable
# through that proxy alone.
CMD ["sh", "-c", "cd fastapi && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips=${FORWARDED_ALLOW_IPS:-127.0.0.1}"]
