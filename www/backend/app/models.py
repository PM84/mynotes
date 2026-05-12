from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, JSON, LargeBinary, String, Text,
    UniqueConstraint, func,
)
from sqlalchemy.dialects.mysql import BINARY, MEDIUMTEXT, VARBINARY
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def uuid_bytes() -> bytes:
    return uuid.uuid4().bytes


class User(Base):
    __tablename__ = "users"
    id: Mapped[bytes] = mapped_column(BINARY(16), primary_key=True, default=uuid_bytes)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="user")  # user | admin
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Workspace(Base):
    __tablename__ = "workspaces"
    id: Mapped[bytes] = mapped_column(BINARY(16), primary_key=True, default=uuid_bytes)
    owner_id: Mapped[bytes] = mapped_column(BINARY(16), ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Note(Base):
    __tablename__ = "notes"
    id: Mapped[bytes] = mapped_column(BINARY(16), primary_key=True, default=uuid_bytes)
    workspace_id: Mapped[bytes] = mapped_column(BINARY(16), ForeignKey("workspaces.id"), index=True)
    parent_id: Mapped[bytes | None] = mapped_column(BINARY(16), ForeignKey("notes.id"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(255), default="")
    body_md: Mapped[str | None] = mapped_column(MEDIUMTEXT, nullable=True)
    excalidraw: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    ocr_text: Mapped[str | None] = mapped_column(MEDIUMTEXT, nullable=True)
    tags: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    chunks: Mapped[list[NoteChunk]] = relationship(
        "NoteChunk", cascade="all, delete-orphan", back_populates="note"
    )
    asset_links: Mapped[list[NoteAsset]] = relationship(
        "NoteAsset", cascade="all, delete-orphan", back_populates="note"
    )

    __table_args__ = (
        Index("ix_notes_workspace_updated", "workspace_id", "updated_at"),
    )


class NoteChunk(Base):
    """
    Speichert Chunk-Text + Embedding. Die `embedding`-Spalte wird per Alembic-Migration
    als MariaDB-`VECTOR(N)` mit nativem HNSW-Index erzeugt (siehe alembic/versions/0001).
    SQLAlchemy sieht sie hier als VARBINARY (Vektoren werden als float32-Bytes serialisiert).
    """
    __tablename__ = "note_chunks"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    note_id: Mapped[bytes] = mapped_column(
        BINARY(16), ForeignKey("notes.id", ondelete="CASCADE"), index=True
    )
    idx: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    # MEDIUMBLOB (bis 16 MB) – reicht für 3072-dim float32-Embeddings (~12 KB)
    # und mehr; vorher VARBINARY(8192), zu klein für `text-embedding-3-large`.
    embedding: Mapped[bytes] = mapped_column(LargeBinary(length=(2**24) - 1))
    embed_model: Mapped[str] = mapped_column(String(100))
    note: Mapped[Note] = relationship("Note", back_populates="chunks")


class Asset(Base):
    __tablename__ = "assets"
    id: Mapped[bytes] = mapped_column(BINARY(16), primary_key=True, default=uuid_bytes)
    sha256: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    mime: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(BigInteger)
    filename: Mapped[str] = mapped_column(String(255))
    meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class NoteAsset(Base):
    __tablename__ = "note_assets"
    note_id: Mapped[bytes] = mapped_column(
        BINARY(16), ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True
    )
    asset_id: Mapped[bytes] = mapped_column(BINARY(16), ForeignKey("assets.id"), primary_key=True)
    note: Mapped[Note] = relationship("Note", back_populates="asset_links")


class AIProvider(Base):
    __tablename__ = "ai_providers"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    adapter: Mapped[str] = mapped_column(String(50))
    base_url: Mapped[str] = mapped_column(String(255))
    api_key_enc: Mapped[bytes] = mapped_column(VARBINARY(1024), default=b"")
    chat_model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    embed_model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    vision_model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    is_active_chat: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active_embed: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active_vision: Mapped[bool] = mapped_column(Boolean, default=False)
    extras: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class AICache(Base):
    __tablename__ = "ai_cache"
    hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class PendingJob(Base):
    """Server-seitige Jobs (Embedding, Vision-OCR) – ausgelöst nach Sync."""
    __tablename__ = "pending_jobs"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(40))  # embed | vision_ocr
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued|running|done|failed
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class Task(Base):
    __tablename__ = "tasks"
    id: Mapped[bytes] = mapped_column(BINARY(16), primary_key=True, default=uuid_bytes)
    workspace_id: Mapped[bytes] = mapped_column(BINARY(16), ForeignKey("workspaces.id"), index=True)
    note_id: Mapped[bytes | None] = mapped_column(BINARY(16), ForeignKey("notes.id", ondelete="SET NULL"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(500), default="")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(30), default="backlog")  # backlog|todo|doing|done
    priority: Mapped[int] = mapped_column(Integer, default=0)
    position: Mapped[int] = mapped_column(Integer, default=0)
    due_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index("ix_tasks_workspace_status", "workspace_id", "status"),
        Index("ix_tasks_workspace_updated", "workspace_id", "updated_at"),
    )


class AppSetting(Base):
    """Globale, zur Laufzeit veränderbare Konfiguration (Key/Value, JSON-Wert)."""
    __tablename__ = "app_settings"
    name: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
