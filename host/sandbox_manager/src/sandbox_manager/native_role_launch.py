"""How Sandbox Manager launches native backend roles: one at a time, or several at once.

Each role still starts through its own :func:`~sandbox_manager.broker_client.start_role` call, so each
keeps its own unelevated launcher, Job, pipes, bounded waits and typed refusals, and Sandbox Manager
stays the only owner of their lifecycle. For roles started together this module decides two things
only: how many of those calls are in flight at once, and what a failure looks like from outside.

* Every launch finishes before anything is reported, and every one that started is handed to ``adopt``
  first. The caller's unwind therefore finds all of them, and no Job outlives a failed start unowned.
* The failure raised is the earliest one in the order given, which is the one a start that launched
  the same roles one after another would have stopped at.

Which roles are independent is the caller's decision. The caller also passes every launch of one start
the same :class:`~sandbox_manager.broker_client.ProvisionRepair`, so a drift that several concurrent
launches report costs one elevated repair rather than one each.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import TypeVar

from loguru import logger

from .broker_client import BrokerLaunch

Launch = TypeVar("Launch")


def start_role_logged(
    start: Callable[..., BrokerLaunch],
    *,
    role: str,
    scalars: dict[str, str | int],
    **common: object,
) -> BrokerLaunch:
    """One ``start`` call for ``role``, bracketed by its begin, started and failed lifecycle lines."""
    logger.info(
        "native-backend: role lifecycle phase=start event=begin role={}",
        role,
    )
    try:
        launch = start(role=role, scalars=scalars, **common)
    except Exception as exc:
        logger.error(
            "native-backend: role lifecycle phase=start event=failed "
            "role={} exception_type={}",
            role,
            type(exc).__name__,
        )
        raise
    logger.info(
        "native-backend: role lifecycle phase=start event=started "
        "role={} role_pid={}",
        role,
        launch.pid,
    )
    return launch


def start_roles_concurrently(
    roles: Sequence[tuple[str, dict[str, str | int]]],
    *,
    start: Callable[[str, dict[str, str | int]], Launch],
    adopt: Callable[[str, Launch], None],
) -> None:
    """Start every role at once, adopt each launch that started, then raise the first failure."""
    if not roles:
        return
    # One thread per role: ``roles`` is a closed list written out by the caller, not caller input.
    with ThreadPoolExecutor(max_workers=len(roles), thread_name_prefix="native-role-start") as pool:
        futures = [(role, pool.submit(start, role, scalars)) for role, scalars in roles]
    failure: BaseException | None = None
    for role, future in futures:
        error = future.exception()
        if error is None:
            adopt(role, future.result())
        elif failure is None:
            failure = error
    if failure is not None:
        raise failure
