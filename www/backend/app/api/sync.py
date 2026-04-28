"""Sync-Queue-Endpunkt für PWA (Bulk-Upload nach Reconnect)."""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..api.notes import upsert_note
from ..db import get_session
from ..deps import get_current_user
from ..models import User
from ..schemas import NoteIn

router = APIRouter(prefix="/sync", tags=["sync"])


@router.post("/batch")
async def batch(
    ops: list[dict[str, Any]],
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """
    Wendet eine Sequenz von Mutationen an. Jede Op:
      { "type": "note.upsert", "id": "<uuid>", "data": {...} }
      { "type": "note.delete", "id": "<uuid>" }
    Liefert pro Op { ok | error }.
    """
    results: list[dict] = []
    for op in ops:
        try:
            t = op["type"]
            if t == "note.upsert":
                nid = uuid.UUID(op["id"])
                from fastapi import BackgroundTasks
                bg = BackgroundTasks()
                await upsert_note(nid, NoteIn(**op["data"]), bg, session, user)
                results.append({"ok": True, "id": str(nid)})
            elif t == "note.delete":
                from ..api.notes import delete_note as del_n
                nid = uuid.UUID(op["id"])
                await del_n(nid, session, user)
                results.append({"ok": True, "id": str(nid)})
            else:
                results.append({"error": f"unknown op {t}"})
        except Exception as e:
            results.append({"error": str(e)})
    return {"results": results}
