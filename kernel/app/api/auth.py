# SPDX-License-Identifier: MIT
"""Who may call kernel-api: Kubernetes ServiceAccount tokens, checked with a TokenReview.

kernel-api has no users or teams; it trusts its caller (the console) to
have authorized each request. So the one thing it must check is that the
caller really is the console. The console sends its own ServiceAccount
token, projected for this API's audience so it's useless anywhere else.
The API server's TokenReview says whose it is (and that it's valid, unexpired
and meant for this audience); the username must then be on the allowlist.

A review is remembered for a short while, so a busy console doesn't cost a
TokenReview per request. Only successful reviews are remembered, for
_CACHE_SECONDS, in a bounded cache. A TokenReview doesn't say when the
token expires, so a token can stay accepted up to that long after it
expires or its ServiceAccount is deleted.
"""

import asyncio
import hashlib
import logging
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import HTTPException, Request, status
from kubernetes import client as k8s_client

from app.config import Settings

logger = logging.getLogger(__name__)

_CACHE_SECONDS = 60.0
_CACHE_ENTRIES = 256


@dataclass(frozen=True, slots=True)
class Review:
    """A TokenReview's answer: who the token belongs to, if anyone."""

    username: str | None


# Takes a token and an audience; blocking (it calls the API server).
ReviewToken = Callable[[str, str], Review]


def kubernetes_token_review(token: str, audience: str) -> Review:
    """Asks the API server whose token this is, for this audience."""
    review = k8s_client.AuthenticationV1Api().create_token_review(
        k8s_client.V1TokenReview(
            spec=k8s_client.V1TokenReviewSpec(token=token, audiences=[audience])
        )
    )
    result = review.status
    if result is None or not result.authenticated or result.user is None:
        return Review(username=None)
    if audience not in (result.audiences or []):
        return Review(username=None)
    return Review(username=result.user.username)


class CallerAuthenticator:
    def __init__(
        self,
        *,
        review: ReviewToken,
        audience: str,
        allowed_callers: list[str],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._review = review
        self._audience = audience
        self._allowed = frozenset(allowed_callers)
        self._clock = clock
        # sha256(token) -> (username, remembered until); oldest first.
        self._cache: OrderedDict[str, tuple[str, float]] = OrderedDict()

    async def caller(self, authorization: str | None) -> str:
        """The allowed caller's username, or an HTTPException (401 or 403)."""
        token = _bearer_token(authorization)
        key = hashlib.sha256(token.encode()).hexdigest()
        now = self._clock()
        cached = self._cache.get(key)
        if cached is not None and cached[1] > now:
            return cached[0]

        review = await asyncio.to_thread(self._review, token, self._audience)
        if review.username is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token.")
        if review.username not in self._allowed:
            logger.warning("kernel-api call refused", extra={"caller": review.username})
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This caller may not use kernel-api.")

        self._cache.pop(key, None)
        self._cache[key] = (review.username, now + _CACHE_SECONDS)
        while len(self._cache) > _CACHE_ENTRIES:
            self._cache.popitem(last=False)
        return review.username


def _bearer_token(authorization: str | None) -> str:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "A bearer token is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return token.strip()


def authenticator_for(settings: Settings) -> CallerAuthenticator | None:
    """The authenticator kernel-api uses, or None when auth is disabled."""
    if settings.api_auth == "disabled":
        logger.warning("kernel-api authentication is DISABLED; for local development only")
        return None
    if not settings.api_allowed_callers:
        logger.error("API_ALLOWED_CALLERS is empty: kernel-api will refuse every request")
    return CallerAuthenticator(
        review=kubernetes_token_review,
        audience=settings.api_token_audience,
        allowed_callers=settings.api_allowed_callers,
    )


async def require_caller(request: Request) -> None:
    """FastAPI dependency on every /v1 route: refuses anyone but an allowed caller."""
    authenticator: CallerAuthenticator | None = request.app.state.authenticator
    if authenticator is None:
        return
    await authenticator.caller(request.headers.get("Authorization"))
