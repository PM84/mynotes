"""widen note_chunks.embedding to MEDIUMBLOB

Revision ID: 0002_widen_chunk_embedding
Revises: 0001_initial
Create Date: 2026-04-28

VARBINARY(8192) reicht nicht für 3072-dim Embeddings (z. B. OpenAI
``text-embedding-3-large``: 3072 × 4 Byte = 12288 Byte). MEDIUMBLOB (16 MB)
deckt alle praxisrelevanten Modellgrößen ab.
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0002_widen_chunk_embedding"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE note_chunks MODIFY embedding MEDIUMBLOB NOT NULL")


def downgrade() -> None:
    op.execute("ALTER TABLE note_chunks MODIFY embedding VARBINARY(8192) NOT NULL")
