"""In-memory OWT (OpenWork Token) cache + token broker (v7 §5).

**Design contract (sps_manager_todo.md §5, §10)**

* OWT lives **only** as a process-local variable.
  No SQLite / keyring / DPAPI / disk file. Ever.
* App exit → OWT evaporates. Restart path: ``POST /sandbox/control {action:"restart"}``
  triggers :meth:`verify_or_reissue` which re-mints from the backend.
* No encryption: same-user attacker with read access to keyring/DB also has
  read access to this process's memory; encryption was security theater.
* **Never** log / stdout / format-into-error the token or the host_token.
  See §10 last bullet.

This module is intentionally tiny (~80 LOC). All heavy lifting (HTTP to the
backend, error surfacing, retries) belongs to the caller —
:class:`sandbox_manager.native_backend.NativeBackendLifecycle`.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx


__all__ = ["OwtCache", "OwtIssueError", "OwtHostTokenRejected"]


class OwtIssueError(RuntimeError):
    """Generic OWT issuance failure (network / 5xx / timeout).

    Message format must NEVER include the host_token or the response body
    (the latter could echo a token in some server implementations).
    """


class OwtHostTokenRejected(OwtIssueError):
    """Backend returned 401 — the host_token we sent was rejected.

    Triggers the user-facing ``host-token-rejected`` error code (§8.3).
    The fix is a full ``reset`` (restart the backend with a fresh host_token).
    """


class OwtCache:
    """Single-process OWT holder.

    Reads are lock-free (single-pointer assignment is atomic in CPython).
    Writes (``put`` / ``clear``) take :attr:`_lock` so concurrent issue +
    reissue can't interleave a torn triple.
    """

    def __init__(self) -> None:
        self._owt: str | None = None
        self._scope: str | None = None
        self._created_at: str | None = None
        self._lock = asyncio.Lock()
        # Replaced on every put/clear, so setting the old one wakes everyone waiting on a change.
        self._changed = asyncio.Event()

    # --------------------------------------------------------------- accessors

    def get(self) -> dict[str, Any] | None:
        """Return ``{token, scope, created_at}`` or ``None`` if empty.

        Snapshot the three fields before returning so we can't observe a
        half-cleared cache.
        """
        token = self._owt
        if token is None:
            return None
        return {
            "token": token,
            "scope": self._scope,
            "created_at": self._created_at,
        }

    def is_present(self) -> bool:
        return self._owt is not None

    async def wait(self, timeout_s: float) -> dict[str, Any] | None:
        """Like :meth:`get`, but an empty cache waits up to ``timeout_s`` for its next put or clear.

        Returns the cache as it is after that change, so a cleared token is never returned.
        """
        if self._owt is not None:
            return self.get()
        changed = self._changed
        try:
            await asyncio.wait_for(changed.wait(), timeout_s)
        except TimeoutError:
            pass
        return self.get()

    def _notify_changed(self) -> None:
        self._changed.set()
        self._changed = asyncio.Event()

    # -------------------------------------------------------------- mutations

    async def put(self, token: str, scope: str, created_at: str) -> None:
        async with self._lock:
            self._owt = token
            self._scope = scope
            self._created_at = created_at
            self._notify_changed()

    async def clear(self) -> None:
        async with self._lock:
            self._owt = None
            self._scope = None
            self._created_at = None
            self._notify_changed()

    # ----------------------------------------------------------- broker calls

    async def issue(
        self,
        *,
        sandbox_url: str,
        host_token: str,
        scope: str = "owner",
        label: str = "manager-issued",
        timeout: float = 10.0,
    ) -> dict[str, Any]:
        """``POST <backend>/tokens`` and store the resulting OWT.

        On success the cache is overwritten and the new triple is returned.
        Raises :class:`OwtHostTokenRejected` on 401, :class:`OwtIssueError`
        on any other failure. Error messages are intentionally opaque to
        avoid leaking secrets — full diagnostics go via :attr:`run.error`
        constants (``host-token-rejected`` / ``owt-issue-failed``).
        """
        url = f"{sandbox_url.rstrip('/')}/tokens"
        try:
            # trust_env=False: the sandbox backend is reached over loopback
            # (127.0.0.1); a corporate HTTP_PROXY must never intercept it, and
            # httpx does not honor NO_PROXY CIDR entries such as 127.0.0.0/8.
            async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
                resp = await client.post(
                    url,
                    headers={"X-OpenWork-Host-Token": host_token},
                    json={"scope": scope, "label": label},
                )
        except httpx.HTTPError as exc:
            # Strip exception args — they could echo URL or headers in some
            # versions; surface only the class name.
            raise OwtIssueError(
                f"owt-issue-failed: transport-error ({type(exc).__name__})"
            ) from None

        if resp.status_code == 401:
            raise OwtHostTokenRejected("host-token-rejected")
        if resp.status_code >= 400:
            raise OwtIssueError(f"owt-issue-failed: http-{resp.status_code}")

        try:
            payload = resp.json()
            token = str(payload["token"])
            scope_out = str(payload.get("scope", scope))
            created_at = str(payload.get("created_at", ""))
        except (KeyError, ValueError):
            raise OwtIssueError("owt-issue-failed: malformed-response") from None

        await self.put(token, scope_out, created_at)
        return {"token": token, "scope": scope_out, "created_at": created_at}

    async def verify_or_reissue(
        self,
        *,
        sandbox_url: str,
        host_token: str,
        timeout: float = 5.0,
    ) -> dict[str, Any]:
        """Restart-path helper (puml Phase 3 simplified, §5.3).

        1. Cache empty → issue fresh.
        2. Cache present → ``GET /whoami`` with the cached token:
           * 200 → reuse, return existing triple.
           * 401 / network error → issue fresh (overwrites cache).
        """
        cached = self.get()
        if cached is None:
            return await self.issue(sandbox_url=sandbox_url, host_token=host_token)

        url = f"{sandbox_url.rstrip('/')}/whoami"
        try:
            # trust_env=False: loopback sandbox backend, must bypass any
            # corporate proxy (see issue() for the NO_PROXY-CIDR rationale).
            async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
                resp = await client.get(
                    url,
                    headers={"Authorization": f"Bearer {cached['token']}"},
                )
        except httpx.HTTPError:
            return await self.issue(sandbox_url=sandbox_url, host_token=host_token)

        if resp.status_code == 200:
            return cached
        return await self.issue(sandbox_url=sandbox_url, host_token=host_token)
