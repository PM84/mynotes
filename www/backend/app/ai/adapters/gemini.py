"""Google Gemini-Adapter."""
from __future__ import annotations

import httpx

from ..base import AIProviderClient, ChatResponse, Message, ModelInfo


class GeminiAdapter(AIProviderClient):
    name = "gemini"

    def __init__(self, base_url: str, api_key: str, extras: dict | None = None) -> None:
        self.base_url = (base_url or "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
        self.api_key = api_key

    def _url(self, model: str, op: str) -> str:
        return f"{self.base_url}/models/{model}:{op}?key={self.api_key}"

    @staticmethod
    def _to_contents(messages: list[Message]) -> tuple[str | None, list[dict]]:
        sys = None
        contents = []
        for m in messages:
            if m.role == "system":
                sys = m.content
            else:
                role = "user" if m.role == "user" else "model"
                contents.append({"role": role, "parts": [{"text": m.content}]})
        return sys, contents

    async def chat(self, messages, *, model, temperature=0.2, max_tokens=None) -> ChatResponse:
        sys, contents = self._to_contents(messages)
        body: dict = {"contents": contents, "generationConfig": {"temperature": temperature}}
        if max_tokens:
            body["generationConfig"]["maxOutputTokens"] = max_tokens
        if sys:
            body["systemInstruction"] = {"parts": [{"text": sys}]}
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(self._url(model, "generateContent"), json=body)
            r.raise_for_status()
            data = r.json()
        text = "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"])
        return ChatResponse(text=text, raw=data)

    async def embed(self, texts, *, model) -> list[list[float]]:
        out: list[list[float]] = []
        async with httpx.AsyncClient(timeout=120) as c:
            for t in texts:
                r = await c.post(
                    self._url(model, "embedContent"),
                    json={"content": {"parts": [{"text": t}]}},
                )
                r.raise_for_status()
                out.append(r.json()["embedding"]["values"])
        return out

    async def vision(self, image_b64, mime, prompt, *, model) -> str:
        body = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": prompt},
                        {"inlineData": {"mimeType": mime, "data": image_b64}},
                    ],
                }
            ],
        }
        async with httpx.AsyncClient(timeout=180) as c:
            r = await c.post(self._url(model, "generateContent"), json=body)
            r.raise_for_status()
            data = r.json()
        return "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"])

    async def healthcheck(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.get(f"{self.base_url}/models?key={self.api_key}")
                return r.status_code < 500
        except Exception:
            return False

    async def list_models(self) -> list[ModelInfo]:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(f"{self.base_url}/models?key={self.api_key}")
            r.raise_for_status()
            data = r.json()
        out: list[ModelInfo] = []
        for m in data.get("models", []):
            name = m.get("name", "")
            mid = name.split("/", 1)[1] if name.startswith("models/") else name
            if not mid:
                continue
            methods = set(m.get("supportedGenerationMethods") or [])
            caps: list[str] = []
            if "embedContent" in methods:
                caps.append("embed")
            if "generateContent" in methods:
                caps.append("chat")
                # Multimodal: bei Gemini sind generateContent-Modelle i. d. R. visionsfähig.
                # Reine Text-Embedding-Modelle haben kein generateContent → fliegen oben raus.
                low = mid.lower()
                if "gemini" in low or "vision" in low or "pro" in low or "flash" in low:
                    caps.append("vision")
            if caps:
                out.append(ModelInfo(id=mid, capabilities=tuple(dict.fromkeys(caps))))
        out.sort(key=lambda m: m.id)
        return out
