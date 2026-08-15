from __future__ import annotations

import re
from typing import Any

_SECRET_KEY = re.compile(r"(token|password|secret|cookie|authorization|api[_-]?key)", re.I)
_BEARER = re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+")
_ASSIGNMENT = re.compile(
    r"(?i)\b(token|password|secret|api[_-]?key)\b\s*[:=]\s*([^\s,;]+)"
)
MAX_TEXT = 64 * 1024


def redact_text(value: str) -> str:
    value = _BEARER.sub("Bearer [REDACTED]", value)
    value = _ASSIGNMENT.sub(lambda match: f"{match.group(1)}=[REDACTED]", value)
    if len(value) > MAX_TEXT:
        return value[:MAX_TEXT] + "\n[TRUNCATED]"
    return value


def sanitize(value: Any, *, drop_raw_reasoning: bool = True) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [sanitize(item, drop_raw_reasoning=drop_raw_reasoning) for item in value]
    if not isinstance(value, dict):
        return value
    cleaned: dict[str, Any] = {}
    for key, item in value.items():
        if _SECRET_KEY.search(str(key)):
            cleaned[key] = "[REDACTED]"
        elif drop_raw_reasoning and key in {"content", "rawReasoning", "encryptedContent"}:
            continue
        else:
            cleaned[key] = sanitize(item, drop_raw_reasoning=drop_raw_reasoning)
    return cleaned

