"""Per-model pricing for cost estimation. USD per 1M tokens.

Update when Azure / OpenAI change rates. Local models are free.
"""

# Rates as of 2026 — best-effort. Update when actual prices change.
PRICING = {
    # Azure OpenAI
    "gpt-5-mini":      {"input": 0.15,  "output": 0.60},
    "gpt-5":           {"input": 1.25,  "output": 10.00},
    "gpt-4o-mini":     {"input": 0.15,  "output": 0.60},
    "gpt-4o":          {"input": 2.50,  "output": 10.00},
    "gpt-4-turbo":     {"input": 10.00, "output": 30.00},
    "gpt-3.5-turbo":   {"input": 0.50,  "output": 1.50},
    # Local models — free
}


def estimate_cost(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    """Returns USD cost. Returns 0.0 for unknown models and local models."""
    p = PRICING.get(model)
    if not p:
        return 0.0
    inp = (prompt_tokens / 1_000_000) * p["input"]
    out = (completion_tokens / 1_000_000) * p["output"]
    return round(inp + out, 6)


def is_priced(model: str) -> bool:
    return model in PRICING
