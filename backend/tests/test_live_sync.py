"""Live sync: conditional saves (base_rev) and the change stream editors listen to."""

from __future__ import annotations

import json
import threading
import time

from conftest import main_seq


def test_conditional_saves(client):
    p = client.post("/api/projects", json={"name": "sync"}).json()
    pid, rev = p["id"], p["rev"]
    seq = main_seq(p)
    renamed = {**seq, "name": "Edited"}
    r = client.put(f"/api/projects/{pid}", json={"sequences": [renamed], "base_rev": rev})
    assert r.status_code == 200 and r.json()["rev"] == rev + 1
    # a save made from the old revision is refused instead of overwriting
    r = client.put(f"/api/projects/{pid}", json={"sequences": [{**seq, "name": "Stale"}], "base_rev": rev})
    assert r.status_code == 409
    assert main_seq(client.get(f"/api/projects/{pid}").json())["name"] == "Edited"
    # without base_rev (older clients) saves still go through; non-timeline saves don't bump rev
    r = client.put(f"/api/projects/{pid}", json={"sequences": [{**seq, "name": "Forced"}]})
    assert r.json()["rev"] == rev + 2
    r = client.put(f"/api/projects/{pid}", json={"auto_prerender": False, "base_rev": 0})
    assert r.status_code == 200 and r.json()["rev"] == rev + 2


def test_change_stream(client):
    """Over a real server (the test client buffers streams)."""
    import socket

    import httpx
    import uvicorn

    from app.main import app

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, port=port, log_level="error", lifespan="off"))
    threading.Thread(target=server.run, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            httpx.get(base + "/api/health")
            break
        except httpx.ConnectError:
            time.sleep(0.05)

    p = client.post("/api/projects", json={"name": "stream"}).json()
    pid = p["id"]
    seq = main_seq(p)
    events: list[tuple[str, dict]] = []

    def listen():
        with httpx.stream("GET", f"{base}/api/projects/{pid}/events", timeout=30) as r:
            name = None
            for line in r.iter_lines():
                if line.startswith("event: "):
                    name = line[7:]
                elif line.startswith("data: "):
                    events.append((name, json.loads(line[6:])))
                    if len(events) >= 2:
                        return

    t = threading.Thread(target=listen, daemon=True)
    t.start()
    for _ in range(100):
        if events:
            break
        time.sleep(0.05)
    try:
        assert events and events[0] == ("hello", {"rev": p["rev"]})
        httpx.put(f"{base}/api/projects/{pid}", json={"sequences": [{**seq, "name": "From AI"}]},
                  headers={"X-Yabbe-Client": "mcp-test"})
        t.join(5)
        assert events[1] == ("change", {"rev": p["rev"] + 1, "timeline": True, "client": "mcp-test"})
    finally:
        server.should_exit = True
