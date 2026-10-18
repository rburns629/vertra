# SPDX-License-Identifier: MIT
"""Minimal FastAPI app used as the Cloud Run demo payload.

Independent of the gcp/app-hosting product container that deploys it (see
catalog/gcp/app-hosting/) -- app-hosting deploys whatever image it's given,
this just happens to be the one the demo points it at. Built and pushed to
a registry ahead of time; app-hosting never builds an image itself.
"""

from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def hello() -> dict[str, str]:
    return {"message": "hello world"}
