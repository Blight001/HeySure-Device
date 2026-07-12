"""MCP 转换层：接收 task:dispatch → 路由到工具 → 恰好回一次 result/error（read.md 8）。

硬规则：每个 taskId 必须恰好回一次 task:result 或 task:error（含未知工具）。
工具在后台线程执行，避免长任务阻塞 socket 心跳与 rt:* 事件循环。
"""

from __future__ import annotations

import logging
from typing import Any, Dict

from .tools import Registry, UnknownToolError

logger = logging.getLogger("heysure.dispatch")


class TaskDispatcher:
    def __init__(self, sio, registry: Registry, device_id: str) -> None:
        self._sio = sio
        self._registry = registry
        self._device_id = device_id

    def on_dispatch(self, task: Dict[str, Any]) -> None:
        """收到 task:dispatch：丢到后台线程执行，主循环立即返回。"""
        self._sio.start_background_task(self._run, task if isinstance(task, dict) else {})

    def _run(self, task: Dict[str, Any]) -> None:
        task_id = task.get("taskId")
        tool = str(task.get("tool") or "")
        args = task.get("args") if isinstance(task.get("args"), dict) else {}
        if not task_id:
            logger.warning("task without taskId, ignored: tool=%s", tool)
            return
        try:
            result, summary = self._registry.dispatch(tool, args)
            self._sio.emit("task:result", {
                "taskId": task_id,
                "deviceId": self._device_id,
                "success": True,
                "tool": tool,
                "result": result,
                "summary": summary,
            })
            logger.info("task ok id=%s tool=%s", task_id, tool)
        except UnknownToolError:
            self._emit_error(task_id, f"unknown tool: {tool}")
        except Exception as exc:  # 任何工具异常都要回一次 error，绝不静默
            logger.exception("task failed id=%s tool=%s", task_id, tool)
            self._emit_error(task_id, f"{type(exc).__name__}: {exc}")

    def _emit_error(self, task_id: Any, message: str) -> None:
        self._sio.emit("task:error", {
            "taskId": task_id,
            "deviceId": self._device_id,
            "error": message,
        })
