"""tasks table

Revision ID: 0004_tasks
Revises: 0003_app_settings
Create Date: 2026-05-12
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0004_tasks"
down_revision: str | None = "0003_app_settings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE tasks (
            id BINARY(16) NOT NULL PRIMARY KEY,
            workspace_id BINARY(16) NOT NULL,
            note_id BINARY(16) NULL,
            title VARCHAR(500) NOT NULL DEFAULT '',
            description TEXT NULL,
            status VARCHAR(30) NOT NULL DEFAULT 'backlog',
            priority TINYINT NOT NULL DEFAULT 0,
            position INT NOT NULL DEFAULT 0,
            due_date DATETIME NULL,
            deleted_at DATETIME NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT fk_tasks_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
            CONSTRAINT fk_tasks_note FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE SET NULL,
            INDEX ix_tasks_workspace_status (workspace_id, status),
            INDEX ix_tasks_workspace_updated (workspace_id, updated_at),
            INDEX ix_tasks_note (note_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS tasks")
