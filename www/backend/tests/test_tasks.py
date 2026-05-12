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


async def test_unauthorized(client: AsyncClient):
    tid = str(uuid.uuid4())
    r = await client.put(f"/tasks/{tid}", json={"title": "x", "status": "backlog"})
    assert r.status_code == 401
