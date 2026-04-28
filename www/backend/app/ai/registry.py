from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AIProvider as AIProviderRow
from .adapters.anthropic import AnthropicAdapter
from .adapters.compatible import CompatibleAdapter
from .adapters.gemini import GeminiAdapter
from .adapters.ollama import OllamaAdapter
from .adapters.openai import OpenAIAdapter
from .base import AIProviderClient


ADAPTERS: dict[str, type] = {
    "openai": OpenAIAdapter,
    "anthropic": AnthropicAdapter,
    "gemini": GeminiAdapter,
    "ollama": OllamaAdapter,
    "compatible": CompatibleAdapter,
}


def build_adapter(row: AIProviderRow) -> AIProviderClient:
    cls = ADAPTERS.get(row.adapter)
    if not cls:
        raise ValueError(f"unknown adapter: {row.adapter}")
    return cls(row.base_url, (row.api_key_enc or b"").decode("utf-8"), row.extras)


async def get_active(session: AsyncSession, capability: str) -> tuple[AIProviderRow, AIProviderClient]:
    """capability ∈ {chat, embed, vision}"""
    col = {
        "chat": AIProviderRow.is_active_chat,
        "embed": AIProviderRow.is_active_embed,
        "vision": AIProviderRow.is_active_vision,
    }[capability]
    row = (await session.execute(select(AIProviderRow).where(col.is_(True)).limit(1))).scalar_one_or_none()
    if not row:
        raise RuntimeError(f"no active {capability} provider configured")
    return row, build_adapter(row)
