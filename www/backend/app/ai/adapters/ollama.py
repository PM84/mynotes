"""Ollama-Adapter (lokale Modelle, kein API-Key nötig)."""
from __future__ import annotations

import base64

import httpx

from ..base import AIProviderClient, ChatResponse, Message, ModelInfo


class OllamaAdapter(AIProviderClient):
    name = "ollama"

    def __init__(self, base_url: str, api_key: str = "", extras: dict | None = None) -> None:
        self.base_url = (base_url or "http://localhost:11434").rstrip("/")

    async def chat(self, messages, *, model, temperature=0.2, max_tokens=None) -> ChatResponse:
        body = {
            "model": model,
            "stream": False,
            "options": {"temperature": temperature},
            "messages": [{"role": m.role, "content": m.content} for m in messages],
        }
        if max_tokens:
            body["options"]["num_predict"] = max_tokens
        async with httpx.AsyncClient(timeout=300) as c:
            r = await c.post(f"{self.base_url}/api/chat", json=body)
            r.raise_for_status()
            data = r.json()
        return ChatResponse(text=data["message"]["content"], raw=data)

    async def embed(self, texts, *, model) -> list[list[float]]:
        async with httpx.AsyncClient(timeout=300) as c:
            r = await c.post(f"{self.base_url}/api/embed", json={"model": model, "input": texts})
            r.raise_for_status()
            return r.json()["embeddings"]

    async def vision(self, image_b64, mime, prompt, *, model) -> str:
        body = {
            "model": model,
            "stream": False,
            "messages": [{"role": "user", "content": prompt, "images": [image_b64]}],
        }
        async with httpx.AsyncClient(timeout=300) as c:
            r = await c.post(f"{self.base_url}/api/chat", json=body)
            r.raise_for_status()
            return r.json()["message"]["content"]

    async def healthcheck(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                r = await c.get(f"{self.base_url}/api/tags")
                return r.status_code == 200
        except Exception:
            return False

    async def list_models(self) -> list[ModelInfo]:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"{self.base_url}/api/tags")
            r.raise_for_status()
            data = r.json()
        out: list[ModelInfo] = []
        for m in data.get("models", []):
            mid = m.get("name") or m.get("model")
            if not mid:
                continue
            details = m.get("details") or {}
            families = {f.lower() for f in (details.get("families") or [])}
            family = (details.get("family") or "").lower()
            families.add(family)
            low = mid.lower()
            caps: list[str] = []
            embed_markers = {"bert", "nomic-bert", "jina-bert"}
            if (embed_markers & families) or "embed" in low or "bge-" in low or "e5-" in low:
                caps.append("embed")
                out.append(ModelInfo(id=mid, capabilities=tuple(caps)))
                continue
            caps.append("chat")
            vision_families = {"clip", "mllama", "llava", "minicpmv", "qwen2vl"}
            vision_markers = ("llava", "vision", "-vl", "minicpm-v", "moondream", "bakllava", "gemma3", "qwen2-vl", "qwen2.5-vl", "pixtral")
            if (vision_families & families) or any(m in low for m in vision_markers):
                caps.append("vision")
            out.append(ModelInfo(id=mid, capabilities=tuple(caps)))
        out.sort(key=lambda m: m.id)
        return out
