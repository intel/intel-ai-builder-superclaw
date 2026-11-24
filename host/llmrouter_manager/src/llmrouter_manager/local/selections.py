"""Pure helpers for the LRM model selection read/write endpoint."""

from __future__ import annotations

from ..common.store import Store

VALID_ROLES = frozenset({"chat", "embedding"})

# The two local backends the user may select. Kept as a strict enum: there is
# no ``auto`` value — unset means "local not configured" (see LOCAL_PROVIDER_KEY).
VALID_PROVIDERS = frozenset({"llamacpp", "edge"})

_ROLE_KEY: dict[str, str] = {
    "chat": "active_chat_model_id",
    "embedding": "active_embedding_model_id",
}

# Persisted KV naming the local backend the user picked: ``"llamacpp"`` (host
# llama-server) or ``"edge"`` (a configured edge endpoint). Unset ⇒ local not
# configured. The writer (``PUT /model-selections/local-provider``) and the
# liveness-ordered routing that consumes it land in Phase C; Phase B only needs
# the reader below so boot-resume can gate on an explicit ``"llamacpp"`` choice.
LOCAL_PROVIDER_KEY = "local_provider"


def get_local_provider(store: Store) -> str | None:
    """Return the persisted local provider (``"llamacpp"`` | ``"edge"``), or ``None``.

    ``None`` means the user has not chosen a local backend yet — local is "not
    configured" and callers must treat it as inert (no boot resume, and later a
    ``503 local_not_configured`` on the data plane).
    """
    return store.get_config(LOCAL_PROVIDER_KEY)


def set_local_provider(store: Store, provider: str) -> dict[str, object]:
    """Persist *provider* as the selected local backend and return a success payload.

    Caller is responsible for validating that *provider* is in
    ``VALID_PROVIDERS`` before calling this function.  We intentionally do NOT
    check whether that backend is actually configured/live here — selecting a
    provider only records intent; liveness-ordered routing (Phase C) decides at
    request time whether the choice can be honoured or must yield a differentiated
    ``503``.
    """
    store.set_config(LOCAL_PROVIDER_KEY, provider)
    return {"success": True, "local_provider": provider}


def clear_local_provider(store: Store) -> None:
    """Clear the persisted local provider selection (stores JSON ``null``).

    Used when the committed Edge primary Bundle is released: with no backend
    committed, ``get_local_provider`` must stop reporting the stale ``"edge"``
    intent.
    """
    store.set_config(LOCAL_PROVIDER_KEY, None)


def get_model_selections(store: Store) -> list[dict[str, str | None]]:
    return [
        {"role": "chat", "model_id": store.get_config("active_chat_model_id")},
        {"role": "embedding", "model_id": store.get_config("active_embedding_model_id")},
    ]


def set_model_selection(store: Store, role: str, model_id: str) -> dict[str, object]:
    """Persist *model_id* as the active model for *role* and return a success payload.

    Caller is responsible for validating that *role* is in ``VALID_ROLES`` and
    that *model_id* is non-empty before calling this function.  Registry
    validation (confirming the model actually exists) is intentionally deferred
    until the full registry schema is implemented.
    """
    key = _ROLE_KEY[role]
    store.set_config(key, model_id)
    return {"success": True, "role": role, "model_id": model_id}


def clear_model_selection(store: Store, role: str) -> None:
    """Clear the persisted active model for *role* (stores JSON ``null``).

    Caller is responsible for validating that *role* is in ``VALID_ROLES``.
    After this, ``get_model_selections`` reports ``model_id: None`` for the role
    and boot-resume no longer treats it as a resumable local selection.
    """
    store.set_config(_ROLE_KEY[role], None)
