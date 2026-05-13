"""memos table

Revision ID: 0006_memos
Revises: 0005_task_kanban
Create Date: 2026-05-13
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0006_memos"
down_revision: str | None = "0005_task_kanban"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE memos (
            id BINARY(16) NOT NULL,
            workspace_id BINARY(16) NOT NULL,
            note_id BINARY(16) NULL,
            content MEDIUMTEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            INDEX ix_memos_workspace_id (workspace_id),
            INDEX ix_memos_note_id (note_id),
            INDEX ix_memos_workspace_created (workspace_id, created_at),
            CONSTRAINT fk_memos_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
            CONSTRAINT fk_memos_note FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)


def downgrade() -> None:
    op.execute("DROP TABLE memos")
