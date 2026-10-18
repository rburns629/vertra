FROM python:3.12-slim
COPY entrypoint.py /entrypoint.py
# Never root: steps run non-root with a read-only root filesystem (the
# kernel's task_pod_hardening); /platform/output and /tmp are writable.
USER 65532:65532
ENTRYPOINT ["python", "/entrypoint.py"]
