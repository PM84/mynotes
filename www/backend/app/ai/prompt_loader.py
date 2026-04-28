"""Lädt Prompts aus app/ai/prompts/*.md."""
from __future__ import annotations

from pathlib import Path

_DIR = Path(__file__).parent / "prompts"


def load(name: str) -> str:
    p = _DIR / f"{name}.md"
    return p.read_text(encoding="utf-8")
