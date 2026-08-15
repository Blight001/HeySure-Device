from __future__ import annotations

import json
import logging
import queue
import subprocess
import threading
from collections.abc import Callable
from typing import Any, Protocol

logger = logging.getLogger("heysure.codex.app_server")


class Process(Protocol):
    stdin: Any
    stdout: Any
    stderr: Any

    def poll(self) -> int | None: ...
    def terminate(self) -> None: ...
    def wait(self, timeout: float | None = None) -> int: ...
    def kill(self) -> None: ...


class RpcError(RuntimeError):
    pass


class AppServer:
    def __init__(
        self,
        argv: list[str],
        cwd: str,
        on_message: Callable[[dict[str, Any]], None],
        process_factory: Callable[..., Process] = subprocess.Popen,
    ) -> None:
        self.argv = argv
        self.cwd = cwd
        self.on_message = on_message
        self.process_factory = process_factory
        self.process: Process | None = None
        self._pending: dict[int, queue.Queue[dict[str, Any]]] = {}
        self._pending_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._next_id = 0
        self._closing = False

    def start(self) -> None:
        if self.process and self.process.poll() is None:
            return
        self._closing = False
        try:
            self.process = self.process_factory(
                self.argv,
                cwd=self.cwd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except (OSError, PermissionError) as exc:
            command = self.argv[0] if self.argv else "codex"
            raise RuntimeError(
                f"cannot start Codex command {command!r}: {exc}. "
                "Set CODEX_COMMAND to an executable available to this service account."
            ) from exc
        process = self.process
        threading.Thread(
            target=self._read_stdout, args=(process,), daemon=True, name="codex-stdout"
        ).start()
        threading.Thread(
            target=self._read_stderr, args=(process,), daemon=True, name="codex-stderr"
        ).start()
        try:
            self.request(
                "initialize",
                {"clientInfo": {"name": "heysure_codex_agent", "title": "HeySure Codex Agent", "version": "0.1.0"}},
                timeout=20,
            )
            self.notify("initialized", {})
        except Exception:
            self.close()
            raise

    def request(self, method: str, params: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
        request_id = self._allocate_id()
        receiver: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[request_id] = receiver
        try:
            self._write({"method": method, "id": request_id, "params": params})
            message = receiver.get(timeout=timeout)
        except queue.Empty as exc:
            raise TimeoutError(f"Codex app-server request timed out: {method}") from exc
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)
        if "error" in message:
            raise RpcError(f"{method}: {message['error']}")
        result = message.get("result")
        return result if isinstance(result, dict) else {}

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self._write({"method": method, "params": params})

    def respond(self, request_id: int | str, result: dict[str, Any]) -> None:
        self._write({"id": request_id, "result": result})

    def is_alive(self) -> bool:
        return bool(self.process and self.process.poll() is None)

    def close(self) -> None:
        self._closing = True
        process = self.process
        if not process or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def _allocate_id(self) -> int:
        with self._pending_lock:
            self._next_id += 1
            return self._next_id

    def _write(self, message: dict[str, Any]) -> None:
        if not self.process or self.process.poll() is not None or not self.process.stdin:
            raise RpcError("Codex app-server is not running")
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._write_lock:
            self.process.stdin.write(line)
            self.process.stdin.flush()

    def _read_stdout(self, process: Process) -> None:
        if not process or not process.stdout:
            return
        for line in process.stdout:
            try:
                message = json.loads(line)
                self._route(message)
            except json.JSONDecodeError:
                logger.warning("ignored non-JSON app-server stdout")
            except Exception:
                logger.exception("failed to handle app-server message")
        if self.process is process:
            self._fail_pending("Codex app-server exited")
        if self.process is process and not self._closing:
            self.on_message({"method": "app-server/exited", "params": {"returnCode": process.poll()}})

    def _read_stderr(self, process: Process) -> None:
        if not process or not process.stderr:
            return
        for line in process.stderr:
            logger.warning("codex: %s", line.rstrip())

    def _route(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        if request_id is not None and "method" not in message:
            with self._pending_lock:
                receiver = self._pending.get(request_id)
            if receiver:
                receiver.put_nowait(message)
                return
        self.on_message(message)

    def _fail_pending(self, reason: str) -> None:
        with self._pending_lock:
            receivers = list(self._pending.values())
        for receiver in receivers:
            try:
                receiver.put_nowait({"error": {"message": reason}})
            except queue.Full:
                pass
