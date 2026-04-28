import uuid

from httpx import AsyncClient


async def test_create_and_get_note(client: AsyncClient, auth_headers: dict):
    nid = str(uuid.uuid4())
    payload = {
        "title": "Erste Notiz",
        "body_md": "Hallo **Welt**",
        "tags": ["test", "demo"],
    }
    r = await client.put(f"/notes/{nid}", json=payload, headers=auth_headers)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["id"] == nid
    assert out["title"] == "Erste Notiz"
    assert out["tags"] == ["test", "demo"]

    # GET single
    r = await client.get(f"/notes/{nid}", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["body_md"] == "Hallo **Welt**"


async def test_list_notes_top_level(client: AsyncClient, auth_headers: dict):
    for i in range(3):
        nid = str(uuid.uuid4())
        await client.put(
            f"/notes/{nid}", json={"title": f"Note {i}"}, headers=auth_headers
        )
    r = await client.get("/notes", headers=auth_headers)
    assert r.status_code == 200
    notes = r.json()
    assert len(notes) == 3
    assert all(n["parent_id"] is None for n in notes)


async def test_hierarchy(client: AsyncClient, auth_headers: dict):
    parent = str(uuid.uuid4())
    child = str(uuid.uuid4())
    await client.put(f"/notes/{parent}", json={"title": "Parent"}, headers=auth_headers)
    await client.put(
        f"/notes/{child}",
        json={"title": "Child", "parent_id": parent},
        headers=auth_headers,
    )
    r = await client.get(f"/notes?parent_id={parent}", headers=auth_headers)
    assert r.status_code == 200
    children = r.json()
    assert len(children) == 1
    assert children[0]["id"] == child


async def test_delete_note_soft(client: AsyncClient, auth_headers: dict):
    nid = str(uuid.uuid4())
    await client.put(f"/notes/{nid}", json={"title": "x"}, headers=auth_headers)
    r = await client.delete(f"/notes/{nid}", headers=auth_headers)
    assert r.status_code == 200
    r = await client.get(f"/notes/{nid}", headers=auth_headers)
    assert r.status_code == 404
    r = await client.get("/notes", headers=auth_headers)
    assert r.json() == []


async def test_last_write_wins_no_conflict(client: AsyncClient, auth_headers: dict):
    nid = str(uuid.uuid4())
    r = await client.put(f"/notes/{nid}", json={"title": "v1"}, headers=auth_headers)
    assert r.status_code == 200
    # Update mit veraltetem client_updated_at -> kein Konflikt (LWW).
    r = await client.put(
        f"/notes/{nid}",
        json={"title": "v2", "client_updated_at": "2000-01-01T00:00:00Z"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["title"] == "v2"


async def test_unauthorized(client: AsyncClient):
    nid = str(uuid.uuid4())
    r = await client.put(f"/notes/{nid}", json={"title": "x"})
    assert r.status_code == 401
