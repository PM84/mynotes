from __future__ import annotations

import json
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..ai.base import Message
from ..ai.prompt_loader import load
from ..ai.rag import answer as rag_answer
from ..ai.registry import get_active
from ..db import get_session
from ..deps import get_current_user
from ..models import Note, User
from ..schemas import (
    AIContradictionsIn, AIRagIn, AIRagOut, AISummarizeIn,
    AICanvasIn, AIExtractTasksIn, AIMemoIn, AIMemoSendIn,
    MemoOut,
)

router = APIRouter(prefix="/ai", tags=["ai"])


async def _get_active_or_400(session: AsyncSession, capability: str):
    """Wrapper, der eine fehlende Provider-Konfiguration in HTTPException(503)
    übersetzt, damit der Client eine saubere Fehlermeldung mit CORS-Headern
    bekommt statt eines ungefangenen 500."""
    try:
        return await get_active(session, capability)
    except RuntimeError as e:
        raise HTTPException(503, str(e))


def _http_to_status(e: httpx.HTTPStatusError) -> HTTPException:
    """Upstream-Fehler des Modell-Providers in 4xx/5xx mappen, damit das
    Frontend (statt 500 ohne CORS) eine verständliche Antwort erhält."""
    code = e.response.status_code
    body = e.response.text[:500]
    if code in (400, 404):
        return HTTPException(400, f"upstream rejected request ({code}): {body}")
    if code in (401, 403):
        return HTTPException(502, f"upstream auth/permission failed ({code})")
    if code == 429:
        return HTTPException(429, "upstream rate-limited")
    return HTTPException(502, f"upstream error ({code}): {body}")


async def _gather_notes_text(session: AsyncSession, ids: list[uuid.UUID]) -> str:
    rows = (
        await session.execute(select(Note).where(Note.id.in_([i.bytes for i in ids])))
    ).scalars().all()
    parts = []
    for n in rows:
        nid = uuid.UUID(bytes=n.id)
        parts.append(f"### Notiz [id:{nid}] {n.title}\n{(n.body_md or '')}\n{(n.ocr_text or '')}")
    return "\n\n---\n\n".join(parts)


@router.post("/summarize")
async def summarize(
    data: AISummarizeIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    text = await _gather_notes_text(session, data.note_ids)
    if not text:
        raise HTTPException(404, "no notes found")
    prompt = load("summarize").format(content=text)

    # Wenn ein Canvas-Bild mitgeliefert wurde, beziehe es in die Zusammenfassung
    # ein (Vision-Modell). Sonst Standard-Chat.
    if data.image_b64 and data.mime:
        if not data.mime.startswith("image/"):
            raise HTTPException(400, "mime must be image/*")
        row, client = await _get_active_or_400(session, "vision")
        if not row.vision_model:
            raise HTTPException(400, "no vision_model on active provider")
        vision_prompt = (
            prompt
            + "\n\nZusätzlich liegt ein Bild des Zeichenbereichs der Notiz bei "
            "(Skizze, Handschrift, eingebettete Screenshots/Fotos). "
            "Fasse dessen Inhalt inhaltlich-semantisch zusammen: erkannte Texte, "
            "Aussagen, Fakten, Begriffe, dargestellte Sachverhalte. "
            "Beschreibe Layout, Position oder Aussehen NUR dann, wenn es für das "
            "Verständnis des Inhalts wesentlich ist (z. B. Pfeile/Beziehungen in "
            "einem Diagramm). Verzichte auf Beschreibungen wie „Rahmen oben rechts“, "
            "„Kasten unten links“ o. ä., wenn sie inhaltlich nichts beitragen."
        )
        try:
            text_out = await client.vision(
                data.image_b64, data.mime, vision_prompt, model=row.vision_model
            )
        except httpx.HTTPStatusError as e:
            raise _http_to_status(e)
        return {"summary": text_out}

    row, client = await _get_active_or_400(session, "chat")
    if not row.chat_model:
        raise HTTPException(400, "no chat_model on active provider")
    try:
        resp = await client.chat([Message(role="user", content=prompt)], model=row.chat_model)
    except httpx.HTTPStatusError as e:
        raise _http_to_status(e)
    return {"summary": resp.text}


@router.post("/contradictions")
async def contradictions(
    data: AIContradictionsIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    text = await _gather_notes_text(session, data.note_ids)
    if not text:
        raise HTTPException(404, "no notes found")
    prompt = load("contradiction").format(content=text)
    row, client = await _get_active_or_400(session, "chat")
    if not row.chat_model:
        raise HTTPException(400, "no chat_model on active provider")
    try:
        resp = await client.chat([Message(role="user", content=prompt)], model=row.chat_model)
    except httpx.HTTPStatusError as e:
        raise _http_to_status(e)
    return {"report": resp.text}


@router.post("/auto_tag")
async def auto_tag(
    note_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    n = await session.get(Note, note_id.bytes)
    if not n:
        raise HTTPException(404, "not found")
    prompt = load("auto_tag").format(content=f"{n.title}\n{n.body_md or ''}\n{n.ocr_text or ''}")
    row, client = await _get_active_or_400(session, "chat")
    if not row.chat_model:
        raise HTTPException(400, "no chat_model on active provider")
    try:
        resp = await client.chat([Message(role="user", content=prompt)], model=row.chat_model)
    except httpx.HTTPStatusError as e:
        raise _http_to_status(e)
    try:
        tags = json.loads(resp.text)
        if not isinstance(tags, list):
            raise ValueError
        tags = [str(t).strip().lower() for t in tags][:7]
    except Exception:
        tags = []
    return {"tags": tags}


@router.post("/rag", response_model=AIRagOut)
async def rag(
    data: AIRagIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> AIRagOut:
    out = await rag_answer(session, data.question, top_k=data.top_k)
    return AIRagOut(**out)


CANVAS_TASKS = {
    "transcribe": (
        "Transkribiere den Inhalt möglichst wortgetreu und vollständig. "
        "Handgeschriebener Text wird zu Markdown-Fließtext, gezeichnete Listen zu "
        "Markdown-Listen, Tabellen zu Markdown-Tabellen, Formeln in LaTeX ($...$). "
        "Diagramm-Strukturen als Mermaid-Block, wenn möglich, sonst als beschriftete "
        "Liste. Nutze den Kontext umliegender Wörter, um schwer lesbare Stellen zu "
        "erschließen. Korrigiere KEINE Rechtschreibung – gib den Text exakt so "
        "wieder, wie er geschrieben wurde. Markiere wirklich unleserliche Stellen "
        "mit [unleserlich]."
    ),
    "summary": (
        "Erstelle eine prägnante, inhaltlich-semantische Zusammenfassung der "
        "Kerninhalte als Bullet-Liste mit max. 7 Punkten. Konzentriere dich auf "
        "Aussagen, Fakten, Begriffe und Sachverhalte. Beschreibe Layout, Position "
        "oder Aussehen nur, wenn es für das Verständnis wesentlich ist (z. B. "
        "Beziehungen in einem Diagramm). Nimm nur das auf, was tatsächlich auf "
        "dem Bild zu sehen ist."
    ),
    "elaborate": (
        "Erstelle eine ausgearbeitete, strukturierte Notiz mit Überschriften, "
        "Erklärungen und ggf. Beispielen. Erweitere knappe Stichworte zu vollständigen "
        "Sätzen, ohne Inhalte zu erfinden, die der Skizze widersprechen. Markiere mit "
        "_Kursiv_ klar gekennzeichnete Ergänzungen aus Allgemeinwissen."
    ),
    "cleanup": (
        "Bereinige den Inhalt: korrigiere Rechtschreibung, vereinheitliche Notation, "
        "ordne Punkte logisch, entferne Doppelungen. Behalte den Stil knapp und "
        "stichpunktartig, wenn das Original stichpunktartig ist."
    ),
}


@router.post("/canvas")
async def canvas_to_md(
    data: AICanvasIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Wandelt eine Canvas-Zeichnung (PNG/JPEG) in Markdown um.

    Modi: transcribe (wortgetreu), summary (Bullet-Liste), elaborate
    (Ausarbeitung), cleanup (bereinigen/optimieren).
    """
    task = CANVAS_TASKS.get(data.mode)
    if not task:
        raise HTTPException(400, f"unknown mode: {data.mode}")
    if not data.mime.startswith("image/"):
        raise HTTPException(400, "mime must be image/*")
    row, client = await _get_active_or_400(session, "vision")
    if not row.vision_model:
        raise HTTPException(400, "no vision_model on active provider")
    prompt = load("canvas").format(task=task)
    try:
        text = await client.vision(data.image_b64, data.mime, prompt, model=row.vision_model)
    except httpx.HTTPStatusError as e:
        raise _http_to_status(e)
    return {"markdown": text}


@router.post("/vision_ocr")
async def vision_ocr(
    asset_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Triggert Vision-OCR auf einem Asset (Bild). Antwort = extrahierter Text."""
    import base64

    from pathlib import Path

    from ..config import get_settings
    from ..models import Asset

    a = await session.get(Asset, asset_id.bytes)
    if not a:
        raise HTTPException(404, "asset not found")
    if not a.mime.startswith("image/"):
        raise HTTPException(400, "only images supported for vision_ocr")
    p = Path(get_settings().asset_dir) / a.sha256[:2] / a.sha256[2:4] / a.sha256
    if not p.exists():
        raise HTTPException(410, "asset file missing")
    image_b64 = base64.b64encode(p.read_bytes()).decode()
    row, client = await _get_active_or_400(session, "vision")
    if not row.vision_model:
        raise HTTPException(400, "no vision_model on active provider")
    prompt = load("vision_ocr")
    try:
        text = await client.vision(image_b64, a.mime, prompt, model=row.vision_model)
    except httpx.HTTPStatusError as e:
        raise _http_to_status(e)
    return {"text": text}


@router.post("/extract_tasks")
async def extract_tasks(
    data: AIExtractTasksIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Extrahiert Aufgaben aus einer Notiz via KI und erstellt/aktualisiert/markiert Tasks."""
    from ..models import Note, Task
    from .ws import broadcast_user
    from ..deps import get_default_workspace

    ws = await get_default_workspace(user, session)
    note = await session.get(Note, data.note_id.bytes)
    if not note or note.workspace_id != ws.id:
        raise HTTPException(404, "note not found")

    # Bestehende aktive Tasks dieser Notiz laden.
    existing_rows = (
        await session.execute(
            select(Task).where(
                Task.workspace_id == ws.id,
                Task.note_id == data.note_id.bytes,
                Task.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    existing_list = []
    for t in existing_rows:
        tid = uuid.UUID(bytes=t.id)
        existing_list.append({"id": str(tid), "title": t.title, "description": t.description or ""})
    existing_json = json.dumps(existing_list, ensure_ascii=False) if existing_list else "(keine)"

    content = f"{note.title}\n{note.body_md or ''}\n{note.ocr_text or ''}"
    prompt_template = load("extract_tasks")
    prompt = prompt_template.format(existing_tasks=existing_json, content=content)

    # Wenn ein Canvas-Bild mitgeliefert wurde, Vision-Modell nutzen.
    if data.image_b64 and data.mime:
        if not data.mime.startswith("image/"):
            raise HTTPException(400, "mime must be image/*")
        row, client = await _get_active_or_400(session, "vision")
        if not row.vision_model:
            raise HTTPException(400, "no vision_model on active provider")
        try:
            raw = await client.vision(data.image_b64, data.mime, prompt, model=row.vision_model)
        except httpx.HTTPStatusError as e:
            raise _http_to_status(e)
    else:
        row, client = await _get_active_or_400(session, "chat")
        if not row.chat_model:
            raise HTTPException(400, "no chat_model on active provider")
        try:
            resp = await client.chat([Message(role="user", content=prompt)], model=row.chat_model)
        except httpx.HTTPStatusError as e:
            raise _http_to_status(e)
        raw = resp.text

    # JSON parsen (KI gibt manchmal Markdown-Codeblöcke zurück).
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError:
        raise HTTPException(502, "KI-Antwort konnte nicht als JSON geparst werden")

    tasks_data = result.get("tasks", [])
    removed_ids = result.get("removed_ids", [])

    created = 0
    updated = 0
    marked_dnf = 0

    existing_map = {str(uuid.UUID(bytes=t.id)): t for t in existing_rows}

    # Bestehende Position ermitteln für neue Tasks.
    max_pos_result = (
        await session.execute(
            select(Task.position).where(Task.workspace_id == ws.id).order_by(Task.position.desc()).limit(1)
        )
    ).scalar_one_or_none()
    next_pos = (max_pos_result or 0) + 1

    # Tasks erstellen/aktualisieren.
    for td in tasks_data:
        match_id = td.get("match_id")
        title = (td.get("title") or "")[:200]
        description = td.get("description") or None

        if match_id and match_id in existing_map:
            # Aktualisieren.
            t = existing_map[match_id]
            t.title = title
            t.description = description
            updated += 1
        else:
            # Neue Aufgabe.
            t = Task(
                id=uuid.uuid4().bytes,
                workspace_id=ws.id,
                note_id=data.note_id.bytes,
                title=title,
                description=description,
                status="todo",
                priority=0,
                position=next_pos,
            )
            session.add(t)
            next_pos += 1
            created += 1

    # Entfernte Aufgaben mit DNF-Präfix markieren.
    for rid in removed_ids:
        if rid in existing_map:
            t = existing_map[rid]
            if not t.title.startswith("DNF: "):
                t.title = f"DNF: {t.title}"
                marked_dnf += 1

    await session.commit()

    # Broadcast für Echtzeit-Sync.
    await broadcast_user(
        user.id,
        {"type": "task.upsert", "source": "extract_tasks"},
    )

    return {"created": created, "updated": updated, "marked_dnf": marked_dnf}


# ---------------------------------------------------------------------------
# Aktennotiz / E-Mail
# ---------------------------------------------------------------------------

async def _single_note_text(session: AsyncSession, note_id: uuid.UUID) -> str:
    """Textinhalt einer einzelnen Notiz für die Aktennotiz-Generierung."""
    n = await session.get(Note, note_id.bytes)
    if not n:
        raise HTTPException(404, "note not found")
    created = n.created_at.strftime("%d.%m.%Y") if n.created_at else "unbekannt"
    return f"### {n.title}\nErstellt am: {created}\n{n.body_md or ''}\n{n.ocr_text or ''}"


@router.post("/memo")
async def generate_memo(
    data: AIMemoIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Generiert eine Aktennotiz (Memo) aus einer Notiz via KI und speichert sie."""
    from ..deps import get_default_workspace
    from ..models import Memo

    ws = await get_default_workspace(user, session)
    text = await _single_note_text(session, data.note_id)
    prompt = load("memo").format(content=text)

    if data.image_b64 and data.mime:
        if not data.mime.startswith("image/"):
            raise HTTPException(400, "mime must be image/*")
        row, client = await _get_active_or_400(session, "vision")
        if not row.vision_model:
            raise HTTPException(400, "no vision_model on active provider")
        vision_prompt = (
            prompt
            + "\n\nZusätzlich liegt ein Bild des Zeichenbereichs der Notiz bei. "
            "Berücksichtige dessen Inhalt in der Aktennotiz."
        )
        try:
            memo_text = await client.vision(
                data.image_b64, data.mime, vision_prompt, model=row.vision_model
            )
        except httpx.HTTPStatusError as e:
            raise _http_to_status(e)
    else:
        row, client = await _get_active_or_400(session, "chat")
        if not row.chat_model:
            raise HTTPException(400, "no chat_model on active provider")
        try:
            resp = await client.chat([Message(role="user", content=prompt)], model=row.chat_model)
        except httpx.HTTPStatusError as e:
            raise _http_to_status(e)
        memo_text = resp.text

    memo = Memo(
        workspace_id=ws.id,
        note_id=data.note_id.bytes,
        content=memo_text,
    )
    session.add(memo)
    await session.commit()
    await session.refresh(memo)

    # Notiz-Titel für Antwort laden
    n = await session.get(Note, data.note_id.bytes)
    note_title = n.title if n else None

    memo_id = uuid.UUID(bytes=memo.id)
    return {
        "id": str(memo_id),
        "note_id": str(data.note_id),
        "note_title": note_title,
        "content": memo_text,
        "created_at": memo.created_at.isoformat(),
    }


@router.post("/memo/send")
async def send_memo(
    data: AIMemoSendIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Sendet ein gespeichertes Memo per E-Mail."""
    import re
    from ..email import send_email
    from ..models import Memo

    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", data.recipient):
        raise HTTPException(400, "Ungültige E-Mail-Adresse")

    memo = await session.get(Memo, data.memo_id.bytes)
    if not memo:
        raise HTTPException(404, "memo not found")

    # Notiz-Titel für Betreff holen
    n = await session.get(Note, memo.note_id) if memo.note_id else None
    subject = f"Aktennotiz: {n.title}" if n else "Aktennotiz"

    try:
        await send_email(session, data.recipient, subject, memo.content)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except Exception as e:
        raise HTTPException(502, f"E-Mail-Versand fehlgeschlagen: {e}")

    await _save_recent_email(session, user, data.recipient)
    return {"ok": True}


async def _save_recent_email(session: AsyncSession, user: User, email: str) -> None:
    """Speichert eine E-Mail-Adresse in der per-user Recent-Liste (max 3, nach letzter
    Verwendung absteigend sortiert)."""
    from datetime import datetime, timezone
    from ..app_settings import get_setting, set_setting

    MAX_RECENT = 3
    key = f"recent_email_{uuid.UUID(bytes=user.id)}"
    entries: list[dict] = await get_setting(session, key, [])
    if not isinstance(entries, list):
        entries = []

    # Bestehenden Eintrag entfernen (case-insensitive)
    entries = [e for e in entries if e.get("email", "").lower() != email.lower()]
    # Vorn einfügen
    entries.insert(0, {"email": email, "last_used": datetime.now(timezone.utc).isoformat()})
    # Max 3
    entries = entries[:MAX_RECENT]

    await set_setting(session, key, entries)


@router.get("/memo/addresses")
async def get_recent_emails(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Gibt die zuletzt verwendeten E-Mail-Adressen zurück (max 3)."""
    from ..app_settings import get_setting

    key = f"recent_email_{uuid.UUID(bytes=user.id)}"
    entries: list[dict] = await get_setting(session, key, [])
    if not isinstance(entries, list):
        entries = []
    return {"addresses": [e.get("email", "") for e in entries[:3]]}


@router.get("/memos", response_model=list[MemoOut])
async def list_memos(
    q: str = "",
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[MemoOut]:
    """Alle Memos des Benutzers auflisten, optional nach Suchbegriff filtern."""
    from ..deps import get_default_workspace
    from ..models import Memo

    ws = await get_default_workspace(user, session)
    stmt = (
        select(Memo)
        .where(Memo.workspace_id == ws.id)
        .order_by(Memo.created_at.desc())
    )
    rows = (await session.execute(stmt)).scalars().all()

    result: list[MemoOut] = []
    for m in rows:
        # Notiz-Titel laden
        note_title = None
        if m.note_id:
            n = await session.get(Note, m.note_id)
            if n:
                note_title = n.title

        # Suchfilter (case-insensitive auf content + note_title)
        if q:
            ql = q.lower()
            if ql not in m.content.lower() and (not note_title or ql not in note_title.lower()):
                continue

        result.append(MemoOut(
            id=uuid.UUID(bytes=m.id),
            note_id=uuid.UUID(bytes=m.note_id) if m.note_id else None,
            note_title=note_title,
            content=m.content,
            created_at=m.created_at,
        ))

    return result


@router.delete("/memos/{memo_id}")
async def delete_memo(
    memo_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Löscht ein Memo."""
    from ..deps import get_default_workspace
    from ..models import Memo

    ws = await get_default_workspace(user, session)
    memo = await session.get(Memo, memo_id.bytes)
    if not memo or memo.workspace_id != ws.id:
        raise HTTPException(404, "memo not found")
    await session.delete(memo)
    await session.commit()
    return {"ok": True}
