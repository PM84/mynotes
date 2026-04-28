"""initial schema

Revision ID: 0001_initial
Revises:
Create Date: 2026-04-28
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # users
    op.execute("""
        CREATE TABLE users (
            id BINARY(16) PRIMARY KEY,
            email VARCHAR(255) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            role VARCHAR(20) NOT NULL DEFAULT 'user',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)
    # workspaces
    op.execute("""
        CREATE TABLE workspaces (
            id BINARY(16) PRIMARY KEY,
            owner_id BINARY(16) NOT NULL,
            name VARCHAR(255) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_ws_owner FOREIGN KEY (owner_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)
    # notes
    op.execute("""
        CREATE TABLE notes (
            id BINARY(16) PRIMARY KEY,
            workspace_id BINARY(16) NOT NULL,
            parent_id BINARY(16) NULL,
            title VARCHAR(255) NOT NULL DEFAULT '',
            body_md MEDIUMTEXT NULL,
            excalidraw JSON NULL,
            ocr_text MEDIUMTEXT NULL,
            tags JSON NULL,
            deleted_at TIMESTAMP NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX ix_notes_workspace_updated (workspace_id, updated_at),
            INDEX ix_notes_parent (parent_id),
            CONSTRAINT fk_notes_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
            CONSTRAINT fk_notes_parent FOREIGN KEY (parent_id) REFERENCES notes(id),
            FULLTEXT KEY ft_notes (title, body_md, ocr_text)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)
    # note_chunks – Embeddings als VARBINARY (float32-Bytes)
    op.execute("""
        CREATE TABLE note_chunks (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            note_id BINARY(16) NOT NULL,
            idx INT NOT NULL,
            text TEXT NOT NULL,
            embedding VARBINARY(8192) NOT NULL,
            embed_model VARCHAR(100) NOT NULL,
            INDEX ix_chunks_note (note_id),
            CONSTRAINT fk_chunks_note FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # assets
    op.execute("""
        CREATE TABLE assets (
            id BINARY(16) PRIMARY KEY,
            sha256 CHAR(64) NOT NULL UNIQUE,
            mime VARCHAR(100) NOT NULL,
            size BIGINT NOT NULL,
            filename VARCHAR(255) NOT NULL,
            meta JSON NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)
    op.execute("""
        CREATE TABLE note_assets (
            note_id BINARY(16) NOT NULL,
            asset_id BINARY(16) NOT NULL,
            PRIMARY KEY (note_id, asset_id),
            CONSTRAINT fk_na_note FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
            CONSTRAINT fk_na_asset FOREIGN KEY (asset_id) REFERENCES assets(id)
        ) ENGINE=InnoDB
    """)
    # ai_providers
    op.execute("""
        CREATE TABLE ai_providers (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(100) NOT NULL UNIQUE,
            adapter VARCHAR(50) NOT NULL,
            base_url VARCHAR(255) NOT NULL,
            api_key_enc VARBINARY(1024) NOT NULL,
            chat_model VARCHAR(100) NULL,
            embed_model VARCHAR(100) NULL,
            vision_model VARCHAR(100) NULL,
            is_active_chat BOOLEAN NOT NULL DEFAULT FALSE,
            is_active_embed BOOLEAN NOT NULL DEFAULT FALSE,
            is_active_vision BOOLEAN NOT NULL DEFAULT FALSE,
            extras JSON NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # ai_cache
    op.execute("""
        CREATE TABLE ai_cache (
            hash CHAR(64) PRIMARY KEY,
            payload JSON NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # pending_jobs
    op.execute("""
        CREATE TABLE pending_jobs (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            kind VARCHAR(40) NOT NULL,
            payload JSON NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'queued',
            last_error TEXT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX ix_jobs_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)


def downgrade() -> None:
    for t in [
        "pending_jobs", "ai_cache", "ai_providers",
        "note_assets", "assets", "note_chunks", "notes", "workspaces", "users",
    ]:
        op.execute(f"DROP TABLE IF EXISTS {t}")
