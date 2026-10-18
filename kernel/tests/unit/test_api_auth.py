# SPDX-License-Identifier: MIT
"""kernel-api's caller check (app/api/auth.py), with a fake TokenReview."""

import pytest
from fastapi import Depends, FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient

from app.api.auth import CallerAuthenticator, Review, authenticator_for, require_caller
from app.api.routes import executions
from app.config import Settings

CONSOLE = "system:serviceaccount:acyclix-system:console-execution-console"
AUDIENCE = "acyclix-kernel-api"


class FakeReviews:
    """Token -> username, counting how often the API server would be asked."""

    def __init__(self, tokens: dict[str, str]) -> None:
        self.tokens = tokens
        self.calls = 0
        self.audiences: list[str] = []

    def __call__(self, token: str, audience: str) -> Review:
        self.calls += 1
        self.audiences.append(audience)
        return Review(username=self.tokens.get(token))


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _authenticator(
    reviews: FakeReviews, clock: FakeClock | None = None, allowed: list[str] | None = None
) -> CallerAuthenticator:
    return CallerAuthenticator(
        review=reviews,
        audience=AUDIENCE,
        allowed_callers=[CONSOLE] if allowed is None else allowed,
        clock=clock or FakeClock(),
    )


async def _status_of(authenticator: CallerAuthenticator, authorization: str | None) -> int:
    try:
        await authenticator.caller(authorization)
    except HTTPException as error:
        return error.status_code
    return 200


async def test_the_allowed_caller_gets_in() -> None:
    reviews = FakeReviews({"console-token": CONSOLE})

    assert await _authenticator(reviews).caller("Bearer console-token") == CONSOLE
    assert reviews.audiences == [AUDIENCE]


@pytest.mark.parametrize("authorization", [None, "", "Bearer ", "Basic Y29uc29sZTp4", "token"])
async def test_no_bearer_token_is_401(authorization: str | None) -> None:
    reviews = FakeReviews({})

    assert await _status_of(_authenticator(reviews), authorization) == 401
    assert reviews.calls == 0


async def test_a_token_the_api_server_rejects_is_401() -> None:
    assert await _status_of(_authenticator(FakeReviews({})), "Bearer forged") == 401


async def test_a_valid_token_from_anyone_else_is_403() -> None:
    """A task Pod's own token is valid, but it isn't the console."""
    reviews = FakeReviews({"step-token": "system:serviceaccount:team-a:default"})

    assert await _status_of(_authenticator(reviews), "Bearer step-token") == 403


async def test_an_empty_allowlist_refuses_everyone() -> None:
    reviews = FakeReviews({"console-token": CONSOLE})

    assert await _status_of(_authenticator(reviews, allowed=[]), "Bearer console-token") == 403


async def test_a_review_is_reused_until_it_expires() -> None:
    reviews = FakeReviews({"console-token": CONSOLE})
    clock = FakeClock()
    authenticator = _authenticator(reviews, clock)

    await authenticator.caller("Bearer console-token")
    clock.now += 59
    await authenticator.caller("Bearer console-token")
    assert reviews.calls == 1

    clock.now += 2
    await authenticator.caller("Bearer console-token")
    assert reviews.calls == 2


async def test_a_refusal_is_never_reused() -> None:
    reviews = FakeReviews({})
    authenticator = _authenticator(reviews)

    for _ in range(3):
        assert await _status_of(authenticator, "Bearer forged") == 401
    assert reviews.calls == 3


async def test_the_cache_stays_bounded() -> None:
    reviews = FakeReviews({f"token-{i}": CONSOLE for i in range(1000)})
    authenticator = _authenticator(reviews)

    for i in range(1000):
        await authenticator.caller(f"Bearer token-{i}")

    assert len(authenticator._cache) <= 256


async def test_a_failing_review_fails_the_request() -> None:
    """No fallback: if the API server can't be asked, nobody gets in."""

    def unreachable(token: str, audience: str) -> Review:
        raise ConnectionError("API server unreachable")

    authenticator = CallerAuthenticator(
        review=unreachable, audience=AUDIENCE, allowed_callers=[CONSOLE]
    )

    with pytest.raises(ConnectionError):
        await authenticator.caller("Bearer console-token")


def test_every_execution_route_requires_a_caller() -> None:
    assert any(dep.dependency is require_caller for dep in executions.router.dependencies)


def test_disabled_auth_has_no_authenticator() -> None:
    assert authenticator_for(Settings(api_auth="disabled")) is None
    assert authenticator_for(Settings(api_allowed_callers=[CONSOLE])) is not None


async def test_require_caller_guards_a_route() -> None:
    app = FastAPI()
    app.state.authenticator = _authenticator(FakeReviews({"console-token": CONSOLE}))

    @app.get("/guarded", dependencies=[Depends(require_caller)])
    async def guarded() -> dict[str, bool]:
        return {"ok": True}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get("/guarded")).status_code == 401
        forged = await client.get("/guarded", headers={"Authorization": "Bearer x"})
        assert forged.status_code == 401
        allowed = await client.get("/guarded", headers={"Authorization": "Bearer console-token"})
        assert allowed.status_code == 200
