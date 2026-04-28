"""Tests für FULLTEXT-Suche und semantische Suche."""
from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

from app.ai import registry as registry_mod
from app.ai.base import ChatResponse


class StubAdapter:
    name = "stub"

    def __init__(self, *_args, **_kw) -> None:
        pass

    async def chat(self, messages, *, model: str, **_):
        return ChatResponse(text="ok")

    async def embed(self, texts, *, model: str):
        return [[float((hash(t) >> (i * 4)) & 0xF) / 15.0 for i in range(8)] for t in texts]

    async def vision(self, *_a, **_kw):
        return ""

    async def healthcheck(self) -> bool:
        return True


@pytest.fixture(autouse=True)
def _stub(monkeypatch):
    monkeypatch.setitem(registry_mod.ADAPTERS, "stub", StubAdapter)


async def _provider(client: AsyncClient, headers: dict) -> None:
    await client.post(
        "/admin/ai/providers",
        json={
            "name": "stub",
            "adapter": "stub",
            "base_url": "https://stub",
            "api_key": "k",
            "embed_model": "stub-embed",
            "is_active_embed": True,
        },
        headers=headers,
    )


async def _note(client: AsyncClient, headers: dict, title: str, body: str) -> str:
    nid = str(uuid.uuid4())
    r = await client.put(
        f"/notes/{nid}", json={"title": title, "body_md": body}, headers=headers
    )
    assert r.status_code == 200, r.text
    return nid


async def test_fulltext_finds_match(client: AsyncClient, auth_headers: dict):
    await _note(client, auth_headers, "Python Tutorial", "asyncio coroutines explained")
    await _note(client, auth_headers, "Kochrezept", "Tomatensoße kochen")

    r = await client.get("/search?q=asyncio", headers=auth_headers)
    assert r.status_code == 200, r.text
    hits = r.json()
    titles = [h["title"] for h in hits]
    assert "Python Tutorial" in titles
    assert "Kochrezept" not in titles


async def test_fulltext_empty_for_no_match(client: AsyncClient, auth_headers: dict):
    await _note(client, auth_headers, "Foo", "Bar")
    r = await client.get("/search?q=xyzzy_nichtgefunden", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == []


async def test_semantic_search_returns_hits(client: AsyncClient, auth_headers: dict):
    """Embeddet Note + sucht semantisch."""
    from app.ai.embedding import reembed_note
    from app.db import SessionLocal
    from app.models import Note

    await _provider(client, auth_headers)
    nid = await _note(client, auth_headers, "Doku", "asyncio rocks")
    async with SessionLocal() as s:
        n = await s.get(Note, uuid.UUID(nid).bytes)
        await reembed_note(s, n)
        await s.commit()

    r = await client.get("/search/semantic?q=asyncio", headers=auth_headers)
    assert r.status_code == 200, r.text
    hits = r.json()
    assert len(hits) >= 1
    assert hits[0]["title"] == "Doku"
