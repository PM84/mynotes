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
from ..schemas import AIContradictionsIn, AIRagIn, AIRagOut, AISummarizeIn, AICanvasIn

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
        "Transkribiere den Inhalt möglichst wortgetreu. Handgeschriebener Text wird zu "
        "Markdown-Fließtext, gezeichnete Listen zu Markdown-Listen, Tabellen zu "
        "Markdown-Tabellen, Formeln in LaTeX. Diagramm-Strukturen als Mermaid-Block, "
        "wenn möglich, sonst als beschriftete Liste."
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
