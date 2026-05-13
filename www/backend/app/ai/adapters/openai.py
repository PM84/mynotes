"""OpenAI-Adapter (deckt OpenAI, Azure-OpenAI mit base_url, vLLM, LM Studio, Mistral, Groq, Together ab)."""
from __future__ import annotations

import httpx

from ..base import AIProviderClient, ChatResponse, Message, ModelInfo


class OpenAIAdapter(AIProviderClient):
    name = "openai"

    def __init__(self, base_url: str, api_key: str, extras: dict | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.extras = extras or {}

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    async def chat(self, messages, *, model, temperature=0.2, max_tokens=None) -> ChatResponse:
        body: dict = {
            "model": model,
            "temperature": temperature,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
        }
        if max_tokens:
            body["max_tokens"] = max_tokens
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(f"{self.base_url}/chat/completions", json=body, headers=self._headers())
            # GPT-5 / o1 / o3 reasoning-Modelle laufen nur auf der Responses-API.
            # Bei 404 (model_not_found) automatisch dorthin ausweichen.
            if r.status_code == 404 and _is_responses_only(model):
                return await self._chat_via_responses(messages, model=model, max_tokens=max_tokens)
            r.raise_for_status()
            data = r.json()
        return ChatResponse(text=data["choices"][0]["message"]["content"], raw=data)

    async def _chat_via_responses(
        self, messages, *, model: str, max_tokens: int | None = None
    ) -> ChatResponse:
        """OpenAI Responses-API (/v1/responses) für Reasoning-Modelle."""
        body: dict = {
            "model": model,
            "input": [
                {
                    "role": m.role,
                    "content": [{"type": "input_text", "text": m.content}],
                }
                for m in messages
            ],
        }
        if max_tokens:
            body["max_output_tokens"] = max_tokens
        async with httpx.AsyncClient(timeout=180) as c:
            r = await c.post(f"{self.base_url}/responses", json=body, headers=self._headers())
            r.raise_for_status()
            data = r.json()
        return ChatResponse(text=_extract_responses_text(data), raw=data)

    async def embed(self, texts, *, model) -> list[list[float]]:
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(
                f"{self.base_url}/embeddings",
                json={"model": model, "input": texts},
                headers=self._headers(),
            )
            r.raise_for_status()
            data = r.json()
        return [d["embedding"] for d in data["data"]]

    async def vision(self, image_b64, mime, prompt, *, model) -> str:
        body = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{image_b64}", "detail": "high"}},
                    ],
                }
            ],
        }
        async with httpx.AsyncClient(timeout=180) as c:
            r = await c.post(f"{self.base_url}/chat/completions", json=body, headers=self._headers())
            if r.status_code == 404 and _is_responses_only(model):
                return await self._vision_via_responses(image_b64, mime, prompt, model=model)
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]

    async def _vision_via_responses(self, image_b64, mime, prompt, *, model) -> str:
        body = {
            "model": model,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        {"type": "input_image", "image_url": f"data:{mime};base64,{image_b64}"},
                    ],
                }
            ],
        }
        async with httpx.AsyncClient(timeout=240) as c:
            r = await c.post(f"{self.base_url}/responses", json=body, headers=self._headers())
            r.raise_for_status()
            return _extract_responses_text(r.json())

    async def healthcheck(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.get(f"{self.base_url}/models", headers=self._headers())
                return r.status_code < 500
        except Exception:
            return False

    async def list_models(self) -> list[ModelInfo]:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(f"{self.base_url}/models", headers=self._headers())
            r.raise_for_status()
            data = r.json()
        ids = [d.get("id", "") for d in data.get("data", []) if d.get("id")]
        return [ModelInfo(id=mid, capabilities=_classify_openai(mid)) for mid in sorted(ids)]


def _is_responses_only(model: str) -> bool:
    """Modelle, die ausschließlich über die Responses-API erreichbar sind.

    Ab GPT-5 / o-Serie hat OpenAI auf `/v1/responses` umgestellt; klassische
    Chat-Completions liefern dort 404 ``model_not_found``.
    """
    s = model.lower()
    return s.startswith(("gpt-5", "o1", "o3", "o4"))


def _extract_responses_text(data: dict) -> str:
    """Pflückt den Text aus einer Responses-API-Antwort.

    Bevorzugt ``output_text`` (Convenience-Feld), fällt sonst auf das
    strukturierte ``output[*].content[*].text`` zurück.
    """
    txt = data.get("output_text")
    if isinstance(txt, str) and txt:
        return txt
    parts: list[str] = []
    for item in data.get("output", []) or []:
        for c in item.get("content", []) or []:
            t = c.get("text")
            if isinstance(t, str):
                parts.append(t)
    return "".join(parts)


def _classify_openai(mid: str) -> tuple[str, ...]:
    """Heuristik für OpenAI-/kompatible-Modelle anhand des Namens."""
    s = mid.lower()
    caps: list[str] = []
    if "embed" in s or s.startswith("text-embedding") or "bge-" in s or "e5-" in s or "nomic-embed" in s:
        caps.append("embed")
        return tuple(caps)
    # Vision: OpenAI 4o/4-turbo, Llava, Qwen-VL, Pixtral, MiniCPM-V, Gemma-3 (multimodal)
    vision_markers = ("gpt-4o", "gpt-4.1", "gpt-5", "o1", "o3", "vision", "vl", "llava", "pixtral", "minicpm-v", "gemma-3", "qwen2-vl", "qwen2.5-vl")
    if any(m in s for m in vision_markers):
        caps.append("vision")
    # Audio/TTS aussortieren
    if any(m in s for m in ("whisper", "tts", "audio", "dall-e", "image-")):
        return tuple(caps) if caps else ()
    caps.append("chat")
    return tuple(caps)
