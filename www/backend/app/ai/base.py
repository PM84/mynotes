from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass
class Message:
    role: str  # system | user | assistant
    content: str


@dataclass
class ChatResponse:
    text: str
    raw: dict | None = None


@dataclass
class ModelInfo:
    """Modell-Eintrag mit grober Capability-Klassifikation."""

    id: str
    capabilities: tuple[str, ...]  # Teilmenge von ("chat", "embed", "vision")


class AIProviderClient(Protocol):
    name: str

    async def chat(
        self,
        messages: list[Message],
        *,
        model: str,
        temperature: float = 0.2,
        max_tokens: int | None = None,
    ) -> ChatResponse: ...

    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]: ...

    async def vision(self, image_b64: str, mime: str, prompt: str, *, model: str) -> str: ...

    async def healthcheck(self) -> bool: ...

    async def list_models(self) -> list[ModelInfo]: ...
