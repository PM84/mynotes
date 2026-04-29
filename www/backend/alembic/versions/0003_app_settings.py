"""app settings

Revision ID: 0003_app_settings
Revises: 0002_widen_chunk_embedding
Create Date: 2026-04-29
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0003_app_settings"
down_revision: str | None = "0002_widen_chunk_embedding"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE app_settings (
            name VARCHAR(100) PRIMARY KEY,
            value JSON NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS app_settings")
