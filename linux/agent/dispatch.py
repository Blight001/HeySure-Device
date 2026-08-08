"""MCP 转换层：接收 task:dispatch → 路由到工具 → 恰好回一次 result/error（read.md 8）。

硬规则：每个 taskId 必须恰好回一次 task:result 或 task:error（含未知工具）。
工具在后台线程执行，避免长任务阻塞 socket 心跳与 rt:* 事件循环。
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Dict, Tuple

from .tools import Registry, UnknownToolError

logger = logging.getLogger("heysure.dispatch")


class TaskDispatcher:
    def __init__(self, sio, registry: Registry, device_id: str) -> None:
        self._sio = sio
        self._registry = registry
        self._device_id = device_id
        # 结果先入内存待发箱，再尝试发送。Socket 短暂断开时不丢已完成任务；
        # 重连注册成功后补发。服务端按 taskId 去重，因此极端竞态下重复发送也是安全的。
        self._pending: Dict[str, Tuple[str, Dict[str, Any]]] = {}
        self._pending_lock = threading.Lock()

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
            self._queue_and_emit("task:result", {
                "taskId": task_id,
                "deviceId": self._device_id,
                "success": True,
                "tool": tool,
                "result": result,
                "summary": summary,
            })
            logger.info("task completed id=%s tool=%s", task_id, tool)
        except UnknownToolError:
            self._emit_error(task_id, f"unknown tool: {tool}")
        except Exception as exc:  # 工具本身异常也必须形成可补发的 task:error
            logger.exception("task execution failed id=%s tool=%s", task_id, tool)
            self._emit_error(task_id, f"{type(exc).__name__}: {exc}")

    def _queue_and_emit(self, event: str, payload: Dict[str, Any]) -> None:
        task_id = str(payload.get("taskId") or "")
        if not task_id:
            return
        with self._pending_lock:
            self._pending[task_id] = (event, payload)
        self._try_emit(task_id, event, payload)

    def _try_emit(self, task_id: str, event: str, payload: Dict[str, Any]) -> bool:
        try:
            if not self._sio.connected:
                raise ConnectionError("socket not connected")
            self._sio.emit(event, payload)
        except Exception as exc:
            logger.warning("task result queued id=%s event=%s: %s", task_id, event, exc)
            return False
        with self._pending_lock:
            current = self._pending.get(task_id)
            if current == (event, payload):
                self._pending.pop(task_id, None)
        logger.info("task result sent id=%s event=%s", task_id, event)
        return True

    def flush_pending(self) -> None:
        """设备重新注册后补发断线期间完成的结果。"""
        with self._pending_lock:
            items = list(self._pending.items())
        if items:
            logger.info("flushing %d queued task result(s)", len(items))
        for task_id, (event, payload) in items:
            self._try_emit(task_id, event, payload)

    def _emit_error(self, task_id: Any, message: str) -> None:
        self._queue_and_emit("task:error", {
            "taskId": task_id,
            "deviceId": self._device_id,
            "error": message,
        })
