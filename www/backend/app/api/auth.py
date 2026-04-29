from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..app_settings import get_session_lifetime_minutes
from ..db import get_session
from ..deps import get_current_user
from ..models import User, Workspace
from ..schemas import LoginIn, TokenOut, UserOut
from ..security import create_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])
_limiter = Limiter(key_func=get_remote_address)


@router.post("/login", response_model=TokenOut)
@_limiter.limit("10/minute")
async def login(request: Request, data: LoginIn, session: AsyncSession = Depends(get_session)) -> TokenOut:
    user = (await session.execute(select(User).where(User.email == data.email))).scalar_one_or_none()
    if not user or not verify_password(user.password_hash, data.password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    sub = str(uuid.UUID(bytes=user.id))
    minutes = await get_session_lifetime_minutes(session)
    return TokenOut(
        access_token=create_token(sub, kind="access", extra={"role": user.role}, minutes=minutes),
        refresh_token=create_token(sub, kind="refresh", minutes=minutes),
    )


@router.post("/refresh", response_model=TokenOut)
async def refresh(token: str, session: AsyncSession = Depends(get_session)) -> TokenOut:
    from ..security import decode_token

    try:
        claims = decode_token(token)
        if claims.get("kind") != "refresh":
            raise ValueError("not a refresh token")
        sub = claims["sub"]
        uid = uuid.UUID(sub).bytes
    except Exception as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(e)) from e
    user = (await session.execute(select(User).where(User.id == uid))).scalar_one_or_none()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user not found")
    minutes = await get_session_lifetime_minutes(session)
    return TokenOut(
        access_token=create_token(sub, kind="access", extra={"role": user.role}, minutes=minutes),
        refresh_token=create_token(sub, kind="refresh", minutes=minutes),
    )


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)) -> User:
    return user
