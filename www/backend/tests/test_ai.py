"""Tests für /ai/* Endpunkte mit gestubten KI-Adaptern."""
from __future__ import annotations

import io
import json
import uuid
from typing import Any

import pytest
from httpx import AsyncClient

from app.ai import registry as registry_mod
from app.ai.base import ChatResponse


class StubAdapter:
    """Sammelt Aufrufe; Antworten via Class-Vars konfigurierbar."""

    name = "stub"
    chat_response: str = ""
    embed_dim: int = 8
    vision_response: str = ""
    last_chat_messages: list = []  # noqa: RUF012

    def __init__(self, base_url: str, api_key: str, extras: dict | None) -> None:
        pass

    async def chat(self, messages, *, model: str, **_: Any) -> ChatResponse:
        StubAdapter.last_chat_messages = list(messages)
        return ChatResponse(text=StubAdapter.chat_response)

    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        # deterministisches Hash-basiertes Embedding
        out: list[list[float]] = []
        for t in texts:
            h = hash(t)
            v = [((h >> (i * 4)) & 0xF) / 15.0 for i in range(self.embed_dim)]
            out.append(v)
        return out

    async def vision(self, image_b64: str, mime: str, prompt: str, *, model: str) -> str:
        return StubAdapter.vision_response

    async def healthcheck(self) -> bool:
        return True


@pytest.fixture(autouse=True)
def _install_stub(monkeypatch):
    monkeypatch.setitem(registry_mod.ADAPTERS, "stub", StubAdapter)
    StubAdapter.chat_response = ""
    StubAdapter.vision_response = ""
    StubAdapter.last_chat_messages = []
    yield


async def _create_provider(client: AsyncClient, auth_headers: dict, **flags) -> dict:
    body = {
        "name": "stub",
        "adapter": "stub",
        "base_url": "https://stub",
        "api_key": "k",
        "chat_model": "stub-chat",
        "embed_model": "stub-embed",
        "vision_model": "stub-vision",
        "is_active_chat": True,
        "is_active_embed": True,
        "is_active_vision": True,
    }
    body.update(flags)
    r = await client.post("/admin/ai/providers", json=body, headers=auth_headers)
    assert r.status_code == 200, r.text
    return r.json()


async def _create_note(client: AsyncClient, auth_headers: dict, title: str, body: str) -> str:
    nid = str(uuid.uuid4())
    r = await client.put(
        f"/notes/{nid}",
        json={"title": title, "body_md": body},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    return nid


async def test_summarize(client: AsyncClient, auth_headers: dict):
    await _create_provider(client, auth_headers)
    nid = await _create_note(client, auth_headers, "Mein Titel", "Inhalt der Notiz.")
    StubAdapter.chat_response = "Kurzfassung der Notiz."
    r = await client.post(
        "/ai/summarize", json={"note_ids": [nid]}, headers=auth_headers
    )
    assert r.status_code == 200, r.text
    assert r.json()["summary"] == "Kurzfassung der Notiz."
    # Prompt muss Notiz-Inhalt enthalten
    assert "Inhalt der Notiz" in StubAdapter.last_chat_messages[0].content


async def test_summarize_404_for_missing(client: AsyncClient, auth_headers: dict):
    await _create_provider(client, auth_headers)
    r = await client.post(
        "/ai/summarize",
        json={"note_ids": [str(uuid.uuid4())]},
        headers=auth_headers,
    )
    assert r.status_code == 404


async def test_contradictions(client: AsyncClient, auth_headers: dict):
    await _create_provider(client, auth_headers)
    n1 = await _create_note(client, auth_headers, "A", "Der Himmel ist blau.")
    n2 = await _create_note(client, auth_headers, "B", "Der Himmel ist grün.")
    StubAdapter.chat_response = "Widerspruch: blau vs. grün."
    r = await client.post(
        "/ai/contradictions",
        json={"note_ids": [n1, n2]},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    assert "Widerspruch" in r.json()["report"]


async def test_auto_tag_parses_json(client: AsyncClient, auth_headers: dict):
    await _create_provider(client, auth_headers)
    nid = await _create_note(client, auth_headers, "Python", "Über asyncio")
    StubAdapter.chat_response = json.dumps(["Python", "Async", "Backend"])
    r = await client.post(
        f"/ai/auto_tag?note_id={nid}", headers=auth_headers
    )
    assert r.status_code == 200, r.text
    assert r.json()["tags"] == ["python", "async", "backend"]


async def test_auto_tag_invalid_json_returns_empty(client: AsyncClient, auth_headers: dict):
    await _create_provider(client, auth_headers)
    nid = await _create_note(client, auth_headers, "X", "y")
    StubAdapter.chat_response = "kein JSON"
    r = await client.post(
        f"/ai/auto_tag?note_id={nid}", headers=auth_headers
    )
    assert r.status_code == 200
    assert r.json()["tags"] == []


async def test_rag_no_chunks(client: AsyncClient, auth_headers: dict):
    await _create_provider(client, auth_headers)
    r = await client.post(
        "/ai/rag", json={"question": "Was?", "top_k": 3}, headers=auth_headers
    )
    assert r.status_code == 200
    body = r.json()
    assert body["sources"] == []
    assert "Keine relevanten" in body["answer"]


async def test_rag_with_chunks(client: AsyncClient, auth_headers: dict):
    """Embeddet Note manuell, dann fragt RAG."""
    from app.ai.embedding import reembed_note
    from app.db import SessionLocal
    from app.models import Note

    await _create_provider(client, auth_headers)
    nid = await _create_note(client, auth_headers, "Doku", "Async ist toll.")
    async with SessionLocal() as s:
        n = await s.get(Note, uuid.UUID(nid).bytes)
        cnt = await reembed_note(s, n)
        await s.commit()
    assert cnt > 0

    StubAdapter.chat_response = "Antwort aus RAG."
    r = await client.post(
        "/ai/rag", json={"question": "Async?", "top_k": 3}, headers=auth_headers
    )
    assert r.status_code == 200
    body = r.json()
    assert body["answer"] == "Antwort aus RAG."
    assert len(body["sources"]) >= 1
    assert body["sources"][0]["title"] == "Doku"


# 1×1 PNG für Vision-OCR
PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n"
    + b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    + b"\x00\x00\x00\rIDATx\x9cc\xfc\xff\xff?\x03\x00\x05\xfe\x02\xfe\xa3\x35\x81\x84\x00\x00\x00\x00IEND\xaeB`\x82"
)


async def test_vision_ocr(client: AsyncClient, auth_headers: dict):
    await _create_provider(client, auth_headers)
    files = {"file": ("p.png", io.BytesIO(PNG_1X1), "image/png")}
    r = await client.post("/assets", headers=auth_headers, files=files)
    aid = r.json()["id"]

    StubAdapter.vision_response = "Erkannter Text aus Bild."
    r = await client.post(
        f"/ai/vision_ocr?asset_id={aid}", headers=auth_headers
    )
    assert r.status_code == 200, r.text
    assert r.json()["text"] == "Erkannter Text aus Bild."


async def test_vision_ocr_rejects_non_image(client: AsyncClient, auth_headers: dict):
    """Asset-Upload erlaubt PDF — vision_ocr soll 400 liefern."""
    from app.db import SessionLocal
    from app.models import Asset

    await _create_provider(client, auth_headers)
    aid = uuid.uuid4().bytes
    async with SessionLocal() as s:
        s.add(
            Asset(
                id=aid,
                sha256="0" * 64,
                mime="application/pdf",
                size=10,
                filename="doc.pdf",
            )
        )
        await s.commit()
    r = await client.post(
        f"/ai/vision_ocr?asset_id={uuid.UUID(bytes=aid)}", headers=auth_headers
    )
    assert r.status_code == 400
