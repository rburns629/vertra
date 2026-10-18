# One image for both kernel-api and kernel-scheduler — docker-compose.yml
# selects which process to run via `command:`, matching the modular-monolith
# design (one Python package, separated through interfaces, not separate
# deployables).
FROM python:3.12-slim

WORKDIR /app

# Security fixes released since the base image was published.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY app ./app
COPY alembic.ini ./

RUN pip install --no-cache-dir .

# Not root. Numeric, so a pod's runAsNonRoot can verify it.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin acyclix
USER 10001

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
