import uuid

from httpx import AsyncClient


async def test_provider_crud(client: AsyncClient, auth_headers: dict):
    # Anlegen
    r = await client.post(
        "/admin/ai/providers",
        json={
            "name": "openai-prod",
            "adapter": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_key": "sk-test",
            "chat_model": "gpt-4o-mini",
            "embed_model": "text-embedding-3-small",
            "is_active_chat": True,
            "is_active_embed": True,
        },
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["has_key"] is True
    assert p["is_active_chat"] is True
    assert p["is_active_embed"] is True
    assert p["is_active_vision"] is False

    # Listen
    r = await client.get("/admin/ai/providers", headers=auth_headers)
    assert r.status_code == 200
    assert len(r.json()) == 1


async def test_exclusive_activation(client: AsyncClient, auth_headers: dict):
    for name in ("a", "b"):
        await client.post(
            "/admin/ai/providers",
            json={
                "name": name,
                "adapter": "openai",
                "base_url": "https://example.com",
                "api_key": "k",
                "chat_model": "m",
                "is_active_chat": True,
            },
            headers=auth_headers,
        )
    r = await client.get("/admin/ai/providers", headers=auth_headers)
    rows = {p["name"]: p for p in r.json()}
    # nur der zuletzt aktivierte ist aktiv
    assert rows["a"]["is_active_chat"] is False
    assert rows["b"]["is_active_chat"] is True


async def test_prompt_editor(client: AsyncClient, auth_headers: dict):
    r = await client.get("/admin/ai/prompts", headers=auth_headers)
    assert r.status_code == 200
    names = r.json()
    assert "summarize" in names

    r = await client.get("/admin/ai/prompts/summarize", headers=auth_headers)
    assert r.status_code == 200
    original = r.json()["content"]

    # Wiederherstellbar — speichern + zurückspielen
    r = await client.put(
        "/admin/ai/prompts/summarize",
        json={"content": original + "\n<!-- test -->"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    r = await client.get("/admin/ai/prompts/summarize", headers=auth_headers)
    assert r.json()["content"].endswith("<!-- test -->")
    # zurücksetzen
    await client.put(
        "/admin/ai/prompts/summarize",
        json={"content": original},
        headers=auth_headers,
    )


async def test_admin_requires_admin(client: AsyncClient):
    # Ohne Token
    r = await client.get("/admin/ai/providers")
    assert r.status_code == 401


async def test_sync_batch(client: AsyncClient, auth_headers: dict):
    nid = str(uuid.uuid4())
    ops = [
        {"type": "note.upsert", "id": nid, "data": {"title": "via sync"}},
    ]
    r = await client.post("/sync/batch", json=ops, headers=auth_headers)
    assert r.status_code == 200, r.text
    res = r.json()["results"]
    assert res[0]["ok"] is True

    r = await client.get(f"/notes/{nid}", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["title"] == "via sync"

    # Delete via sync
    r = await client.post(
        "/sync/batch",
        json=[{"type": "note.delete", "id": nid}],
        headers=auth_headers,
    )
    assert r.json()["results"][0]["ok"] is True
