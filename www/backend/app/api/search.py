from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..ai.embedding import bytes_to_vec, search_similar
from ..db import get_session
from ..deps import get_current_user, get_default_workspace
from ..models import User
from ..schemas import SearchHit

router = APIRouter(prefix="/search", tags=["search"])


@router.get("", response_model=list[SearchHit])
async def hybrid_search(
    q: str = Query(min_length=1),
    limit: int = 20,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[SearchHit]:
    ws = await get_default_workspace(user, session)
    # FULLTEXT
    rows = (
        await session.execute(
            text(
                """
                SELECT id, title, LEFT(COALESCE(body_md,''),280) AS snippet,
                       MATCH(title, body_md, ocr_text) AGAINST (:q IN NATURAL LANGUAGE MODE) AS score
                FROM notes
                WHERE workspace_id = :ws AND deleted_at IS NULL
                  AND MATCH(title, body_md, ocr_text) AGAINST (:q IN NATURAL LANGUAGE MODE)
                ORDER BY score DESC LIMIT :lim
                """
            ),
            {"q": q, "ws": ws.id, "lim": limit},
        )
    ).all()
    ft_hits = [
        SearchHit(
            note_id=uuid.UUID(bytes=r.id), title=r.title, snippet=r.snippet, score=float(r.score),
        )
        for r in rows
    ]
    # Hinweis: Vector-Suche separat über /ai/rag oder POST /search/semantic.
    return ft_hits


@router.get("/semantic", response_model=list[SearchHit])
async def semantic_search(
    q: str,
    limit: int = 8,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[SearchHit]:
    hits = await search_similar(session, q, top_k=limit)
    out: list[SearchHit] = []
    seen: set[bytes] = set()
    for ch, score in hits:
        if ch.note_id in seen:
            continue
        seen.add(ch.note_id)
        from ..models import Note

        note = await session.get(Note, ch.note_id)
        if not note:
            continue
        out.append(
            SearchHit(
                note_id=uuid.UUID(bytes=note.id),
                title=note.title,
                snippet=ch.text[:280],
                score=float(score),
            )
        )
    return out
