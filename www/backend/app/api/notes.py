from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import get_current_user, get_default_workspace
from ..models import Note, NoteAsset, PendingJob, User
from ..schemas import NoteIn, NoteOut
router = APIRouter(prefix="/notes", tags=["notes"])


def to_out(n: Note) -> NoteOut:
    return NoteOut(
        id=uuid.UUID(bytes=n.id),
        parent_id=uuid.UUID(bytes=n.parent_id) if n.parent_id else None,
        title=n.title,
        body_md=n.body_md,
        excalidraw=n.excalidraw,
        ocr_text=n.ocr_text,
        tags=n.tags,
        created_at=n.created_at,
        updated_at=n.updated_at,
    )


@router.get("", response_model=list[NoteOut])
async def list_notes(
    parent_id: uuid.UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[NoteOut]:
    ws = await get_default_workspace(user, session)
    q = select(Note).where(Note.workspace_id == ws.id, Note.deleted_at.is_(None))
    if parent_id is None:
        q = q.where(Note.parent_id.is_(None))
    else:
        q = q.where(Note.parent_id == parent_id.bytes)
    rows = (await session.execute(q.order_by(Note.updated_at.desc()))).scalars().all()
    return [to_out(n) for n in rows]


@router.get("/{note_id}", response_model=NoteOut)
async def get_note(
    note_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NoteOut:
    ws = await get_default_workspace(user, session)
    n = await session.get(Note, note_id.bytes)
    if not n or n.workspace_id != ws.id or n.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    return to_out(n)


async def _enqueue_embed(session: AsyncSession, note_id: bytes) -> None:
    session.add(
        PendingJob(kind="embed", payload={"note_id": uuid.UUID(bytes=note_id).hex})
    )


@router.put("/{note_id}", response_model=NoteOut)
async def upsert_note(
    note_id: uuid.UUID,
    data: NoteIn,
    bg: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NoteOut:
    ws = await get_default_workspace(user, session)
    n = await session.get(Note, note_id.bytes)
    if n and (n.workspace_id != ws.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN)
    if n and n.deleted_at:
        n.deleted_at = None  # Restore beim Re-Upsert
    if not n:
        n = Note(
            id=note_id.bytes,
            workspace_id=ws.id,
            parent_id=data.parent_id.bytes if data.parent_id else None,
        )
        session.add(n)
    else:
        # Last-Write-Wins: kein Optimistic-Locking. Für Single-User/Multi-Device-PWA
        # mit Offline-Queue ist Wall-Clock-Vergleich unzuverlässig (Clock-Skew,
        # Server-`onupdate=now()` macht queued Edits dauerhaft "stale").
        n.parent_id = data.parent_id.bytes if data.parent_id else None
    n.title = data.title
    n.body_md = data.body_md
    n.excalidraw = data.excalidraw
    n.tags = data.tags
    if data.asset_ids is not None:
        # NoteAsset-Verknüpfungen ersetzen.
        # Unbekannte asset_ids überspringen (Offline-Queue kann veraltete IDs
        # enthalten, wenn `asset.upload` die ID umgeschrieben hat, der
        # vorab eingereihte note.upsert aber noch die alte lokale UUID trägt).
        from sqlalchemy import delete
        from ..models import Asset
        await session.execute(delete(NoteAsset).where(NoteAsset.note_id == n.id))
        if data.asset_ids:
            wanted = [aid.bytes for aid in data.asset_ids]
            existing_rows = (
                await session.execute(select(Asset.id).where(Asset.id.in_(wanted)))
            ).scalars().all()
            existing = set(existing_rows)
            for aid in wanted:
                if aid in existing:
                    session.add(NoteAsset(note_id=n.id, asset_id=aid))
    await session.flush()
    await _enqueue_embed(session, n.id)
    await session.commit()
    await session.refresh(n)
    return to_out(n)


@router.delete("/{note_id}")
async def delete_note(
    note_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    ws = await get_default_workspace(user, session)
    n = await session.get(Note, note_id.bytes)
    if not n or n.workspace_id != ws.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    n.deleted_at = datetime.now(timezone.utc)
    await session.commit()
    return {"ok": True}
