FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir fastapi "uvicorn[standard]"
COPY main.py .
# Cloud Run sets $PORT and expects the container to listen on it (defaults
# to 8080 locally, where nothing sets it).
# Demo image (examples/ is exempt from the production bar): runs as root.
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
