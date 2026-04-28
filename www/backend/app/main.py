from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy import select, text
from starlette.middleware.base import BaseHTTPMiddleware

from .api import admin, ai as ai_routes, assets, auth, notes, search, sync
from .config import get_settings
from .db import SessionLocal
from .models import User, Workspace
from .security import hash_password
from .worker import loop as worker_loop

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

settings = get_settings()
limiter = Limiter(key_func=get_remote_address, default_limits=["240/minute"])


async def _bootstrap_admin() -> None:
    from sqlalchemy.exc import IntegrityError

    async with SessionLocal() as s:
        existing = (
            await s.execute(select(User).where(User.email == settings.bootstrap_admin_email))
        ).scalar_one_or_none()
        if existing:
            return
        u = User(
            email=settings.bootstrap_admin_email,
            password_hash=hash_password(settings.bootstrap_admin_password),
            role="admin",
        )
        s.add(u)
        try:
            await s.flush()
            s.add(Workspace(owner_id=u.id, name="Default"))
            await s.commit()
            log.info("bootstrapped admin user %s", settings.bootstrap_admin_email)
        except IntegrityError:
            # Race condition: another worker already created the admin user.
            await s.rollback()
            log.info("bootstrap admin already exists (race), skipping")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await _bootstrap_admin()
    task = asyncio.create_task(worker_loop())
    app.state.worker_task = task
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob:; "
            "style-src 'self' 'unsafe-inline'; "
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; "
            "connect-src 'self' https: wss: ws:; "
            "font-src 'self' data:; "
            "frame-ancestors 'none'; base-uri 'self'",
        )
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("X-Frame-Options", "DENY")
        return response


app.add_middleware(SecurityHeadersMiddleware)


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


@app.get("/healthz/deep")
async def healthz_deep() -> dict:
    db_ok = False
    try:
        async with SessionLocal() as s:
            await s.execute(text("SELECT 1"))
        db_ok = True
    except Exception as e:  # noqa: BLE001
        log.warning("healthz/deep db error: %s", e)
    task = getattr(app.state, "worker_task", None)
    worker_ok = bool(task and not task.done())
    ok = db_ok and worker_ok
    return {"ok": ok, "db": db_ok, "worker": worker_ok}


app.include_router(auth.router)
app.include_router(notes.router)
app.include_router(assets.router)
app.include_router(search.router)
app.include_router(ai_routes.router)
app.include_router(admin.router)
app.include_router(sync.router)
