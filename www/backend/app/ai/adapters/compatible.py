"""Generischer OpenAI-kompatibler Adapter (Alias auf OpenAIAdapter)."""
from .openai import OpenAIAdapter


class CompatibleAdapter(OpenAIAdapter):
    name = "compatible"
