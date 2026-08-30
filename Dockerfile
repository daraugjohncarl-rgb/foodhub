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

# Install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy full application codebase
COPY . .

# Expose default port
EXPOSE 8000

# Health check against database health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8000}/test-db || exit 1

# Start the FastAPI application with uvicorn
CMD ["sh", "-c", "cd fastapi && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
