import uuid

from httpx import AsyncClient


async def test_create_and_get_task(client: AsyncClient, auth_headers: dict):
    tid = str(uuid.uuid4())
    payload = {"title": "Bug fixen", "status": "todo", "priority": 1, "position": 0}
    r = await client.put(f"/tasks/{tid}", json=payload, headers=auth_headers)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["id"] == tid
    assert out["title"] == "Bug fixen"
    assert out["status"] == "todo"
    assert out["priority"] == 1

    r = await client.get(f"/tasks/{tid}", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["title"] == "Bug fixen"


async def test_list_tasks(client: AsyncClient, auth_headers: dict):
    for i in range(3):
        tid = str(uuid.uuid4())
        await client.put(
            f"/tasks/{tid}",
            json={"title": f"Task {i}", "status": "backlog"},
            headers=auth_headers,
        )
    r = await client.get("/tasks", headers=auth_headers)
    assert r.status_code == 200
    assert len(r.json()) == 3


async def test_list_tasks_filter_status(client: AsyncClient, auth_headers: dict):
    t1 = str(uuid.uuid4())
    t2 = str(uuid.uuid4())
    await client.put(
        f"/tasks/{t1}", json={"title": "A", "status": "todo"}, headers=auth_headers
    )
    await client.put(
        f"/tasks/{t2}", json={"title": "B", "status": "done"}, headers=auth_headers
    )
    r = await client.get("/tasks?status=todo", headers=auth_headers)
    assert r.status_code == 200
    tasks = r.json()
    assert len(tasks) == 1
    assert tasks[0]["status"] == "todo"


async def test_update_task(client: AsyncClient, auth_headers: dict):
    tid = str(uuid.uuid4())
    r = await client.put(
        f"/tasks/{tid}",
        json={"title": "v1", "status": "backlog"},
        headers=auth_headers,
    )
    assert r.status_code == 200

    r = await client.put(
        f"/tasks/{tid}",
        json={"title": "v2", "status": "doing"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["title"] == "v2"
    assert r.json()["status"] == "doing"


async def test_optimistic_locking(client: AsyncClient, auth_headers: dict):
    tid = str(uuid.uuid4())
    r = await client.put(
        f"/tasks/{tid}",
        json={"title": "v1", "status": "backlog"},
        headers=auth_headers,
    )
    assert r.status_code == 200

    r = await client.put(
        f"/tasks/{tid}",
        json={
            "title": "conflict",
            "status": "backlog",
            "client_updated_at": "2000-01-01T00:00:00Z",
        },
        headers=auth_headers,
    )
    assert r.status_code == 409
    body = r.json()
    assert body["detail"]["error"] == "conflict"
    assert body["detail"]["server"]["title"] == "v1"


async def test_delete_task_soft(client: AsyncClient, auth_headers: dict):
    tid = str(uuid.uuid4())
    await client.put(
        f"/tasks/{tid}",
        json={"title": "gone", "status": "backlog"},
        headers=auth_headers,
    )
    r = await client.delete(f"/tasks/{tid}", headers=auth_headers)
    assert r.status_code == 200

    r = await client.get(f"/tasks/{tid}", headers=auth_headers)
    assert r.status_code == 404

    r = await client.get("/tasks", headers=auth_headers)
    assert r.json() == []


async def test_task_with_note_id(client: AsyncClient, auth_headers: dict):
    nid = str(uuid.uuid4())
    await client.put(f"/notes/{nid}", json={"title": "Notiz"}, headers=auth_headers)

    tid = str(uuid.uuid4())
    r = await client.put(
        f"/tasks/{tid}",
        json={"title": "Aus Notiz", "status": "todo", "note_id": nid},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["note_id"] == nid


async def test_tags_create_with_tags(client: AsyncClient, auth_headers: dict):
    """Tags werden beim Erstellen korrekt gespeichert und zurückgegeben."""
    tid = str(uuid.uuid4())
    r = await client.put(
        f"/tasks/{tid}",
        json={"title": "Tagged", "status": "todo", "tags": ["bug", "prio"]},
        headers=auth_headers,
    )
    assert r.status_code == 200
    out = r.json()
    assert out["tags"] == ["bug", "prio"]

    # Auch beim erneuten Lesen noch vorhanden
    r = await client.get(f"/tasks/{tid}", headers=auth_headers)
    assert r.json()["tags"] == ["bug", "prio"]


async def test_tags_update_adds_tags(client: AsyncClient, auth_headers: dict):
    """Nachträgliches Hinzufügen von Tags funktioniert."""
    tid = str(uuid.uuid4())
    r = await client.put(
        f"/tasks/{tid}",
        json={"title": "No tags", "status": "backlog"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["tags"] is None

    # Jetzt Tags hinzufügen
    r = await client.put(
        f"/tasks/{tid}",
        json={"title": "No tags", "status": "backlog", "tags": ["urgent"]},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["tags"] == ["urgent"]

    r = await client.get(f"/tasks/{tid}", headers=auth_headers)
    assert r.json()["tags"] == ["urgent"]


async def test_tags_clear(client: AsyncClient, auth_headers: dict):
    """Tags können durch Senden von null gelöscht werden."""
    tid = str(uuid.uuid4())
    await client.put(
        f"/tasks/{tid}",
        json={"title": "T", "status": "todo", "tags": ["a", "b"]},
        headers=auth_headers,
    )

    r = await client.put(
        f"/tasks/{tid}",
        json={"title": "T", "status": "todo", "tags": None},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["tags"] is None

    r = await client.get(f"/tasks/{tid}", headers=auth_headers)
    assert r.json()["tags"] is None


async def test_tags_via_batch_sync(client: AsyncClient, auth_headers: dict):
    """Tags über den Batch-Sync-Endpunkt."""
    tid = str(uuid.uuid4())
    ops = [
        {
            "type": "task.upsert",
            "id": tid,
            "data": {"title": "Sync task", "status": "doing", "tags": ["sync", "test"]},
        }
    ]
    r = await client.post("/sync/batch", json=ops, headers=auth_headers)
    assert r.status_code == 200
    res = r.json()["results"]
    assert res[0]["ok"] is True
    assert res[0]["data"]["tags"] == ["sync", "test"]

    # Verify via direct GET
    r = await client.get(f"/tasks/{tid}", headers=auth_headers)
    assert r.json()["tags"] == ["sync", "test"]


async def test_unauthorized(client: AsyncClient):
    tid = str(uuid.uuid4())
    r = await client.put(f"/tasks/{tid}", json={"title": "x", "status": "backlog"})
    assert r.status_code == 401
