"""task tags, closed_at, kanban columns config

Revision ID: 0005_task_kanban
Revises: 0004_tasks
Create Date: 2026-05-13
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0005_task_kanban"
down_revision: str | None = "0004_tasks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE tasks ADD COLUMN tags JSON NULL AFTER due_date")
    op.execute("ALTER TABLE tasks ADD COLUMN closed_at DATETIME NULL AFTER tags")
    op.execute(
        "ALTER TABLE tasks MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'backlog'"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE tasks DROP COLUMN closed_at")
    op.execute("ALTER TABLE tasks DROP COLUMN tags")
    op.execute(
        "ALTER TABLE tasks MODIFY COLUMN status VARCHAR(30) NOT NULL DEFAULT 'backlog'"
    )
