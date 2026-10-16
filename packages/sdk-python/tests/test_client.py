"""loomail Python SDK tests. A real local HTTP server stands in for Loomail, so the whole path
is exercised: headers, bodies, retries, timeouts, a dead port."""
import asyncio
import json
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from loomail import (
    MAX_BATCH_ITEMS,
    AsyncLoomail,
    Identify,
    Loomail,
    LoomailError,
    Track,
)


class FakeLoomail:
    """Records requests; `respond(n, seen)` returns (status, body, headers) or None to hang."""

    def __init__(self):
        self.seen = []
        self.respond = lambda n, seen: (200, {"success": True, "deduplicated": False}, {})
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                entry = {
                    "path": self.path,
                    "auth": self.headers.get("Authorization"),
                    "ua": self.headers.get("User-Agent"),
                    "body": json.loads(raw) if raw else None,
                }
                outer.seen.append(entry)
                answer = outer.respond(len(outer.seen), entry)
                if answer is None:
                    threading.Event().wait(1.0)  # hang long enough to trip a short client timeout
                    return
                status, body, headers = answer
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.host = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def fake():
    f = FakeLoomail()
    yield f
    f.close()


@pytest.fixture
def client(fake):
    return Loomail("mf_live_test", host=fake.host, sleep=lambda s: None)


def test_identify_sends_bearer_key_traits_and_generated_message_id(fake, client):
    client.identify("u1", {"email": "a@b.c", "plan": "trial"})
    (req,) = fake.seen
    assert req["path"] == "/v1/identify"
    assert req["auth"] == "Bearer mf_live_test"
    assert req["ua"].startswith("loomail-python/")
    assert req["body"]["userId"] == "u1"
    assert req["body"]["traits"] == {"email": "a@b.c", "plan": "trial"}
    assert len(req["body"]["messageId"]) == 36


def test_track_sends_properties_context_and_timestamp_with_offset(fake, client):
    when = datetime(2026, 5, 1, 10, 0, tzinfo=timezone(timedelta(hours=2)))
    client.track("u1", "paid", {"amount": 4900}, timestamp=when, context={"ip": "1.2.3.4"})
    body = fake.seen[0]["body"]
    assert fake.seen[0]["path"] == "/v1/track"
    assert body["event"] == "paid" and body["properties"] == {"amount": 4900}
    assert body["timestamp"] == "2026-05-01T08:00:00+00:00"  # normalised to UTC
    assert body["context"] == {"ip": "1.2.3.4"}


def test_naive_datetime_is_taken_as_utc(fake, client):
    client.track("u1", "e", timestamp=datetime(2026, 5, 1, 10, 0))
    assert fake.seen[0]["body"]["timestamp"] == "2026-05-01T10:00:00+00:00"


def test_omits_fields_you_did_not_set(fake, client):
    client.track("u1", "e")
    assert set(fake.seen[0]["body"]) == {"userId", "event", "properties", "messageId"}


def test_own_message_id_is_used_and_a_repeat_is_reported(fake, client):
    fake.respond = lambda n, s: (200, {"success": True, "deduplicated": True}, {})
    result = client.track("u1", "paid", message_id="paid:inv_9")
    assert fake.seen[0]["body"]["messageId"] == "paid:inv_9"
    assert result.deduplicated is True


def test_trailing_slash_on_host_is_stripped(fake):
    Loomail("mf_live_x", host=fake.host + "///").track("u1", "e")
    assert fake.seen[0]["path"] == "/v1/track"


def test_bad_arguments_fail_before_any_request(fake, client):
    for call in (
        lambda: client.track("", "e"),
        lambda: client.track("u1", "  "),
        lambda: client.identify(None),
        lambda: client.track("u1", "e", timestamp="not a date"),
        lambda: client.track("u1", "e", timestamp=12345),
    ):
        with pytest.raises(LoomailError) as exc:
            call()
        assert exc.value.code == "invalid_argument"
    assert fake.seen == []


def test_publishable_key_is_refused():
    with pytest.raises(LoomailError, match="publishable"):
        Loomail("mf_pub_abc")


def test_key_comes_from_env(monkeypatch, fake):
    monkeypatch.delenv("LOOMAIL_SECRET_KEY", raising=False)
    with pytest.raises(LoomailError):
        Loomail(host=fake.host)
    monkeypatch.setenv("LOOMAIL_SECRET_KEY", "mf_live_env")
    monkeypatch.setenv("LOOMAIL_HOST", fake.host)
    Loomail().track("u1", "e")
    assert fake.seen[0]["auth"] == "Bearer mf_live_env"


def test_retries_a_503_and_resends_the_same_message_id(fake, client):
    fake.respond = lambda n, s: (503, {"error": "down"}, {}) if n < 3 else (200, {"success": True}, {})
    client.track("u1", "e")
    assert len(fake.seen) == 3
    assert len({s["body"]["messageId"] for s in fake.seen}) == 1


def test_waits_retry_after_on_a_429(fake):
    waits = []
    fake.respond = lambda n, s: (429, {}, {"Retry-After": "2"}) if n == 1 else (200, {"success": True}, {})
    Loomail("mf_live_x", host=fake.host, sleep=waits.append).track("u1", "e")
    assert waits == [2.0]


def test_gives_up_after_max_retries(fake):
    fake.respond = lambda n, s: (500, {"error": "boom"}, {})
    c = Loomail("mf_live_x", host=fake.host, max_retries=2, sleep=lambda s: None)
    with pytest.raises(LoomailError) as exc:
        c.track("u1", "e")
    assert exc.value.code == "server" and exc.value.status == 500
    assert len(fake.seen) == 3


@pytest.mark.parametrize(
    "status,code", [(401, "unauthorized"), (402, "plan_limit"), (403, "forbidden"), (400, "validation"), (422, "validation")]
)
def test_does_not_retry_client_errors(fake, client, status, code):
    fake.respond = lambda n, s: (status, {"error": "no"}, {})
    with pytest.raises(LoomailError) as exc:
        client.track("u1", "e")
    assert exc.value.code == code and exc.value.status == status
    assert len(fake.seen) == 1


def test_error_keeps_the_servers_explanation(fake, client):
    fake.respond = lambda n, s: (402, {"error": "Contact limit reached"}, {})
    with pytest.raises(LoomailError) as exc:
        client.track("u1", "e")
    assert "Contact limit reached" in str(exc.value)
    assert exc.value.body == {"error": "Contact limit reached"}


def test_network_error_when_nothing_is_listening():
    c = Loomail("mf_live_x", host="http://127.0.0.1:1", max_retries=0)
    with pytest.raises(LoomailError) as exc:
        c.track("u1", "e")
    assert exc.value.code == "network"


def test_times_out_on_a_server_that_never_answers(fake):
    fake.respond = lambda n, s: None
    c = Loomail("mf_live_x", host=fake.host, timeout=0.2, max_retries=0)
    with pytest.raises(LoomailError) as exc:
        c.track("u1", "e")
    assert exc.value.code == "network"


# ----------------------------------------------------------------------- batch


def tracks(n):
    return [Track(f"u{i}", "e") for i in range(n)]


def test_batch_splits_at_100_and_totals_results(fake, client):
    fake.respond = lambda n, s: (200, {"success": True, "received": len(s["body"]["batch"]), "errors": []}, {})
    result = client.batch(tracks(250))
    assert [len(s["body"]["batch"]) for s in fake.seen] == [MAX_BATCH_ITEMS, MAX_BATCH_ITEMS, 50]
    assert all(s["path"] == "/v1/batch" for s in fake.seen)
    assert result.received == 250 and result.errors == []


def test_batch_maps_item_errors_to_original_positions(fake, client):
    def respond(n, s):
        errors = [{"index": 4, "message": "boom", "code": "plan_limit"}] if n == 2 else []
        return 200, {"success": True, "received": len(s["body"]["batch"]) - len(errors), "errors": errors}, {}

    fake.respond = respond
    result = client.batch(tracks(150))
    assert result.received == 149
    (err,) = result.errors
    assert (err.index, err.message, err.code) == (104, "boom", "plan_limit")  # 100 + 4


def test_batch_mixes_identify_and_track_and_keeps_explicit_ids(fake, client):
    client.batch(
        [
            Identify("u1", {"plan": "paid"}),
            Track("u1", "paid", message_id="paid:1", timestamp=datetime(2026, 5, 1, tzinfo=timezone.utc)),
        ]
    )
    a, b = fake.seen[0]["body"]["batch"]
    assert a["type"] == "identify" and a["traits"] == {"plan": "paid"} and a["messageId"]
    assert b["type"] == "track" and b["messageId"] == "paid:1" and b["timestamp"] == "2026-05-01T00:00:00+00:00"


def test_batch_names_the_bad_item_and_sends_nothing(fake, client):
    with pytest.raises(LoomailError, match=r"batch\[2\]"):
        client.batch([*tracks(2), Track("", "e")])
    with pytest.raises(LoomailError, match=r"batch\[0\]"):
        client.batch([{"type": "track"}])
    assert fake.seen == []


def test_empty_batch_does_nothing(fake, client):
    result = client.batch([])
    assert result.received == 0 and fake.seen == []


def test_batch_splits_on_size_even_under_100_items(fake, client):
    fake.respond = lambda n, s: (200, {"success": True, "received": len(s["body"]["batch"]), "errors": []}, {})
    fat = [Track(f"u{i}", "e", {"blob": "x" * 10_000}) for i in range(60)]  # ~600 KB
    result = client.batch(fat)
    assert len(fake.seen) > 1 and result.received == 60


# ----------------------------------------------------------------------- async


def test_async_client_sends_the_same_calls(fake):
    fake.respond = lambda n, s: (200, {"success": True, "received": 1, "errors": []} if s["path"] == "/v1/batch" else {"success": True}, {})

    async def go():
        c = AsyncLoomail("mf_live_x", host=fake.host)
        await c.identify("u1", {"plan": "free"})
        await c.track("u1", "e", {"a": 1})
        return await c.batch([Track("u1", "b")])

    result = asyncio.run(go())
    assert [s["path"] for s in fake.seen] == ["/v1/identify", "/v1/track", "/v1/batch"]
    assert result.received == 1
