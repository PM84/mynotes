"""Anthropic-Adapter (Claude-Native-API)."""
from __future__ import annotations

import httpx

from ..base import AIProviderClient, ChatResponse, Message, ModelInfo


class AnthropicAdapter(AIProviderClient):
    name = "anthropic"

    def __init__(self, base_url: str, api_key: str, extras: dict | None = None) -> None:
        self.base_url = (base_url or "https://api.anthropic.com").rstrip("/")
        self.api_key = api_key
        self.version = (extras or {}).get("anthropic_version", "2023-06-01")

    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": self.version,
        }

    @staticmethod
    def _split(messages: list[Message]) -> tuple[str, list[dict]]:
        system_parts: list[str] = []
        msgs: list[dict] = []
        for m in messages:
            if m.role == "system":
                system_parts.append(m.content)
            else:
                msgs.append({"role": m.role, "content": m.content})
        return ("\n".join(system_parts), msgs)

    async def chat(self, messages, *, model, temperature=0.2, max_tokens=None) -> ChatResponse:
        system, msgs = self._split(messages)
        body: dict = {
            "model": model,
            "messages": msgs,
            "max_tokens": max_tokens or 2048,
            "temperature": temperature,
        }
        if system:
            body["system"] = system
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(f"{self.base_url}/v1/messages", json=body, headers=self._headers())
            r.raise_for_status()
            data = r.json()
        text = "".join(b.get("text", "") for b in data.get("content", []))
        return ChatResponse(text=text, raw=data)

    async def embed(self, texts, *, model):
        # Anthropic bietet kein Embedding-Endpoint → Fehler, der Caller wählt anderen Provider.
        raise NotImplementedError("Anthropic provides no embeddings endpoint")

    async def vision(self, image_b64, mime, prompt, *, model) -> str:
        body = {
            "model": model,
            "max_tokens": 4096,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "source": {"type": "base64", "media_type": mime, "data": image_b64}},
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        }
        async with httpx.AsyncClient(timeout=180) as c:
            r = await c.post(f"{self.base_url}/v1/messages", json=body, headers=self._headers())
            r.raise_for_status()
            data = r.json()
        return "".join(b.get("text", "") for b in data.get("content", []))

    async def healthcheck(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.post(
                    f"{self.base_url}/v1/messages",
                    json={"model": "ping", "max_tokens": 1, "messages": [{"role": "user", "content": "."}]},
                    headers=self._headers(),
                )
                return r.status_code in (200, 400, 404)
        except Exception:
            return False

    async def list_models(self) -> list[ModelInfo]:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(f"{self.base_url}/v1/models", headers=self._headers())
            r.raise_for_status()
            data = r.json()
        # Alle Claude-Modelle sind chat+vision-fähig, kein Embedding.
        ids = [d.get("id", "") for d in data.get("data", []) if d.get("id")]
        return [ModelInfo(id=mid, capabilities=("chat", "vision")) for mid in sorted(ids)]
