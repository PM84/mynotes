"""Sync-Queue-Endpunkt für PWA (Bulk-Upload nach Reconnect)."""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..api.notes import upsert_note
from ..api.tasks import upsert_task
from ..db import get_session
from ..deps import get_current_user
from ..models import User
from ..schemas import NoteIn, TaskIn

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
      { "type": "task.upsert", "id": "<uuid>", "data": {...} }
      { "type": "task.delete", "id": "<uuid>" }
    Liefert pro Op { ok, id, data? } oder { error, id?, conflict?, server? }.
    """
    results: list[dict] = []
    for op in ops:
        try:
            t = op["type"]
            if t == "note.upsert":
                nid = uuid.UUID(op["id"])
                from fastapi import BackgroundTasks
                bg = BackgroundTasks()
                out = await upsert_note(nid, NoteIn(**op["data"]), bg, session, user)
                results.append({"ok": True, "id": str(nid), "data": out.model_dump(mode="json")})
            elif t == "note.delete":
                from ..api.notes import delete_note as del_n
                nid = uuid.UUID(op["id"])
                await del_n(nid, session, user)
                results.append({"ok": True, "id": str(nid)})
            elif t == "task.upsert":
                tid = uuid.UUID(op["id"])
                out = await upsert_task(tid, TaskIn(**op["data"]), session, user)
                results.append({"ok": True, "id": str(tid), "data": out.model_dump(mode="json")})
            elif t == "task.delete":
                from ..api.tasks import delete_task as del_t
                tid = uuid.UUID(op["id"])
                await del_t(tid, session, user)
                results.append({"ok": True, "id": str(tid)})
            else:
                results.append({"error": f"unknown op {t}"})
        except HTTPException as he:
            r: dict = {"error": str(he.detail), "id": op.get("id")}
            if he.status_code == 409 and isinstance(he.detail, dict):
                r["conflict"] = True
                r["server"] = he.detail.get("server")
            results.append(r)
        except Exception as e:
            results.append({"error": str(e)})
    return {"results": results}
