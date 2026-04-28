"""Embedding-Pipeline: Chunking + Embed + Persist."""
from __future__ import annotations

import struct

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Note, NoteChunk
from .registry import build_adapter, get_active

CHUNK_TOKENS = 500  # grob: ~ 2000 Zeichen
OVERLAP = 50


def _split_text(text: str, chunk_chars: int = 2000, overlap_chars: int = 200) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    chunks: list[str] = []
    i = 0
    while i < len(text):
        end = min(len(text), i + chunk_chars)
        chunks.append(text[i:end])
        if end == len(text):
            break
        i = end - overlap_chars
    return chunks


def vec_to_bytes(vec: list[float]) -> bytes:
    return struct.pack(f"<{len(vec)}f", *vec)


def bytes_to_vec(blob: bytes) -> list[float]:
    n = len(blob) // 4
    return list(struct.unpack(f"<{n}f", blob))


def cosine(a: list[float], b: list[float]) -> float:
    import math
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def note_text(note: Note) -> str:
    parts: list[str] = []
    if note.title:
        parts.append(f"# {note.title}")
    if note.body_md:
        parts.append(note.body_md)
    if note.ocr_text:
        parts.append(note.ocr_text)
    return "\n\n".join(parts)


async def reembed_note(session: AsyncSession, note: Note) -> int:
    text = note_text(note)
    if not text.strip():
        await session.execute(delete(NoteChunk).where(NoteChunk.note_id == note.id))
        return 0
    row, client = await get_active(session, "embed")
    if not row.embed_model:
        raise RuntimeError("active embed provider has no embed_model configured")
    chunks = _split_text(text)
    embeddings = await client.embed(chunks, model=row.embed_model)
    await session.execute(delete(NoteChunk).where(NoteChunk.note_id == note.id))
    for i, (c, emb) in enumerate(zip(chunks, embeddings, strict=True)):
        session.add(
            NoteChunk(
                note_id=note.id,
                idx=i,
                text=c,
                embedding=vec_to_bytes(emb),
                embed_model=row.embed_model,
            )
        )
    await session.flush()
    return len(chunks)


async def search_similar(session: AsyncSession, query: str, top_k: int = 8) -> list[tuple[NoteChunk, float]]:
    row, client = await get_active(session, "embed")
    if not row.embed_model:
        return []
    q_emb = (await client.embed([query], model=row.embed_model))[0]
    # Pragmatisch: alle Chunks laden + Cosine in Python.
    # MVP-Skala: bei <100k Chunks ausreichend. Für Produktion: MariaDB-VECTOR-Index-Query.
    chunks = (await session.execute(select(NoteChunk))).scalars().all()
    scored: list[tuple[NoteChunk, float]] = []
    for ch in chunks:
        sim = cosine(q_emb, bytes_to_vec(ch.embedding))
        scored.append((ch, sim))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:top_k]
