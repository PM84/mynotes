import uuid

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session
from .models import User, Workspace
from .security import decode_token


async def get_current_user(
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> User:
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    token = auth.split(" ", 1)[1]
    try:
        claims = decode_token(token)
        if claims.get("kind") != "access":
            raise ValueError("wrong token kind")
        uid = uuid.UUID(claims["sub"]).bytes
    except Exception as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"invalid token: {e}") from e
    user = (await session.execute(select(User).where(User.id == uid))).scalar_one_or_none()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user not found")
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin required")
    return user


async def get_default_workspace(
    user: User,
    session: AsyncSession,
) -> Workspace:
    ws = (
        await session.execute(select(Workspace).where(Workspace.owner_id == user.id).limit(1))
    ).scalar_one_or_none()
    if not ws:
        ws = Workspace(owner_id=user.id, name="Default")
        session.add(ws)
        await session.flush()
    return ws
