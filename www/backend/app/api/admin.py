from __future__ import annotations

import base64
import io
import json
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from ..ai.registry import build_adapter
from ..app_settings import (
    DEFAULT_SESSION_LIFETIME_MINUTES,
    MAX_SESSION_LIFETIME_MINUTES,
    MIN_SESSION_LIFETIME_MINUTES,
    get_setting,
    set_setting,
)
from ..config import get_settings
from ..db import get_session
from ..deps import require_admin
from ..models import (
    AICache,
    AIProvider,
    AppSetting,
    Asset,
    Note,
    NoteAsset,
    NoteChunk,
    PendingJob,
    User,
    Workspace,
)
from ..schemas import ProviderIn, ProviderOut

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


def to_out(r: AIProvider) -> ProviderOut:
    return ProviderOut(
        id=r.id, name=r.name, adapter=r.adapter, base_url=r.base_url,
        has_key=bool(r.api_key_enc),
        chat_model=r.chat_model, embed_model=r.embed_model, vision_model=r.vision_model,
        is_active_chat=r.is_active_chat, is_active_embed=r.is_active_embed,
        is_active_vision=r.is_active_vision,
    )


@router.get("/ai/providers", response_model=list[ProviderOut])
async def list_providers(session: AsyncSession = Depends(get_session)) -> list[ProviderOut]:
    rows = (await session.execute(select(AIProvider).order_by(AIProvider.name))).scalars().all()
    return [to_out(r) for r in rows]


@router.post("/ai/providers", response_model=ProviderOut)
async def upsert_provider(
    data: ProviderIn, session: AsyncSession = Depends(get_session)
) -> ProviderOut:
    row = (
        await session.execute(select(AIProvider).where(AIProvider.name == data.name))
    ).scalar_one_or_none()
    if not row:
        row = AIProvider(name=data.name, adapter=data.adapter, base_url=data.base_url, api_key_enc=b"")
        session.add(row)
    row.adapter = data.adapter
    row.base_url = data.base_url
    if data.api_key:
        row.api_key_enc = data.api_key.encode("utf-8")
    row.chat_model = data.chat_model
    row.embed_model = data.embed_model
    row.vision_model = data.vision_model
    row.extras = data.extras

    # Aktivierung exklusiv pro Capability
    if data.is_active_chat:
        await session.execute(
            AIProvider.__table__.update().values(is_active_chat=False)
        )
    if data.is_active_embed:
        await session.execute(
            AIProvider.__table__.update().values(is_active_embed=False)
        )
    if data.is_active_vision:
        await session.execute(
            AIProvider.__table__.update().values(is_active_vision=False)
        )
    row.is_active_chat = data.is_active_chat
    row.is_active_embed = data.is_active_embed
    row.is_active_vision = data.is_active_vision
    await session.commit()
    await session.refresh(row)
    return to_out(row)


@router.delete("/ai/providers/{pid}")
async def delete_provider(pid: int, session: AsyncSession = Depends(get_session)) -> dict:
    row = await session.get(AIProvider, pid)
    if not row:
        raise HTTPException(404)
    await session.delete(row)
    await session.commit()
    return {"ok": True}


@router.post("/ai/providers/{pid}/test")
async def test_provider(pid: int, session: AsyncSession = Depends(get_session)) -> dict:
    row = await session.get(AIProvider, pid)
    if not row:
        raise HTTPException(404)
    client = build_adapter(row)
    healthy = await client.healthcheck()
    return {"healthy": healthy}


@router.get("/ai/providers/{pid}/models")
async def provider_models(
    pid: int,
    capability: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Modelle des Providers, optional gefiltert auf 'chat'|'embed'|'vision'."""
    row = await session.get(AIProvider, pid)
    if not row:
        raise HTTPException(404)
    if capability and capability not in {"chat", "embed", "vision"}:
        raise HTTPException(400, "invalid capability")
    client = build_adapter(row)
    try:
        models = await client.list_models()
    except NotImplementedError:
        raise HTTPException(501, "provider does not expose model listing")
    except Exception as e:
        raise HTTPException(502, f"upstream error: {e}")
    if capability:
        models = [m for m in models if capability in m.capabilities]
    return {"models": [{"id": m.id, "capabilities": list(m.capabilities)} for m in models]}


@router.post("/ai/providers/preview/models")
async def preview_provider_models(
    payload: dict,
    capability: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Modelle für noch nicht gespeicherten Provider abrufen.

    Erwartet `{adapter, base_url, api_key?, extras?}`. Wird beim Anlegen eines
    neuen Providers im Admin-UI verwendet, bevor `pid` existiert.
    """
    from ..ai.registry import ADAPTERS

    adapter = payload.get("adapter")
    cls = ADAPTERS.get(adapter or "")
    if not cls:
        raise HTTPException(400, "unknown adapter")
    if capability and capability not in {"chat", "embed", "vision"}:
        raise HTTPException(400, "invalid capability")
    client = cls(payload.get("base_url") or "", payload.get("api_key") or "", payload.get("extras"))
    try:
        models = await client.list_models()
    except NotImplementedError:
        raise HTTPException(501, "provider does not expose model listing")
    except Exception as e:
        raise HTTPException(502, f"upstream error: {e}")
    if capability:
        models = [m for m in models if capability in m.capabilities]
    return {"models": [{"id": m.id, "capabilities": list(m.capabilities)} for m in models]}


# --- Prompt-Editor ---

PROMPTS_DIR = Path(__file__).resolve().parent.parent / "ai" / "prompts"


# --- App-Einstellungen --------------------------------------------------------

@router.get("/settings")
async def get_app_settings(session: AsyncSession = Depends(get_session)) -> dict:
    minutes = await get_setting(
        session, "session_lifetime_minutes", DEFAULT_SESSION_LIFETIME_MINUTES
    )
    try:
        m = int(minutes)
    except (TypeError, ValueError):
        m = DEFAULT_SESSION_LIFETIME_MINUTES
    return {"session_lifetime_minutes": m}


@router.put("/settings")
async def update_app_settings(
    payload: dict, session: AsyncSession = Depends(get_session)
) -> dict:
    raw = payload.get("session_lifetime_minutes")
    try:
        m = int(raw)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, "invalid session_lifetime_minutes") from e
    if m < MIN_SESSION_LIFETIME_MINUTES or m > MAX_SESSION_LIFETIME_MINUTES:
        raise HTTPException(
            400,
            f"out of range ({MIN_SESSION_LIFETIME_MINUTES}..{MAX_SESSION_LIFETIME_MINUTES})",
        )
    await set_setting(session, "session_lifetime_minutes", m)
    return {"session_lifetime_minutes": m}
@router.get("/ai/prompts")
async def list_prompts() -> list[str]:
    return sorted(p.stem for p in PROMPTS_DIR.glob("*.md"))


@router.get("/ai/prompts/{name}")
async def get_prompt(name: str) -> dict:
    p = PROMPTS_DIR / f"{name}.md"
    if not p.exists():
        raise HTTPException(404)
    return {"name": name, "content": p.read_text(encoding="utf-8")}


@router.put("/ai/prompts/{name}")
async def put_prompt(name: str, payload: dict) -> dict:
    if not name.replace("_", "").isalnum():
        raise HTTPException(400, "invalid name")
    content = payload.get("content", "")
    p = PROMPTS_DIR / f"{name}.md"
    p.write_text(content, encoding="utf-8")
    return {"ok": True}


# --- Backup / Restore ---------------------------------------------------------
#
# Vollständiges Backup aller Inhalte als ZIP-Archiv:
#   manifest.json           – Metadaten (Version, Zeitpunkt, Tabellenliste)
#   db/<table>.json         – pro Tabelle ein JSON-Dump (BLOB → base64,
#                              datetime → ISO-Strings, BINARY(16) → hex)
#   assets/<sha256>         – Roh-Dateien aus ASSET_DIR (Hash = Dateiname)
#   prompts/<name>.md       – aktuelle Prompt-Texte
#
# Restore ist destruktiv: bestehende Inhalte werden vor dem Einspielen geleert.

BACKUP_VERSION = 1
BACKUP_TABLES: list[tuple[str, type]] = [
    ("users", User),
    ("workspaces", Workspace),
    ("notes", Note),
    ("note_chunks", NoteChunk),
    ("assets", Asset),
    ("note_assets", NoteAsset),
    ("ai_providers", AIProvider),
    ("ai_cache", AICache),
    ("pending_jobs", PendingJob),
    ("app_settings", AppSetting),
]


def _to_jsonable(v):
    if isinstance(v, bytes):
        return {"__b64__": base64.b64encode(v).decode("ascii")}
    if isinstance(v, datetime):
        return {"__dt__": v.isoformat()}
    return v


def _from_jsonable(v):
    if isinstance(v, dict) and "__b64__" in v:
        return base64.b64decode(v["__b64__"])
    if isinstance(v, dict) and "__dt__" in v:
        return datetime.fromisoformat(v["__dt__"])
    return v


def _row_to_dict(row) -> dict:
    out = {}
    for col in row.__table__.columns:
        out[col.name] = _to_jsonable(getattr(row, col.name))
    return out


@router.get("/backup")
async def create_backup(session: AsyncSession = Depends(get_session)):
    settings = get_settings()
    asset_dir = Path(settings.asset_dir)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        manifest = {
            "version": BACKUP_VERSION,
            "created_at": datetime.utcnow().isoformat() + "Z",
            "tables": [name for name, _ in BACKUP_TABLES],
        }

        for name, model in BACKUP_TABLES:
            rows = (await session.execute(select(model))).scalars().all()
            data = [_row_to_dict(r) for r in rows]
            zf.writestr(f"db/{name}.json", json.dumps(data, ensure_ascii=False, indent=2))

        # Asset-Dateien (per sha256-Dateiname im ASSET_DIR abgelegt)
        if asset_dir.exists():
            for p in asset_dir.iterdir():
                if p.is_file():
                    zf.write(p, arcname=f"assets/{p.name}")

        # Aktuelle Prompts
        if PROMPTS_DIR.exists():
            for p in PROMPTS_DIR.glob("*.md"):
                zf.write(p, arcname=f"prompts/{p.name}")

        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

    buf.seek(0)
    ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    filename = f"mynotes-backup-{ts}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/restore")
async def restore_backup(
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Vollständiger Restore aus einem Backup-ZIP.

    ACHTUNG: Bestehende Inhalte werden vorher gelöscht (DB-Tabellen + Assets-
    Verzeichnis + Prompt-Dateien). Der eingeloggte Admin-User bleibt aktiv,
    da seine Session aus dem JWT lebt.
    """
    settings = get_settings()
    asset_dir = Path(settings.asset_dir)

    raw = await file.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(400, "kein gültiges ZIP-Archiv")

    names = set(zf.namelist())
    if "manifest.json" not in names:
        raise HTTPException(400, "manifest.json fehlt im Archiv")
    try:
        manifest = json.loads(zf.read("manifest.json"))
    except Exception as e:
        raise HTTPException(400, f"manifest.json unlesbar: {e}")
    if manifest.get("version") != BACKUP_VERSION:
        raise HTTPException(
            400, f"unsupported backup version: {manifest.get('version')}"
        )

    # 1) DB leeren – Reihenfolge umgekehrt zur Insert-Reihenfolge wegen FKs
    for name, model in reversed(BACKUP_TABLES):
        await session.execute(delete(model))
    await session.flush()

    # 2) DB neu befüllen
    summary: dict[str, int] = {}
    for name, model in BACKUP_TABLES:
        path = f"db/{name}.json"
        if path not in names:
            summary[name] = 0
            continue
        try:
            rows = json.loads(zf.read(path))
        except Exception as e:
            raise HTTPException(400, f"{path} unlesbar: {e}")
        if not isinstance(rows, list):
            raise HTTPException(400, f"{path} muss eine Liste sein")
        for r in rows:
            obj = model(**{k: _from_jsonable(v) for k, v in r.items()})
            session.add(obj)
        summary[name] = len(rows)
    await session.commit()

    # 3) Assets ersetzen
    asset_dir.mkdir(parents=True, exist_ok=True)
    for p in asset_dir.iterdir():
        if p.is_file():
            p.unlink()
    asset_count = 0
    for n in names:
        if n.startswith("assets/") and not n.endswith("/"):
            target = asset_dir / Path(n).name
            target.write_bytes(zf.read(n))
            asset_count += 1

    # 4) Prompts ersetzen (nur wenn welche im Archiv sind)
    prompt_count = 0
    has_prompts_in_archive = any(n.startswith("prompts/") for n in names)
    if has_prompts_in_archive:
        PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
        for p in PROMPTS_DIR.glob("*.md"):
            p.unlink()
        for n in names:
            if n.startswith("prompts/") and n.endswith(".md"):
                (PROMPTS_DIR / Path(n).name).write_bytes(zf.read(n))
                prompt_count += 1

    return {
        "ok": True,
        "rows": summary,
        "assets": asset_count,
        "prompts": prompt_count,
    }
