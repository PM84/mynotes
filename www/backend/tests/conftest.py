"""Pytest-Setup: Tests laufen gegen MariaDB in der gleichen Compose-Instanz, aber gegen
ein separates Schema `mynotes_test`. `bindev/test.sh` legt das Schema vorher an und
führt alembic upgrade head dagegen aus.
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

# Settings VOR dem App-Import setzen, damit get_settings() den Test-DB-URL nutzt.
os.environ.setdefault("DB_URL", "mysql+asyncmy://app:app@db:3306/mynotes_test")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("BOOTSTRAP_ADMIN_EMAIL", "admin@test.com")
os.environ.setdefault("BOOTSTRAP_ADMIN_PASSWORD", "test123")
os.environ.setdefault("ASSET_DIR", "/tmp/mynotes-test-assets")

from app.db import SessionLocal, engine  # noqa: E402
from app.main import _bootstrap_admin, app  # noqa: E402

# Rate-Limiter für Tests deaktivieren.
app.state.limiter.enabled = False
from app.api import auth as _auth_mod  # noqa: E402

_auth_mod._limiter.enabled = False


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


TABLES_TO_TRUNCATE = [
    "pending_jobs",
    "ai_cache",
    "note_chunks",
    "note_assets",
    "assets",
    "notes",
    "ai_providers",
    "workspaces",
    "users",
]


@pytest_asyncio.fixture(autouse=True)
async def _clean_db():
    """Vor jedem Test: alle Tabellen leeren, Bootstrap-Admin neu anlegen."""
    async with engine.begin() as conn:
        await conn.execute(text("SET FOREIGN_KEY_CHECKS=0"))
        for t in TABLES_TO_TRUNCATE:
            await conn.execute(text(f"TRUNCATE TABLE {t}"))
        await conn.execute(text("SET FOREIGN_KEY_CHECKS=1"))
    await _bootstrap_admin()
    yield


@pytest_asyncio.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture
async def admin_token(client: AsyncClient) -> str:
    r = await client.post(
        "/auth/login", json={"email": "admin@test.com", "password": "test123"}
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest_asyncio.fixture
async def auth_headers(admin_token: str) -> dict:
    return {"Authorization": f"Bearer {admin_token}"}


def new_uuid() -> str:
    return str(uuid.uuid4())
