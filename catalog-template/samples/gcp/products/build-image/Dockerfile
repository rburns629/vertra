# This product's language support (python3.12, per product.yaml's `runtime`
# field) is declared here, and only here -- the entrypoint dispatcher
# (entrypoint.sh) is language-agnostic on purpose, so a product that needed
# a second action in a different language would only ever have to change
# this file, not the dispatch mechanism.
FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170
# The base image's OS packages lag behind Debian's security fixes; catalog
# CI's image scan fails on any high or critical CVE that has a fix.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir google-cloud-build google-cloud-artifact-registry

WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
COPY actions/ /app/actions/
RUN chmod +x /app/entrypoint.sh /app/actions/*

# Not root: nothing here needs it, and a compromised action running as root
# has far more room to break out of its container. The kernel's mounts
# (/platform/input, /platform/output, /platform/secrets) work for any user.
ENV HOME=/tmp
USER 65532:65532

ENTRYPOINT ["/app/entrypoint.sh"]
