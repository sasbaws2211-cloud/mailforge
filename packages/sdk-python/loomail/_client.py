"""Server-side client for Loomail's ingestion API.

Standard library only. Sends identify and track calls with a secret key (``mf_live_...``),
retries what is safe to retry, and never double-counts: every call carries a ``message_id``,
which Loomail uses to drop repeats.

    from loomail import Loomail

    loomail = Loomail(secret_key="mf_live_...")
    loomail.identify("user_123", {"email": "a@b.c", "plan": "trial"})
    loomail.track("user_123", "signed_up", {"source": "ads"})

Methods raise ``LoomailError`` when Loomail cannot be reached or refuses the call. In a request
path that means a Loomail outage can fail the request, so wrap fire-and-forget calls in
``try/except LoomailError``.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import socket
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Union

__version__ = "0.1.0"

#: Where events go when ``host`` / ``LOOMAIL_HOST`` is not given.
DEFAULT_HOST = "https://loomail.site"

#: Loomail rejects a batch of more than 100 items or more than 512 KB.
MAX_BATCH_ITEMS = 100
_MAX_BATCH_BYTES = 400 * 1024  # headroom under the server's 512 KB body limit

Timestamp = Union[datetime, str]


class LoomailError(Exception):
    """Raised when a call did not go through.

    ``code`` is one of: ``invalid_argument`` (caught before any request), ``unauthorized`` (401),
    ``forbidden`` (403), ``plan_limit`` (402: the workspace is at its contact limit), ``validation``
    (400/422), ``rate_limited`` (429, still failing after retries), ``server`` (5xx, still failing
    after retries), ``network`` (could not reach Loomail, or no answer in time).
    """

    def __init__(self, code: str, message: str, *, status: Optional[int] = None, body: Any = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.body = body


@dataclass
class CallResult:
    #: True when Loomail had already seen this message_id and ignored the repeat.
    deduplicated: bool = False


@dataclass
class BatchError:
    #: Position of the item in the list you passed.
    index: int
    message: str
    #: ``"plan_limit"`` when the item was refused because the workspace is at its contact limit.
    code: Optional[str] = None


@dataclass
class BatchResult:
    #: Items Loomail accepted (repeats of a message_id count as accepted).
    received: int = 0
    #: Items Loomail refused. The rest of the batch is unaffected.
    errors: List[BatchError] = field(default_factory=list)


@dataclass
class Identify:
    """A batch item that creates or updates a person."""

    user_id: str
    traits: Optional[Dict[str, Any]] = None
    timestamp: Optional[Timestamp] = None
    message_id: Optional[str] = None
    context: Optional[Dict[str, Any]] = None


@dataclass
class Track:
    """A batch item that records something a person did."""

    user_id: str
    event: str
    properties: Optional[Dict[str, Any]] = None
    timestamp: Optional[Timestamp] = None
    message_id: Optional[str] = None
    context: Optional[Dict[str, Any]] = None


def _iso(ts: Optional[Timestamp]) -> Optional[str]:
    if ts is None:
        return None
    if isinstance(ts, datetime):
        # A naive datetime is taken to be UTC; Loomail needs an offset on the wire.
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return ts.astimezone(timezone.utc).isoformat()
    if isinstance(ts, str):
        try:
            datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            raise LoomailError("invalid_argument", f"timestamp is not a valid date: {ts!r}") from None
        return ts
    raise LoomailError("invalid_argument", f"timestamp must be a datetime or an ISO string, got {type(ts).__name__}")


def _require_str(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise LoomailError("invalid_argument", f"{name} must be a non-empty string")
    return value


def _code_for_status(status: int) -> str:
    return {401: "unauthorized", 402: "plan_limit", 403: "forbidden", 429: "rate_limited"}.get(
        status, "server" if status >= 500 else "validation"
    )


def _message_for(status: int, body: Any) -> str:
    detail = f": {body['error']}" if isinstance(body, dict) and isinstance(body.get("error"), str) else ""
    return f"Loomail answered {status}{detail}"


def _retry_after(headers: Any) -> Optional[float]:
    raw = headers.get("Retry-After") if headers is not None else None
    try:
        secs = float(raw) if raw is not None else None
    except ValueError:
        return None
    return secs if secs is not None and secs >= 0 else None


def _backoff(attempt: int) -> float:
    """0.5s, 1s, 2s... with up to 25% jitter."""
    base = 0.5 * (2**attempt)
    return base + random.random() * base * 0.25


def _clean(payload: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in payload.items() if v is not None}


class Loomail:
    """Synchronous client. Safe to share between threads."""

    def __init__(
        self,
        secret_key: Optional[str] = None,
        *,
        host: Optional[str] = None,
        timeout: float = 10.0,
        max_retries: int = 3,
        sleep: Callable[[float], None] = time.sleep,
    ):
        key = secret_key or os.environ.get("LOOMAIL_SECRET_KEY")
        if not key:
            raise LoomailError("invalid_argument", "secret_key is required (or set LOOMAIL_SECRET_KEY)")
        if key.startswith("mf_pub_"):
            raise LoomailError(
                "invalid_argument",
                "That is a publishable key (mf_pub_...), meant for browsers. "
                "Server code needs a secret key (mf_live_...).",
            )
        self._key = key
        self._host = (host or os.environ.get("LOOMAIL_HOST") or DEFAULT_HOST).rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._sleep = sleep

    # ------------------------------------------------------------------ public

    def identify(
        self,
        user_id: str,
        traits: Optional[Dict[str, Any]] = None,
        *,
        timestamp: Optional[Timestamp] = None,
        message_id: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> CallResult:
        """Create or update a person. Traits merge into what Loomail already knows; ``None`` removes one."""
        body = self._identify_body(user_id, traits, timestamp, message_id, context)
        return self._send("/v1/identify", body)

    def track(
        self,
        user_id: str,
        event: str,
        properties: Optional[Dict[str, Any]] = None,
        *,
        timestamp: Optional[Timestamp] = None,
        message_id: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> CallResult:
        """Record something a person did."""
        body = self._track_body(user_id, event, properties, timestamp, message_id, context)
        return self._send("/v1/track", body)

    def batch(self, items: Sequence[Union[Identify, Track]]) -> BatchResult:
        """Send many ``Identify`` / ``Track`` items.

        Splits into requests of at most 100 items (and under the size limit), so any length is fine.
        A refused item lands in ``errors`` and does not stop the rest; a request that fails outright
        (bad key, outage after retries) raises.
        """
        prepared: List[Dict[str, Any]] = []
        for i, item in enumerate(items):
            try:
                if isinstance(item, Identify):
                    body = self._identify_body(item.user_id, item.traits, item.timestamp, item.message_id, item.context)
                    prepared.append({"type": "identify", **body})
                elif isinstance(item, Track):
                    body = self._track_body(
                        item.user_id, item.event, item.properties, item.timestamp, item.message_id, item.context
                    )
                    prepared.append({"type": "track", **body})
                else:
                    raise LoomailError("invalid_argument", "must be an Identify or a Track")
            except LoomailError as e:
                raise LoomailError("invalid_argument", f"batch[{i}]: {e}") from None

        result = BatchResult()
        chunk: List[Dict[str, Any]] = []
        chunk_bytes = 0
        chunk_start = 0

        def flush() -> None:
            nonlocal chunk, chunk_bytes, chunk_start
            if not chunk:
                return
            res = self._post("/v1/batch", {"batch": chunk}) or {}
            result.received += int(res.get("received", 0))
            for err in res.get("errors", []):
                result.errors.append(
                    BatchError(index=int(err["index"]) + chunk_start, message=str(err.get("message", "")), code=err.get("code"))
                )
            chunk_start += len(chunk)
            chunk = []
            chunk_bytes = 0

        for entry in prepared:
            size = len(json.dumps(entry)) + 1
            if len(chunk) >= MAX_BATCH_ITEMS or (chunk and chunk_bytes + size > _MAX_BATCH_BYTES):
                flush()
            chunk.append(entry)
            chunk_bytes += size
        flush()
        return result

    # ----------------------------------------------------------------- private

    @staticmethod
    def _identify_body(user_id, traits, timestamp, message_id, context) -> Dict[str, Any]:
        return _clean(
            {
                "userId": _require_str(user_id, "user_id"),
                "traits": traits or {},
                "timestamp": _iso(timestamp),
                "context": context,
                "messageId": message_id or str(uuid.uuid4()),
            }
        )

    @staticmethod
    def _track_body(user_id, event, properties, timestamp, message_id, context) -> Dict[str, Any]:
        return _clean(
            {
                "userId": _require_str(user_id, "user_id"),
                "event": _require_str(event, "event"),
                "properties": properties or {},
                "timestamp": _iso(timestamp),
                "context": context,
                "messageId": message_id or str(uuid.uuid4()),
            }
        )

    def _send(self, path: str, body: Dict[str, Any]) -> CallResult:
        res = self._post(path, body)
        return CallResult(deduplicated=isinstance(res, dict) and res.get("deduplicated") is True)

    def _post(self, path: str, body: Dict[str, Any]) -> Any:
        """One POST with retries. Every body here carries a message_id, so repeating it is safe."""
        payload = json.dumps(body).encode("utf-8")
        attempt = 0
        while True:
            request = urllib.request.Request(
                self._host + path,
                data=payload,
                method="POST",
                headers={
                    "Authorization": f"Bearer {self._key}",
                    "Content-Type": "application/json",
                    "User-Agent": f"loomail-python/{__version__}",
                },
            )
            wait: float
            try:
                with urllib.request.urlopen(request, timeout=self._timeout) as resp:
                    return _parse(resp.read())
            except urllib.error.HTTPError as e:
                parsed = _parse(e.read())
                retryable = e.code == 429 or e.code >= 500
                if not retryable or attempt >= self._max_retries:
                    raise LoomailError(
                        _code_for_status(e.code), _message_for(e.code, parsed), status=e.code, body=parsed
                    ) from None
                wait = _retry_after(e.headers)
                if wait is None:
                    wait = _backoff(attempt)
            except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
                if attempt >= self._max_retries:
                    raise LoomailError("network", f"Could not reach Loomail at {self._host}: {e}") from e
                wait = _backoff(attempt)
            self._sleep(min(wait, 30.0))
            attempt += 1


def _parse(raw: bytes) -> Any:
    text = raw.decode("utf-8", "replace") if raw else ""
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return text


class AsyncLoomail:
    """Async client for asyncio code (FastAPI, aiohttp and so on).

    Same methods as ``Loomail``, awaited. The work runs on a worker thread, so a slow Loomail never
    blocks the event loop, and no extra dependency is needed.
    """

    def __init__(self, secret_key: Optional[str] = None, **options: Any):
        self._sync = Loomail(secret_key, **options)  # its blocking sleep runs on the worker thread

    async def identify(self, *args: Any, **kwargs: Any) -> CallResult:
        return await asyncio.to_thread(self._sync.identify, *args, **kwargs)

    async def track(self, *args: Any, **kwargs: Any) -> CallResult:
        return await asyncio.to_thread(self._sync.track, *args, **kwargs)

    async def batch(self, items: Sequence[Union[Identify, Track]]) -> BatchResult:
        return await asyncio.to_thread(self._sync.batch, items)
