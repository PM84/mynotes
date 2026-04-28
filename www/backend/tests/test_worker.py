"""Tests für den Background-Worker (embed + vision_ocr Jobs)."""
from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.ai import registry as registry_mod
from app.ai.base import ChatResponse
from app.db import SessionLocal
from app.models import Asset, Note, NoteAsset, NoteChunk, PendingJob, Workspace
from app.worker import _process_embed, _process_vision_ocr


class StubAdapter:
    name = "stub"
    vision_response: str = "OCR-Text"

    def __init__(self, *_a, **_kw) -> None:
        pass

    async def chat(self, *_a, **_kw):
        return ChatResponse(text="")

    async def embed(self, texts, *, model: str):
        return [[0.1 * i for i in range(8)] for _ in texts]

    async def vision(self, *_a, **_kw) -> str:
        return StubAdapter.vision_response

    async def healthcheck(self) -> bool:
        return True


@pytest.fixture(autouse=True)
def _stub(monkeypatch):
    monkeypatch.setitem(registry_mod.ADAPTERS, "stub", StubAdapter)
    StubAdapter.vision_response = "OCR-Text"


async def _provider(client: AsyncClient, headers: dict) -> None:
    await client.post(
        "/admin/ai/providers",
        json={
            "name": "stub",
            "adapter": "stub",
            "base_url": "https://stub",
            "api_key": "k",
            "embed_model": "stub-embed",
            "vision_model": "stub-vision",
            "is_active_embed": True,
            "is_active_vision": True,
        },
        headers=headers,
    )


async def test_process_embed_creates_chunks(client: AsyncClient, auth_headers: dict):
    await _provider(client, auth_headers)
    nid = str(uuid.uuid4())
    r = await client.put(
        f"/notes/{nid}",
        json={"title": "Doku", "body_md": "Inhalt der Notiz."},
        headers=auth_headers,
    )
    assert r.status_code == 200
    job = PendingJob(kind="embed", payload={"note_id": uuid.UUID(nid).hex})
    async with SessionLocal() as s:
        s.add(job)
        await s.commit()
        await s.refresh(job)

    await _process_embed(job)

    async with SessionLocal() as s:
        chunks = (
            await s.execute(
                select(NoteChunk).where(NoteChunk.note_id == uuid.UUID(nid).bytes)
            )
        ).scalars().all()
        assert len(chunks) >= 1


async def test_process_vision_ocr_appends_to_linked_notes(
    client: AsyncClient, auth_headers: dict
):
    """vision_ocr Job: hängt Text an alle verlinkten Notes + queued embed-Jobs."""
    import io

    from app.config import get_settings
    from pathlib import Path

    PNG_1X1 = (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
        + b"\x00\x00\x00\rIDATx\x9cc\xfc\xff\xff?\x03\x00\x05\xfe\x02\xfe\xa3\x35\x81\x84"
        + b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )

    await _provider(client, auth_headers)
    files = {"file": ("p.png", io.BytesIO(PNG_1X1), "image/png")}
    r = await client.post("/assets", headers=auth_headers, files=files)
    aid = r.json()["id"]

    # Note mit Asset verknüpfen
    nid = str(uuid.uuid4())
    r = await client.put(
        f"/notes/{nid}",
        json={"title": "Mit Bild", "body_md": "x", "asset_ids": [aid]},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text

    StubAdapter.vision_response = "Aus dem Bild erkannter Text"
    job = PendingJob(kind="vision_ocr", payload={"asset_id": uuid.UUID(aid).hex})
    async with SessionLocal() as s:
        s.add(job)
        await s.commit()
        await s.refresh(job)

    await _process_vision_ocr(job)

    async with SessionLocal() as s:
        n = await s.get(Note, uuid.UUID(nid).bytes)
        assert n.ocr_text and "Aus dem Bild" in n.ocr_text
        # neuer embed-Job sollte vorhanden sein
        embed_jobs = (
            await s.execute(select(PendingJob).where(PendingJob.kind == "embed"))
        ).scalars().all()
        assert len(embed_jobs) >= 1
