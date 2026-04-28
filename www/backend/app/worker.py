"""Background-Worker: Embedding + Vision-OCR aus pending_jobs."""
from __future__ import annotations

import asyncio
import base64
import logging
import uuid
from pathlib import Path

from sqlalchemy import select, update

from .ai.embedding import reembed_note
from .ai.prompt_loader import load
from .ai.registry import get_active
from .config import get_settings
from .db import SessionLocal
from .models import Asset, Note, NoteAsset, PendingJob

log = logging.getLogger("worker")


async def _process_embed(job: PendingJob) -> None:
    note_id = uuid.UUID(job.payload["note_id"]).bytes
    async with SessionLocal() as s:
        note = await s.get(Note, note_id)
        if not note:
            return
        try:
            n = await reembed_note(s, note)
            log.info("embedded note %s (%d chunks)", uuid.UUID(bytes=note_id), n)
            await s.commit()
        except Exception as e:
            log.warning("embed failed: %s", e)
            raise


async def _process_vision_ocr(job: PendingJob) -> None:
    asset_id = uuid.UUID(job.payload["asset_id"]).bytes
    async with SessionLocal() as s:
        a = await s.get(Asset, asset_id)
        if not a or not a.mime.startswith("image/"):
            return
        p = Path(get_settings().asset_dir) / a.sha256[:2] / a.sha256[2:4] / a.sha256
        if not p.exists():
            return
        image_b64 = base64.b64encode(p.read_bytes()).decode()
        row, client = await get_active(s, "vision")
        if not row.vision_model:
            raise RuntimeError("no active vision provider")
        text = await client.vision(image_b64, a.mime, load("vision_ocr"), model=row.vision_model)
        # OCR-Text an alle verlinkten Notes anhängen + Re-Embed-Job
        links = (
            await s.execute(select(NoteAsset).where(NoteAsset.asset_id == asset_id))
        ).scalars().all()
        for link in links:
            note = await s.get(Note, link.note_id)
            if note:
                note.ocr_text = (note.ocr_text or "") + "\n\n" + text
                s.add(PendingJob(kind="embed", payload={"note_id": uuid.UUID(bytes=note.id).hex}))
        await s.commit()
        log.info("vision_ocr done for asset %s", uuid.UUID(bytes=asset_id))


HANDLERS = {
    "embed": _process_embed,
    "vision_ocr": _process_vision_ocr,
}


async def loop() -> None:
    """Sehr einfache Polling-Schleife. Für MVP ausreichend."""
    while True:
        try:
            async with SessionLocal() as s:
                job = (
                    await s.execute(
                        select(PendingJob).where(PendingJob.status == "queued").limit(1)
                    )
                ).scalar_one_or_none()
                if not job:
                    await asyncio.sleep(2)
                    continue
                await s.execute(
                    update(PendingJob).where(PendingJob.id == job.id).values(status="running")
                )
                await s.commit()
                jid, kind = job.id, job.kind
            try:
                handler = HANDLERS.get(kind)
                if not handler:
                    raise RuntimeError(f"unknown job kind {kind}")
                await handler(job)
                async with SessionLocal() as s:
                    await s.execute(
                        update(PendingJob).where(PendingJob.id == jid).values(status="done")
                    )
                    await s.commit()
            except Exception as e:
                log.exception("job %d failed: %s", jid, e)
                async with SessionLocal() as s:
                    await s.execute(
                        update(PendingJob)
                        .where(PendingJob.id == jid)
                        .values(status="failed", last_error=str(e)[:1000])
                    )
                    await s.commit()
        except Exception as e:
            log.exception("worker loop error: %s", e)
            await asyncio.sleep(5)
