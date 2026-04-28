"""RAG-Pipeline: Retrieve + Generate."""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Note
from .base import Message
from .embedding import search_similar
from .prompt_loader import load
from .registry import get_active


async def answer(session: AsyncSession, question: str, top_k: int = 5) -> dict:
    hits = await search_similar(session, question, top_k=top_k)
    if not hits:
        return {"answer": "Keine relevanten Notizen gefunden.", "sources": []}
    sources_text_blocks: list[str] = []
    sources_meta: list[dict] = []
    for ch, score in hits:
        nid = uuid.UUID(bytes=ch.note_id)
        note = await session.get(Note, ch.note_id)
        title = note.title if note else ""
        sources_text_blocks.append(f"[id:{nid}] (note: {title})\n{ch.text}")
        sources_meta.append(
            {"note_id": str(nid), "title": title, "snippet": ch.text[:280], "score": round(score, 4)}
        )
    prompt = load("rag_answer").format(sources="\n\n".join(sources_text_blocks), question=question)
    row, client = await get_active(session, "chat")
    if not row.chat_model:
        raise RuntimeError("active chat provider has no chat_model configured")
    resp = await client.chat([Message(role="user", content=prompt)], model=row.chat_model)
    return {"answer": resp.text, "sources": sources_meta}
