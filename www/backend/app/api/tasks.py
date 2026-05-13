from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..app_settings import get_setting, set_setting
from ..db import get_session
from ..deps import get_current_user, get_default_workspace
from ..models import Task, User
from ..schemas import TaskIn, TaskOut
from .ws import broadcast_user

router = APIRouter(prefix="/tasks", tags=["tasks"])

DEFAULT_COLUMNS: list[dict[str, Any]] = [
    {"id": "backlog", "title": "Backlog", "color": "bg-slate-100"},
    {"id": "todo", "title": "To Do", "color": "bg-blue-50"},
    {"id": "doing", "title": "In Arbeit", "color": "bg-amber-50"},
    {"id": "done", "title": "Erledigt", "color": "bg-emerald-50", "done": True},
]


def to_out(t: Task) -> TaskOut:
    return TaskOut(
        id=uuid.UUID(bytes=t.id),
        note_id=uuid.UUID(bytes=t.note_id) if t.note_id else None,
        title=t.title,
        description=t.description,
        status=t.status,
        priority=t.priority,
        position=t.position,
        due_date=t.due_date,
        tags=t.tags,
        closed_at=t.closed_at,
        created_at=t.created_at,
        updated_at=t.updated_at,
        deleted_at=t.deleted_at,
    )


@router.get("", response_model=list[TaskOut])
async def list_tasks(
    status_filter: str | None = Query(default=None, alias="status"),
    include_deleted: bool = Query(default=False),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[TaskOut]:
    ws = await get_default_workspace(user, session)
    q = select(Task).where(Task.workspace_id == ws.id)
    if not include_deleted:
        q = q.where(Task.deleted_at.is_(None))
    if status_filter:
        q = q.where(Task.status == status_filter)
    rows = (await session.execute(q.order_by(Task.position, Task.updated_at.desc()))).scalars().all()
    return [to_out(t) for t in rows]


@router.get("/{task_id}", response_model=TaskOut)
async def get_task(
    task_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> TaskOut:
    ws = await get_default_workspace(user, session)
    t = await session.get(Task, task_id.bytes)
    if not t or t.workspace_id != ws.id or t.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    return to_out(t)


@router.put("/{task_id}", response_model=TaskOut)
async def upsert_task(
    task_id: uuid.UUID,
    data: TaskIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> TaskOut:
    ws = await get_default_workspace(user, session)
    t = await session.get(Task, task_id.bytes)
    if t and t.workspace_id != ws.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN)
    if t and t.deleted_at:
        t.deleted_at = None
    if not t:
        t = Task(id=task_id.bytes, workspace_id=ws.id)
        session.add(t)
    else:
        if data.client_updated_at is not None and t.updated_at is not None:
            base = data.client_updated_at
            if base.tzinfo is None:
                base = base.replace(tzinfo=timezone.utc)
            current = t.updated_at
            if current.tzinfo is None:
                current = current.replace(tzinfo=timezone.utc)
            if (current - base).total_seconds() > 1:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    detail={
                        "error": "conflict",
                        "server": to_out(t).model_dump(mode="json"),
                    },
                )
    t.note_id = data.note_id.bytes if data.note_id else None
    t.title = data.title
    t.description = data.description
    t.status = data.status
    t.priority = data.priority
    t.position = data.position
    if data.due_date is not None:
        t.due_date = data.due_date
    if data.tags is not None:
        t.tags = data.tags
    if data.closed_at is not None:
        t.closed_at = data.closed_at
    await session.commit()
    await session.refresh(t)
    out = to_out(t)
    await broadcast_user(
        user.id,
        {"type": "task.upsert", "id": str(out.id), "updated_at": out.updated_at.isoformat()},
    )
    return out


@router.delete("/{task_id}")
async def delete_task(
    task_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    ws = await get_default_workspace(user, session)
    t = await session.get(Task, task_id.bytes)
    if not t or t.workspace_id != ws.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    t.deleted_at = datetime.now(timezone.utc)
    await session.commit()
    await broadcast_user(user.id, {"type": "task.delete", "id": str(task_id)})
    return {"ok": True}


# ---------- Kanban-Spalten ----------

@router.get("/columns")
async def get_columns(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[dict]:
    cols = await get_setting(session, "kanban_columns", DEFAULT_COLUMNS)
    if not isinstance(cols, list):
        return DEFAULT_COLUMNS
    return cols


@router.put("/columns")
async def set_columns(
    payload: list[dict[str, Any]],
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[dict]:
    # Validate structure
    for col in payload:
        if not col.get("id") or not col.get("title"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "each column needs id and title")
    await set_setting(session, "kanban_columns", payload)
    return payload
