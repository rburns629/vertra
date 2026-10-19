# Python 3.12 and this product's SDK. The entrypoint dispatcher
# (entrypoint.sh) is language-agnostic: language support lives only here.
FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170
# The base image's OS packages lag behind Debian's security fixes; catalog
# CI's image scan fails on any high or critical CVE that has a fix.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
# Majors pinned: these SDKs rename things between them.
RUN pip install --no-cache-dir 'azure-identity~=1.26' 'azure-mgmt-resource~=26.0'

WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
COPY actions/ /app/actions/
RUN chmod +x /app/entrypoint.sh /app/actions/*

# Never root. The platform's mounts (/platform/input, /platform/output,
# /platform/secrets) work for any user.
ENV HOME=/tmp
USER 65532:65532

ENTRYPOINT ["/app/entrypoint.sh"]
