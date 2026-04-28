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
from .ws import broadcast_user

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
        deleted_at=n.deleted_at,
    )


@router.get("", response_model=list[NoteOut])
async def list_notes(
    parent_id: uuid.UUID | None = Query(default=None),
    all: bool = Query(default=False, description="Alle Notes (rekursiv) ausliefern"),
    include_deleted: bool = Query(default=False),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[NoteOut]:
    ws = await get_default_workspace(user, session)
    q = select(Note).where(Note.workspace_id == ws.id)
    if not include_deleted:
        q = q.where(Note.deleted_at.is_(None))
    if not all:
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
        # Optimistic-Locking: Wenn der Client eine Basis-Version mitschickt,
        # die älter ist als die aktuelle Server-Version, ist das ein Konflikt.
        # Toleranz 1 s gegen Clock-Skew/MariaDB-Timestamp-Granularität.
        if data.client_updated_at is not None and n.updated_at is not None:
            base = data.client_updated_at
            if base.tzinfo is None:
                base = base.replace(tzinfo=timezone.utc)
            current = n.updated_at
            if current.tzinfo is None:
                current = current.replace(tzinfo=timezone.utc)
            if (current - base).total_seconds() > 1:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    detail={
                        "error": "conflict",
                        "server": to_out(n).model_dump(mode="json"),
                    },
                )
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
    out = to_out(n)
    await broadcast_user(
        user.id,
        {
            "type": "note.upsert",
            "id": str(out.id),
            "updated_at": out.updated_at.isoformat(),
        },
    )
    return out


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
    await broadcast_user(
        user.id,
        {"type": "note.delete", "id": str(note_id)},
    )
    return {"ok": True}
