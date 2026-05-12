from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

# Lockere E-Mail-Prüfung: erlaubt auch `.localhost`-TLDs (Pydantics EmailStr lehnt diese ab).
Email = Annotated[
    str,
    StringConstraints(pattern=r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$", max_length=254),
]


def b2u(b: bytes | None) -> uuid.UUID | None:
    return uuid.UUID(bytes=b) if b else None


class LoginIn(BaseModel):
    email: Email
    password: str


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    id: uuid.UUID
    email: Email
    role: str
    model_config = ConfigDict(from_attributes=True)


class NoteIn(BaseModel):
    id: uuid.UUID | None = None  # vom Client vergebbar (Offline-Queue)
    parent_id: uuid.UUID | None = None
    title: str = ""
    body_md: str | None = None
    excalidraw: dict | None = None
    tags: list[str] | None = None
    asset_ids: list[uuid.UUID] | None = None
    client_updated_at: datetime | None = None  # Optimistic-Locking


class NoteOut(BaseModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None
    title: str
    body_md: str | None
    excalidraw: dict | None
    ocr_text: str | None
    tags: list[str] | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None


class AssetOut(BaseModel):
    id: uuid.UUID
    sha256: str
    mime: str
    size: int
    filename: str


class SearchHit(BaseModel):
    note_id: uuid.UUID
    title: str
    snippet: str
    score: float


class AISummarizeIn(BaseModel):
    note_ids: list[uuid.UUID] = Field(min_length=1)
    # Optional: Canvas-Zeichnung (PNG/JPEG, base64) zur Notiz – wird zusammen
    # mit dem Markdown-Text an ein Vision-Modell geschickt.
    image_b64: str | None = None
    mime: str | None = None


class AIContradictionsIn(BaseModel):
    note_ids: list[uuid.UUID] = Field(min_length=1)


class AIRagIn(BaseModel):
    question: str
    top_k: int = 5


class AIRagOut(BaseModel):
    answer: str
    sources: list[dict[str, Any]]


class AICanvasIn(BaseModel):
    image_b64: str  # PNG/JPEG ohne `data:`-Präfix
    mime: str = "image/png"
    mode: str  # transcribe | summary | elaborate | cleanup


class ProviderIn(BaseModel):
    name: str
    adapter: str
    base_url: str
    api_key: str | None = None  # Plain – wird verschlüsselt gespeichert
    chat_model: str | None = None
    embed_model: str | None = None
    vision_model: str | None = None
    is_active_chat: bool = False
    is_active_embed: bool = False
    is_active_vision: bool = False
    extras: dict | None = None


class ProviderOut(BaseModel):
    id: int
    name: str
    adapter: str
    base_url: str
    has_key: bool
    chat_model: str | None
    embed_model: str | None
    vision_model: str | None
    is_active_chat: bool
    is_active_embed: bool
    is_active_vision: bool


# ---------- Tasks ----------

class TaskIn(BaseModel):
    id: uuid.UUID | None = None
    note_id: uuid.UUID | None = None
    title: str = ""
    description: str | None = None
    status: str = "backlog"
    priority: int = 0
    position: int = 0
    due_date: datetime | None = None
    client_updated_at: datetime | None = None


class TaskOut(BaseModel):
    id: uuid.UUID
    note_id: uuid.UUID | None
    title: str
    description: str | None
    status: str
    priority: int
    position: int
    due_date: datetime | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None
