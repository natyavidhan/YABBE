"""Live updates: every change to a project is announced to the editors that have
it open (Server-Sent Events), so an edit made elsewhere - e.g. by an AI agent
through YABBE MCP - shows up in an open editor right away."""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any, Optional

_subs: dict[str, set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]]] = {}
_lock = threading.Lock()


def subscribe(project_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    with _lock:
        _subs.setdefault(project_id, set()).add((asyncio.get_running_loop(), q))
    return q


def unsubscribe(project_id: str, q: asyncio.Queue) -> None:
    with _lock:
        subs = _subs.get(project_id, set())
        for item in [s for s in subs if s[1] is q]:
            subs.discard(item)
        if not subs:
            _subs.pop(project_id, None)


def publish(project_id: str, event: dict[str, Any]) -> None:
    """Announce a change (callable from any thread)."""
    with _lock:
        subs = list(_subs.get(project_id, ()))
    for loop, q in subs:
        def put(q=q):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:  # a stuck client: it re-syncs when it reconnects
                pass
        try:
            loop.call_soon_threadsafe(put)
        except RuntimeError:  # loop closed
            pass


def sse(event: dict[str, Any], name: Optional[str] = None) -> str:
    return (f"event: {name}\n" if name else "") + f"data: {json.dumps(event)}\n\n"
