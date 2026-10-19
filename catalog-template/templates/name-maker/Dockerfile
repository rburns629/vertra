# Everything a product needs to run, and nothing else. Keep these lines as
# they are; add your own dependencies on the marked line.
FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170
# Security fixes released since the base image was published: CI's scan
# fails on a high or critical vulnerability that has a fix.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
# Your dependencies, if any, e.g.: RUN pip install --no-cache-dir requests==2.32.3

WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
COPY actions/ /app/actions/
RUN chmod +x /app/entrypoint.sh /app/actions/*

# Never root. The platform's mounts (/platform/input, /platform/output,
# /platform/secrets) work for any user.
ENV HOME=/tmp
USER 65532:65532

ENTRYPOINT ["/app/entrypoint.sh"]
