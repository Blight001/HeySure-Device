from __future__ import annotations

import logging
import platform
import queue
import threading
import time
import uuid
from typing import Any, Protocol

import requests
import socketio

from . import __version__
from .app_server import AppServer
from .config import Config
from .diagnostics import AgentDiagnostics
from .events import APPROVAL_METHODS, public_event, thread_id, turn_id
from .redaction import sanitize
from .state import StateStore
from .worktree import WorktreeInfo, WorktreeManager

logger = logging.getLogger("heysure.codex.agent")


class Socket(Protocol):
    connected: bool

    def on(self, event: str): ...
    def event(self, function): ...
    def emit(self, event: str, data: dict[str, Any]) -> None: ...
    def connect(self, url: str, **kwargs: Any) -> None: ...
    def disconnect(self) -> None: ...
    def wait(self) -> None: ...
    def sleep(self, seconds: float) -> None: ...
    def start_background_task(self, target, *args: Any): ...


class CodexAgent:
    def __init__(
        self,
        config: Config,
        *,
        socket: Socket | None = None,
        store: StateStore | None = None,
        app_server: AppServer | None = None,
        worktrees: WorktreeManager | None = None,
        http_post=requests.post,
    ) -> None:
        self.config = config
        self.store = store or StateStore(config.state_dir)
        self.device_id = self.store.device_id(config.device_id)
        self.socket = socket or socketio.Client(
            reconnection=True,
            reconnection_delay=2,
            reconnection_delay_max=30,
            logger=False,
            engineio_logger=False,
        )
        self.app = app_server or AppServer(
            config.app_server_argv, str(config.workspace), self._on_app_message
        )
        self.worktrees = worktrees or WorktreeManager(
            config.workspace, config.worktree_root, config.worktree_mode
        )
        self.http_post = http_post
        self.token: str | None = None
        self.socket_url = config.server
        self.registered = False
        self.stopping = threading.Event()
        self.diagnostics = AgentDiagnostics(
            device_id=self.device_id, server=config.server, workspace=config.workspace
        )
        self.diagnostics.runtime_provider(self._runtime_status)
        self._approvals: dict[str, dict[str, Any]] = {}
        self._final_messages: dict[str, str] = {}
        self._command_lock = threading.Lock()
        self._commands: queue.Queue[tuple[str, dict[str, Any], Any]] = queue.Queue()
        self._install_handlers()

    def login(self) -> None:
        response = self.http_post(
            f"{self.config.server}/api/auth/login",
            json={"account": self.config.account, "password": self.config.password},
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
        if not data.get("access_token"):
            raise RuntimeError("login response is missing access_token")
        self.token = str(data["access_token"])
        self.socket_url = str(data.get("agent_socket_url") or self.config.server).rstrip("/")
        self.diagnostics.update(authenticated=True, socket_url=self.socket_url)
        self.diagnostics.record("server.login_succeeded", socket_url=self.socket_url)

    def register(self) -> None:
        self.socket.emit("device:register", self._register_payload())

    def run(self) -> None:
        self.config.validate()
        self.app.start()
        self.diagnostics.update(app_server="running")
        self.diagnostics.record("app_server.started")
        self._login_with_retry()
        self.socket.start_background_task(self._command_loop)
        self.socket.connect(self.socket_url, wait_timeout=15)
        self.socket.start_background_task(self._supervise_app_server)
        self.socket.wait()

    def shutdown(self) -> None:
        self.stopping.set()
        self.diagnostics.record("agent.stopping")
        self.app.close()
        self.diagnostics.update(app_server="stopped")
        if self.socket.connected:
            self.socket.disconnect()

    def _register_payload(self) -> dict[str, Any]:
        return {
            "id": self.device_id,
            "name": self.config.device_name,
            "token": self.token,
            "deviceType": "custom",
            "platform": "codex-maintainer",
            "capabilities": ["codex.app-server", "codex.steer", "codex.approvals"],
            "toolDefs": [],
            "aiDescription": "Independent Codex project controller with auditable progress and approvals",
            "catalogProtocolVersion": 2,
            "version": __version__,
            "lifecycle": "registered",
            "os": {
                "platform": platform.system().lower(),
                "arch": platform.machine(),
                "hostname": self.config.hostname,
            },
        }

    def _install_handlers(self) -> None:
        @self.socket.event
        def connect() -> None:
            self.registered = False
            self.diagnostics.update(socket_connected=True, registered=False)
            self.diagnostics.record("socket.connected")
            self.register()
            self.socket.start_background_task(self._registration_retry)

        @self.socket.event
        def disconnect() -> None:
            self.registered = False
            self.diagnostics.update(socket_connected=False, registered=False)
            self.diagnostics.record("socket.disconnected", level="warning")

        @self.socket.on("device:registered")
        def registered(_: dict[str, Any]) -> None:
            self.registered = True
            self.diagnostics.update(registered=True)
            self.diagnostics.record("device.registered")
            self._flush_outbox()

        @self.socket.on("device:register_rejected")
        def rejected(data: dict[str, Any]) -> None:
            logger.warning("device registration rejected: %s", sanitize(data))
            self.diagnostics.record("device.registration_rejected", level="error")
            self._login_with_retry(attempts=3)
            self.register()

        self._command_handler("codex:run_start", self.start_run)
        self._command_handler("codex:steer", self.steer)
        self._command_handler("codex:interrupt", self.interrupt)
        self._command_handler("codex:approval_decision", self.approval_decision)

    def _command_handler(self, event: str, callback) -> None:
        @self.socket.on(event)
        def handler(data: dict[str, Any]) -> None:
            payload = data if isinstance(data, dict) else {}
            self.diagnostics.update(last_command={
                "event": event, "run_id": payload.get("runId"), "received_at": time.time()
            })
            self.diagnostics.record(
                "command.received", event=event, run_id=payload.get("runId")
            )
            self._commands.put((event, payload, callback))

    def _command_loop(self) -> None:
        while not self.stopping.is_set():
            try:
                event, payload, callback = self._commands.get(timeout=0.25)
            except queue.Empty:
                continue
            try:
                self._execute_command(event, payload, callback)
            finally:
                self._commands.task_done()

    def _execute_command(self, event: str, data: dict[str, Any], callback) -> None:
        run_id = str(data.get("runId")) if data.get("runId") else None
        fallback_id = f"{event.removeprefix('codex:')}:{run_id}" if run_id else str(uuid.uuid4())
        command_id = str(data.get("commandId") or fallback_id)
        try:
            self.diagnostics.record("command.started", event=event, run_id=run_id)
            callback(data)
            self._emit_ack(command_id, event, True, run_id=run_id)
            self.diagnostics.record("command.accepted", event=event, run_id=run_id)
        except Exception as exc:
            logger.exception("command failed: %s", event)
            self.diagnostics.record(
                "command.failed", level="error", event=event, run_id=run_id, error=str(exc)
            )
            self._emit_ack(command_id, event, False, str(exc), run_id=run_id)

    def start_run(self, data: dict[str, Any]) -> None:
        run_id = _required(data, "runId")
        prompt = _required(data, "prompt")
        try:
            with self._command_lock:
                run = self.store.get_run(run_id)
                workspace_mode = str(data.get("workspaceMode") or "worktree")
                if workspace_mode not in {"worktree", "current"}:
                    raise ValueError(f"unsupported workspace mode: {workspace_mode}")
                worktree = (
                    WorktreeInfo(self.config.workspace, None, None)
                    if workspace_mode == "current"
                    else self.worktrees.prepare(
                        run_id, str(data.get("taskId") or run_id), existing=run
                    )
                )
                self._store_worktree(run_id, worktree)
                self.store.update_run(
                    run_id,
                    workspaceMode=workspace_mode,
                    trustedMcpServers=_trusted_mcp_servers(data.get("trustedMcpServers")),
                )
                run = self.store.get_run(run_id)
                thread = self._start_or_resume_thread(run, data, worktree.workspace)
                self.store.update_run(run_id, threadId=thread, status="starting")
                turn_prompt = _prompt_with_warning(prompt, worktree.warning)
                params = self._turn_params(thread, turn_prompt, data, worktree.workspace)
                result = self.app.request("turn/start", params, timeout=60)
                turn = str((result.get("turn") or {}).get("id") or "")
                if not turn:
                    raise RuntimeError("turn/start response is missing turn.id")
                self.store.update_run(run_id, turnId=turn, status="running")
            if worktree.warning:
                self._emit_run(
                    "codex:event",
                    run_id,
                    {"type": "worktree/submoduleWarning", "data": {"message": worktree.warning}},
                )
            started = {
                "threadId": thread,
                "turnId": turn,
                "workspace": str(worktree.workspace),
                "branch": worktree.branch,
                "baseSha": worktree.base_sha,
            }
            self._emit_run("codex:run_started", run_id, started)
        except Exception as exc:
            self.store.update_run(run_id, status="failed")
            self._emit_run(
                "codex:run_completed",
                run_id,
                {"status": "failed", "rawStatus": "setupFailed", "error": str(exc)},
            )
            raise

    def _start_or_resume_thread(
        self, run: dict[str, Any] | None, data: dict[str, Any], workspace: Any
    ) -> str:
        if run and run.get("threadId"):
            thread = str(run["threadId"])
            self.app.request("thread/resume", {"threadId": thread}, timeout=30)
            return thread
        params = self._thread_params(data, workspace)
        result = self.app.request("thread/start", params, timeout=60)
        thread = str((result.get("thread") or {}).get("id") or "")
        if not thread:
            raise RuntimeError("thread/start response is missing thread.id")
        return thread

    def steer(self, data: dict[str, Any]) -> None:
        run_id = _required(data, "runId")
        text = _required(data, "text")
        run = self._active_run(run_id)
        self.app.request(
            "turn/steer",
            {
                "threadId": run["threadId"],
                "expectedTurnId": run["turnId"],
                "input": [{"type": "text", "text": text}],
            },
        )

    def interrupt(self, data: dict[str, Any]) -> None:
        run_id = _required(data, "runId")
        run = self.store.get_run(run_id)
        if not run or run.get("status") in {"succeeded", "failed", "cancelled"}:
            if not run:
                self.store.update_run(run_id, status="cancelled")
            return
        if not run.get("threadId") or not run.get("turnId"):
            self.store.update_run(run_id, status="cancelled")
            return
        self.app.request(
            "turn/interrupt", {"threadId": run["threadId"], "turnId": run["turnId"]}
        )

    def approval_decision(self, data: dict[str, Any]) -> None:
        approval_id = _required(data, "approvalId")
        pending = self._approvals.pop(approval_id, None)
        persisted = self.store.pop_approval(approval_id)
        if not pending:
            if persisted:
                run_id = str(persisted.get("runId") or data.get("runId") or "")
                if run_id:
                    self._emit_run(
                        "codex:event",
                        run_id,
                        {
                            "type": "approval/staleAfterRestart",
                            "data": {"approvalId": approval_id, "method": persisted.get("method")},
                        },
                    )
                return
            raise RuntimeError(f"unknown approval: {approval_id}")
        result = _approval_result(pending["method"], data, pending.get("params"))
        self.app.respond(pending["rpcId"], result)

    def _on_app_message(self, message: dict[str, Any]) -> None:
        method = str(message.get("method") or "")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        if message.get("id") is not None and method in APPROVAL_METHODS:
            self._request_approval(message["id"], method, params)
            return
        if message.get("id") is not None and method:
            logger.warning(
                "unsupported app-server request: method=%s param_keys=%s",
                method,
                sorted(params),
            )
            return
        if method == "app-server/exited":
            self._handle_app_exit(params)
            return
        run_id = self._find_run(params)
        if not run_id:
            return
        if method == "turn/completed":
            self._complete_run(run_id, params)
            return
        event = public_event(method, params)
        if event:
            self._capture_final_message(run_id, method, params)
            self.diagnostics.record("app_server.event", method=method, run_id=run_id)
            self._emit_run("codex:event", run_id, event)

    def _request_approval(self, rpc_id: int | str, method: str, params: dict[str, Any]) -> None:
        run_id = self._find_run(params)
        if not run_id:
            self.app.respond(rpc_id, {"decision": "cancel"})
            return
        run = self.store.get_run(run_id) or {}
        if _auto_accept_mcp_elicitation(method, params, run):
            self.app.respond(rpc_id, {"action": "accept", "content": {}})
            self.diagnostics.record(
                "approval.auto_accepted", method=method, run_id=run_id,
                server_name=params.get("serverName"),
            )
            self._emit_run(
                "codex:event", run_id,
                {"type": "approval/autoAccepted", "data": {
                    "method": method, "serverName": params.get("serverName"),
                }},
            )
            return
        approval_id = str(uuid.uuid4())
        pending = {"rpcId": rpc_id, "method": method, "runId": run_id, "params": params}
        self._approvals[approval_id] = pending
        self.store.put_approval(approval_id, {"method": method, "runId": run_id})
        detail = sanitize(params)
        payload = {
            "approvalId": approval_id,
            "approvalType": method,
            "title": str(params.get("reason") or method),
            "detail": detail,
            "method": method,
            "request": detail,
        }
        self._emit_run("codex:approval_requested", run_id, payload)

    def _complete_run(self, run_id: str, params: dict[str, Any]) -> None:
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        raw_status = str(turn.get("status") or "failed")
        status = {"completed": "succeeded", "interrupted": "cancelled"}.get(
            raw_status, "failed"
        )
        self.store.update_run(run_id, status=status)
        payload = {"status": status, "rawStatus": raw_status, "turn": sanitize(turn)}
        summary = self._final_messages.pop(run_id, "").strip()
        if summary:
            payload["summary"] = summary[:100_000]
        self.diagnostics.record("run.completed", run_id=run_id, status=status)
        self._emit_run("codex:run_completed", run_id, payload)

    def _handle_app_exit(self, params: dict[str, Any]) -> None:
        for run_id, run in self.store.runs().items():
            if run.get("status") in {"starting", "running"}:
                self.store.update_run(run_id, status="recovering")
                self._emit_run(
                    "codex:event", run_id, {"type": "app-server/exited", "data": sanitize(params)}
                )

    def _find_run(self, params: dict[str, Any]) -> str | None:
        message_thread, message_turn = thread_id(params), turn_id(params)
        runs = self.store.runs()
        for run_id, run in runs.items():
            if message_thread and run.get("threadId") == message_thread:
                return run_id
            if message_turn and run.get("turnId") == message_turn:
                return run_id
        # Current App Server item notifications, and even turn/completed, do
        # not always carry threadId. A turn notification can also race the
        # turn/start response that persists turnId. Attribute it only when
        # there is exactly one possible active maintenance run; never guess
        # across concurrent work orders.
        active = [
            run_id
            for run_id, run in runs.items()
            if run.get("status") in {"starting", "running", "recovering"}
        ]
        if len(active) == 1:
            return active[0]
        return None

    def _active_run(self, run_id: str) -> dict[str, Any]:
        run = self.store.get_run(run_id)
        if not run or not run.get("threadId") or not run.get("turnId"):
            raise ValueError(f"run is not active: {run_id}")
        return run

    def _thread_params(self, data: dict[str, Any], workspace: Any) -> dict[str, Any]:
        policy = self._sandbox_policy(data, workspace)
        params: dict[str, Any] = {
            "cwd": str(workspace),
            "approvalPolicy": _approval_policy(data.get("approvalPolicy")),
            "sandbox": _thread_sandbox_mode(policy["type"]),
        }
        for key in ("model",):
            if key in data:
                params[key] = data[key]
        return params

    def _turn_params(
        self, thread: str, prompt: str, data: dict[str, Any], workspace: Any
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "threadId": thread,
            "input": [{"type": "text", "text": prompt}],
            "cwd": str(workspace),
            "approvalPolicy": _approval_policy(data.get("approvalPolicy")),
            "sandboxPolicy": self._sandbox_policy(data, workspace),
        }
        for key in ("model", "effort", "summary"):
            if key in data:
                params[key] = data[key]
        return params

    def _sandbox_policy(self, data: dict[str, Any], workspace: Any = None) -> dict[str, Any]:
        requested = data.get("sandboxPolicy")
        requested = requested if isinstance(requested, dict) else {}
        kind = requested.get("type", "workspaceWrite")
        safe_workspace = str(workspace or self.config.workspace)
        if kind == "workspaceWrite":
            return {
                "type": "workspaceWrite",
                "writableRoots": [safe_workspace],
                "networkAccess": bool(requested.get("networkAccess", False)),
            }
        if kind == "readOnly":
            return {
                "type": "readOnly",
                "access": {
                    "type": "restricted",
                    "includePlatformDefaults": True,
                    "readableRoots": [safe_workspace],
                },
            }
        if kind == "dangerFullAccess":
            return {"type": "dangerFullAccess"}
        raise ValueError(f"unsupported sandboxPolicy.type: {kind}")

    def _store_worktree(self, run_id: str, worktree: WorktreeInfo) -> None:
        self.store.update_run(
            run_id,
            workspace=str(worktree.workspace),
            branch=worktree.branch,
            baseSha=worktree.base_sha,
            status="preparing",
        )

    def _emit_run(self, event: str, run_id: str, data: dict[str, Any]) -> None:
        sequence = self.store.next_sequence(run_id)
        public_data = sanitize(data, drop_raw_reasoning=False)
        payload = {
            "deviceId": self.device_id,
            "runId": run_id,
            "sequence": sequence,
            "eventId": str(uuid.uuid4()),
            "payload": public_data,
            **public_data,
        }
        self._emit_reliable(event, payload)

    def _emit_ack(
        self,
        command_id: str,
        command: str,
        success: bool,
        error: str | None = None,
        *,
        run_id: str | None = None,
    ) -> None:
        payload = {
            "deviceId": self.device_id,
            "commandId": command_id,
            "command": command,
            "success": success,
            "eventId": str(uuid.uuid4()),
        }
        if error:
            payload["error"] = sanitize(error)
        if run_id:
            payload["runId"] = run_id
        self._emit_reliable("codex:command_ack", payload)

    def _emit_reliable(self, event: str, payload: dict[str, Any]) -> None:
        self.store.append_outbox(event, payload)
        if self.registered:
            self._send_outbox_item(event, payload)

    def _flush_outbox(self) -> None:
        for item in self.store.outbox():
            self._send_outbox_item(item["event"], item["payload"])

    def _send_outbox_item(self, event: str, payload: dict[str, Any]) -> None:
        if event == "codex:command_ack" and payload.get("error") is None:
            payload = {key: value for key, value in payload.items() if key != "error"}
        event_id = str(payload.get("eventId") or "")

        def acknowledged(*args: object) -> None:
            response = args[0] if args else None
            if event_id and isinstance(response, dict) and response.get("ok") is True:
                self.store.acknowledge_outbox(event_id)
                return
            error_code = response.get("error_code") if isinstance(response, dict) else "NO_RESPONSE"
            run_id = str(payload.get("runId") or "")
            run = self.store.get_run(run_id) if run_id else None
            if (
                event_id
                and error_code in {"RUN_NOT_FOUND", "STATE_CONFLICT"}
                and run
                and run.get("status") in {"succeeded", "failed", "cancelled"}
            ):
                self.store.acknowledge_outbox(event_id)
                self.diagnostics.record(
                    "outbox.terminal_rejection_dropped", event=event,
                    run_id=run_id, error_code=error_code,
                )
                return
            logger.warning("reliable event was not acknowledged: event=%s error_code=%s", event, error_code)

        self.socket.emit(event, payload, callback=acknowledged)

    def _registration_retry(self) -> None:
        while self.socket.connected and not self.registered and not self.stopping.is_set():
            self.socket.sleep(3)
            if self.socket.connected and not self.registered:
                self.register()

    def _supervise_app_server(self) -> None:
        delay = 1
        while not self.stopping.is_set():
            if not self.app.is_alive():
                try:
                    self.app.start()
                    self.diagnostics.update(app_server="running")
                    self.diagnostics.record("app_server.restarted")
                    delay = 1
                except Exception as exc:
                    logger.error("Codex app-server restart failed: %s", exc)
                    self.diagnostics.update(app_server="error")
                    self.diagnostics.record(
                        "app_server.restart_failed", level="error", error=str(exc)
                    )
                    delay = min(delay * 2, 30)
            self.stopping.wait(delay)

    def _login_with_retry(self, attempts: int = 30) -> None:
        delay = 2
        for attempt in range(1, attempts + 1):
            try:
                self.login()
                return
            except Exception as exc:
                logger.warning("login failed (%d/%d): %s", attempt, attempts, exc)
                if attempt < attempts:
                    time.sleep(delay)
                    delay = min(delay * 2, 30)
        raise RuntimeError("HeySure login failed; check server URL, account and network")

    def _capture_final_message(
        self, run_id: str, method: str, params: dict[str, Any]
    ) -> None:
        if method != "item/completed":
            return
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        if item.get("type") != "agentMessage" or item.get("phase") != "final_answer":
            return
        text = str(item.get("text") or "").strip()
        if text:
            self._final_messages[run_id] = text[:100_000]

    def _runtime_status(self) -> dict[str, Any]:
        return {
            "runs": self.store.runs(),
            "outbox_count": len(self.store.outbox()),
            "command_queue": self._commands.qsize(),
            "pending_approvals": len(self._approvals),
        }


def _required(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value


def _approval_policy(value: object) -> str:
    """Normalize legacy App Server policy spellings to the current wire enum."""
    raw = str(value or "on-request").strip()
    aliases = {
        "unlessTrusted": "untrusted",
        "onRequest": "on-request",
        "onFailure": "on-request",
    }
    normalized = aliases.get(raw, raw)
    if normalized not in {"untrusted", "on-request", "granular", "never"}:
        raise ValueError(f"unsupported approval policy: {raw}")
    return normalized


def _thread_sandbox_mode(value: object) -> str:
    aliases = {
        "workspaceWrite": "workspace-write",
        "readOnly": "read-only",
        "dangerFullAccess": "danger-full-access",
    }
    normalized = aliases.get(str(value), str(value))
    if normalized not in {"workspace-write", "read-only", "danger-full-access"}:
        raise ValueError(f"unsupported thread sandbox mode: {value}")
    return normalized


def _approval_result(
    method: str, data: dict[str, Any], params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    explicit = data.get("result")
    if isinstance(explicit, dict):
        return explicit
    decision = str(data.get("decision") or "")
    if method in {"item/commandExecution/requestApproval", "item/fileChange/requestApproval"}:
        decision = {"approved": "accept", "denied": "decline"}.get(decision, decision)
        allowed = {"accept", "acceptForSession", "decline", "cancel"}
        if decision not in allowed:
            raise ValueError(f"invalid approval decision: {decision}")
        return {"decision": decision}
    if method == "mcpServer/elicitation/request":
        if decision in {"approved", "accept", "acceptForSession"}:
            content = data.get("content")
            return {"action": "accept", "content": content if isinstance(content, dict) else {}}
        if decision in {"denied", "decline"}:
            return {"action": "decline", "content": None}
        return {"action": "cancel", "content": None}
    raise ValueError(f"{method} requires an explicit result object")


def _trusted_mcp_servers(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted({str(item).strip() for item in value if str(item).strip()})[:20]


def _auto_accept_mcp_elicitation(
    method: str, params: dict[str, Any], run: dict[str, Any],
) -> bool:
    if method != "mcpServer/elicitation/request":
        return False
    if str(params.get("mode") or "") not in {"form", "openai/form"}:
        return False
    server = str(params.get("serverName") or "")
    if server not in set(_trusted_mcp_servers(run.get("trustedMcpServers"))):
        return False
    schema = params.get("requestedSchema")
    if not isinstance(schema, dict):
        return False
    return not schema.get("required")


def _prompt_with_warning(prompt: str, warning: str | None) -> str:
    if not warning:
        return prompt
    return f"[HeySure worktree warning: {warning}]\nDo not modify the original submodule workspaces.\n\n{prompt}"
