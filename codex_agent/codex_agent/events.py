from __future__ import annotations

from typing import Any

from .redaction import sanitize

ALLOWED_NOTIFICATIONS = {
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "item/plan/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/commandExecution/outputDelta",
    "turn/diff/updated",
    "turn/plan/updated",
    "turn/started",
    "warning",
    "configWarning",
    "error",
}
APPROVAL_METHODS = {
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "mcpServer/elicitation/request",
    "item/tool/requestUserInput",
    "tool/requestUserInput",
}


def public_event(method: str, params: dict[str, Any]) -> dict[str, Any] | None:
    if method == "item/reasoning/textDelta":
        return None
    if method not in ALLOWED_NOTIFICATIONS:
        return None
    payload = params
    if method in {"item/started", "item/completed"}:
        payload = _public_item(params)
    return {"type": method, "data": sanitize(payload)}


def _public_item(params: dict[str, Any]) -> dict[str, Any]:
    item = params.get("item")
    if not isinstance(item, dict) or item.get("type") != "reasoning":
        return params
    cleaned = dict(params)
    cleaned["item"] = {
        "id": item.get("id"),
        "type": "reasoning",
        "summary": sanitize(item.get("summary", [])),
    }
    return cleaned


def thread_id(params: dict[str, Any]) -> str | None:
    direct = params.get("threadId")
    if direct:
        return str(direct)
    thread = params.get("thread")
    return str(thread.get("id")) if isinstance(thread, dict) and thread.get("id") else None


def turn_id(params: dict[str, Any]) -> str | None:
    direct = params.get("turnId")
    if direct:
        return str(direct)
    turn = params.get("turn")
    return str(turn.get("id")) if isinstance(turn, dict) and turn.get("id") else None
