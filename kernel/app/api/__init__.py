# SPDX-License-Identifier: MIT
"""The HTTP surface: routes and their FastAPI dependencies. Talks to the rest of the kernel
only through app.services and app.persistence — no business logic lives here.
"""
