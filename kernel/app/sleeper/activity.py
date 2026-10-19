# SPDX-License-Identifier: MIT
"""What the kernel's own data says about activity."""

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.states import TERMINAL_EXECUTION_STATES
from app.persistence.models import Execution, ExecutionEvent


@dataclass(frozen=True)
class KernelActivity:
    # An execution not yet finished: steps running, or waiting to.
    busy: bool
    # The last execution event (submitted, a step's change, finished).
    last: datetime | None


async def kernel_activity(session: AsyncSession) -> KernelActivity:
    unfinished = exists().where(Execution.state.not_in(TERMINAL_EXECUTION_STATES))
    busy = bool(await session.scalar(select(unfinished)))
    last = await session.scalar(select(func.max(ExecutionEvent.created_at)))
    return KernelActivity(busy=busy, last=last)
