"""E-Mail-Versand via SMTP (async)."""
from __future__ import annotations

import logging
from email.message import EmailMessage

import aiosmtplib
from sqlalchemy.ext.asyncio import AsyncSession

from .app_settings import get_setting

log = logging.getLogger(__name__)


async def send_email(session: AsyncSession, to: str, subject: str, body_text: str) -> None:
    """Sendet eine Klartext-Mail an *to*.

    SMTP-Einstellungen werden aus den App-Settings (DB) gelesen.
    Wirft RuntimeError, wenn SMTP nicht konfiguriert ist, und lässt
    aiosmtplib-Fehler durchblasen.
    """
    host = await get_setting(session, "smtp_host", "")
    if not host:
        raise RuntimeError("SMTP ist nicht konfiguriert (smtp_host fehlt)")

    port = int(await get_setting(session, "smtp_port", 587))
    user = await get_setting(session, "smtp_user", "")
    password = await get_setting(session, "smtp_password", "")
    from_addr = await get_setting(session, "smtp_from", "")
    use_tls = await get_setting(session, "smtp_use_tls", True)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_addr or user
    msg["To"] = to
    msg.set_content(body_text)

    log.info("Sending email to=%s subject=%s via %s:%s", to, subject, host, port)
    await aiosmtplib.send(
        msg,
        hostname=host,
        port=port,
        username=user or None,
        password=password or None,
        start_tls=bool(use_tls),
    )
