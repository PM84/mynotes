from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from .config import get_settings

settings = get_settings()
_ph = PasswordHasher()


def hash_password(pw: str) -> str:
    return _ph.hash(pw)


def verify_password(hashed: str, pw: str) -> bool:
    try:
        return _ph.verify(hashed, pw)
    except VerifyMismatchError:
        return False


def create_token(
    sub: str,
    *,
    kind: str,
    extra: dict[str, Any] | None = None,
    minutes: int | None = None,
) -> str:
    now = datetime.now(UTC)
    if minutes is not None:
        exp = now + timedelta(minutes=minutes)
    elif kind == "access":
        exp = now + timedelta(minutes=settings.jwt_access_minutes)
    else:
        exp = now + timedelta(days=settings.jwt_refresh_days)
    payload: dict[str, Any] = {"sub": sub, "kind": kind, "iat": int(now.timestamp()), "exp": int(exp.timestamp())}
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_alg)


def decode_token(token: str) -> dict[str, Any]:
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_alg])
