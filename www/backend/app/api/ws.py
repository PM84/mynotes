"""WebSocket-Endpunkt für Realtime-Sync.

Pro authentifiziertem User wird ein Set offener Connections gepflegt.
Andere Endpunkte (Notes-Upsert/Delete) rufen `broadcast_user(user_id, event)`
auf, sobald ihr DB-Commit erfolgt ist. Der WS-Client triggert dann einen Pull.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select

from ..db import SessionLocal
from ..models import User
from ..security import decode_token

router = APIRouter(prefix="/ws", tags=["ws"])
log = logging.getLogger("ws")


class ConnectionManager:
    def __init__(self) -> None:
        self._conns: dict[bytes, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def add(self, user_id: bytes, ws: WebSocket) -> None:
        async with self._lock:
            self._conns.setdefault(user_id, set()).add(ws)

    async def remove(self, user_id: bytes, ws: WebSocket) -> None:
        async with self._lock:
            conns = self._conns.get(user_id)
            if not conns:
                return
            conns.discard(ws)
            if not conns:
                self._conns.pop(user_id, None)

    async def broadcast(
        self,
        user_id: bytes,
        event: dict[str, Any],
        *,
        skip: WebSocket | None = None,
    ) -> None:
        async with self._lock:
            targets = list(self._conns.get(user_id, ()))
        payload = json.dumps(event)
        for ws in targets:
            if ws is skip:
                continue
            try:
                await ws.send_text(payload)
            except Exception:  # noqa: BLE001
                # Verbindung ist tot – wird beim nächsten recv() bereinigt.
                pass


manager = ConnectionManager()


async def broadcast_user(user_id: bytes, event: dict[str, Any]) -> None:
    """Hilfsfunktion für andere Endpunkte."""
    await manager.broadcast(user_id, event)


@router.websocket("/notes")
async def notes_ws(websocket: WebSocket, token: str = Query(...)) -> None:
    """Realtime-Channel für Note-Mutations-Events.

    Authentifizierung über Query-Param `?token=<access_jwt>`, weil Browser
    keine Custom-Header für WebSocket-Upgrades zulassen.
    """
    try:
        claims = decode_token(token)
        if claims.get("kind") != "access":
            raise ValueError("wrong token kind")
        uid = uuid.UUID(claims["sub"]).bytes
    except Exception as e:  # noqa: BLE001
        log.info("ws auth failed: %s", e)
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    async with SessionLocal() as s:
        user = (await s.execute(select(User).where(User.id == uid))).scalar_one_or_none()
    if not user:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    await manager.add(uid, websocket)
    try:
        await websocket.send_text(json.dumps({"type": "hello"}))
        while True:
            # Wir nutzen den Channel nur server→client. Empfangene Frames
            # dienen lediglich als Keepalive; ignoriert.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.warning("ws error: %s", e)
    finally:
        await manager.remove(uid, websocket)
