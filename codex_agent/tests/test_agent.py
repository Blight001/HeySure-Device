from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path

from codex_agent.agent import CodexAgent
from codex_agent.config import Config
from codex_agent.state import StateStore
from codex_agent.worktree import WorktreeInfo
from codex_agent.worktree import WorktreeError


class FakeSocket:
    def __init__(self) -> None:
        self.connected = True
        self.handlers = {}
        self.emitted: list[tuple[str, dict]] = []
        self.callbacks = []

    def event(self, function):
        self.handlers[function.__name__] = function
        return function

    def on(self, event):
        def decorate(function):
            self.handlers[event] = function
            return function
        return decorate

    def emit(self, event, data, callback=None):
        self.emitted.append((event, data))
        self.callbacks.append(callback)

    def start_background_task(self, target, *args):
        return None

    def sleep(self, _seconds):
        return None

    def connect(self, _url, **_kwargs):
        return None

    def disconnect(self):
        self.connected = False

    def wait(self):
        return None


class FakeApp:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict]] = []
        self.responses: list[tuple[int | str, dict]] = []
        self.alive = True

    def request(self, method, params, timeout=30):
        self.requests.append((method, params))
        if method == "thread/start":
            return {"thread": {"id": "thread-1"}}
        if method == "turn/start":
            return {"turn": {"id": "turn-1"}}
        if method == "turn/steer":
            return {"turnId": "turn-1"}
        return {}

    def respond(self, request_id, result):
        self.responses.append((request_id, result))

    def start(self):
        self.alive = True

    def close(self):
        self.alive = False

    def is_alive(self):
        return self.alive


class BlockingApp(FakeApp):
    def __init__(self) -> None:
        super().__init__()
        self.thread_start_entered = threading.Event()
        self.release_thread_start = threading.Event()

    def request(self, method, params, timeout=30):
        if method == "thread/start":
            self.requests.append((method, params))
            self.thread_start_entered.set()
            self.release_thread_start.wait(2)
            return {"thread": {"id": "thread-1"}}
        return super().request(method, params, timeout)


class FakeWorktrees:
    def __init__(self, workspace: Path, warning: str | None = None) -> None:
        self.workspace = workspace
        self.warning = warning

    def prepare(self, _run_id, _task_id, existing=None):
        return WorktreeInfo(self.workspace, "codex/maintenance/test", "abc123", self.warning)


class FailingWorktrees:
    def prepare(self, *_args, **_kwargs):
        raise WorktreeError("not a git repository")


def config(path: Path) -> Config:
    return Config(
        server="http://server",
        account="account",
        password="password",
        workspace=path,
        state_dir=path / "state",
        codex_command=("codex",),
        device_id="codex-test",
    )


class AgentTests(unittest.TestCase):
    def build(self, path: Path):
        socket = FakeSocket()
        app = FakeApp()
        agent = CodexAgent(
            config(path),
            socket=socket,
            store=StateStore(path / "state"),
            app_server=app,
            worktrees=FakeWorktrees(path),
        )
        agent.registered = True
        return agent, socket, app

    def test_registers_as_custom_codex_maintainer(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, _ = self.build(Path(directory))
            agent.token = "secret-token"
            agent.register()
            payload = socket.emitted[-1][1]
            self.assertEqual(payload["platform"], "codex-maintainer")
            self.assertEqual(payload["deviceType"], "custom")
            self.assertEqual(payload["id"], "codex-test")

    def test_start_steer_interrupt_and_persist_mapping(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, app = self.build(Path(directory))
            agent.start_run({"runId": "run-1", "prompt": "Fix tests"})
            run = agent.store.get_run("run-1")
            self.assertEqual((run["threadId"], run["turnId"]), ("thread-1", "turn-1"))
            agent.steer({"runId": "run-1", "text": "Focus on unit tests"})
            agent.interrupt({"runId": "run-1"})
            self.assertEqual([call[0] for call in app.requests][-2:], ["turn/steer", "turn/interrupt"])
            started = [payload for event, payload in socket.emitted if event == "codex:run_started"]
            self.assertEqual(started[0]["sequence"], 1)
            self.assertEqual(started[0]["payload"]["threadId"], "thread-1")
            self.assertEqual(started[0]["workspace"], str(Path(directory)))
            self.assertEqual(started[0]["branch"], "codex/maintenance/test")
            self.assertEqual(started[0]["baseSha"], "abc123")
            thread_params = app.requests[0][1]
            turn_params = app.requests[1][1]
            self.assertNotIn("sandboxPolicy", thread_params)
            self.assertEqual(thread_params["sandbox"], "workspace-write")
            self.assertEqual(turn_params["sandboxPolicy"]["writableRoots"], [str(Path(directory))])

    def test_inbound_sandbox_cannot_expand_writable_roots(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, _, app = self.build(Path(directory))
            agent.start_run(
                {
                    "runId": "run-1",
                    "prompt": "Fix tests",
                    "sandboxPolicy": {
                        "type": "workspaceWrite",
                        "writableRoots": ["C:\\"],
                        "networkAccess": True,
                    },
                }
            )
            policy = app.requests[1][1]["sandboxPolicy"]
            self.assertEqual(policy["writableRoots"], [str(Path(directory))])
            self.assertTrue(policy["networkAccess"])

    def test_legacy_approval_policy_is_normalized_for_current_app_server(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, _, app = self.build(Path(directory))
            agent.start_run(
                {"runId": "run-1", "prompt": "Inspect", "approvalPolicy": "unlessTrusted"}
            )
            self.assertEqual(app.requests[0][1]["approvalPolicy"], "untrusted")
            self.assertEqual(app.requests[1][1]["approvalPolicy"], "untrusted")

    def test_unknown_approval_policy_is_rejected_locally(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, _, _ = self.build(Path(directory))
            with self.assertRaisesRegex(ValueError, "unsupported approval policy"):
                agent.start_run(
                    {"runId": "run-1", "prompt": "Inspect", "approvalPolicy": "alwaysAllow"}
                )

    def test_read_only_thread_sandbox_uses_current_wire_enum(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, _, app = self.build(Path(directory))
            agent.start_run(
                {"runId": "run-1", "prompt": "Inspect", "sandboxPolicy": {"type": "readOnly"}}
            )
            self.assertEqual(app.requests[0][1]["sandbox"], "read-only")

    def test_controller_can_use_current_workspace_with_full_access(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            agent, _, app = self.build(path)
            agent.start_run({
                "runId": "run-1", "prompt": "Fix", "workspaceMode": "current",
                "sandboxPolicy": {"type": "dangerFullAccess"},
            })
            self.assertEqual(app.requests[0][1]["cwd"], str(path))
            self.assertEqual(app.requests[0][1]["sandbox"], "danger-full-access")
            self.assertEqual(app.requests[1][1]["sandboxPolicy"], {"type": "dangerFullAccess"})

    def test_existing_run_resumes_its_thread(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, _, app = self.build(Path(directory))
            agent.store.update_run("run-1", threadId="thread-old", status="completed")
            agent.start_run({"runId": "run-1", "prompt": "Continue"})
            self.assertEqual(app.requests[0], ("thread/resume", {"threadId": "thread-old"}))

    def test_reconnect_commands_are_consumed_in_receive_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            socket = FakeSocket()
            app = BlockingApp()
            agent = CodexAgent(
                config(path),
                socket=socket,
                store=StateStore(path / "state"),
                app_server=app,
                worktrees=FakeWorktrees(path),
            )
            agent.registered = True
            worker = threading.Thread(target=agent._command_loop)
            worker.start()
            socket.handlers["codex:run_start"](
                {"commandId": "start", "runId": "run-1", "prompt": "Fix"}
            )
            self.assertTrue(app.thread_start_entered.wait(1))
            socket.handlers["codex:steer"](
                {"commandId": "steer", "runId": "run-1", "text": "Tests first"}
            )
            time.sleep(0.05)
            self.assertNotIn("turn/steer", [method for method, _ in app.requests])
            app.release_thread_start.set()
            deadline = time.time() + 2
            while "turn/steer" not in [method for method, _ in app.requests] and time.time() < deadline:
                time.sleep(0.01)
            agent.stopping.set()
            worker.join(1)
            methods = [method for method, _ in app.requests]
            self.assertLess(methods.index("turn/start"), methods.index("turn/steer"))

    def test_late_interrupt_is_idempotent_for_unknown_or_terminal_run(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, _, app = self.build(Path(directory))
            agent.interrupt({"runId": "missing"})
            self.assertEqual(agent.store.get_run("missing")["status"], "cancelled")
            agent.store.update_run(
                "finished", threadId="thread-1", turnId="turn-1", status="succeeded"
            )
            agent.interrupt({"runId": "finished"})
            self.assertNotIn("turn/interrupt", [method for method, _ in app.requests])

    def test_interrupt_without_active_turn_cancels_but_steer_still_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, _, app = self.build(Path(directory))
            agent.store.update_run("run-1", status="preparing")
            agent.interrupt({"runId": "run-1"})
            self.assertEqual(agent.store.get_run("run-1")["status"], "cancelled")
            self.assertEqual(app.requests, [])
            with self.assertRaisesRegex(ValueError, "not active"):
                agent.steer({"runId": "run-2", "text": "continue"})

    def test_submodule_warning_is_in_prompt_and_public_event(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            agent, socket, app = self.build(path)
            agent.worktrees = FakeWorktrees(path, "local submodule object missing")
            agent.start_run({"runId": "run-1", "prompt": "Fix"})
            turn_prompt = app.requests[1][1]["input"][0]["text"]
            self.assertIn("local submodule object missing", turn_prompt)
            warning = [payload for event, payload in socket.emitted if event == "codex:event"]
            self.assertEqual(warning[0]["type"], "worktree/submoduleWarning")

    def test_outbox_is_replayed_with_same_event_id(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, _ = self.build(Path(directory))
            agent.registered = False
            agent._emit_run("codex:event", "run-1", {"type": "warning", "data": {}})
            self.assertEqual(socket.emitted, [])
            agent.registered = True
            agent._flush_outbox()
            first = socket.emitted[0][1]
            agent._flush_outbox()
            self.assertEqual(socket.emitted[1][1]["eventId"], first["eventId"])

    def test_successful_socket_ack_removes_outbox_item(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, _ = self.build(Path(directory))
            agent._emit_run("codex:event", "run-1", {"type": "warning", "data": {}})
            self.assertEqual(len(agent.store.outbox()), 1)
            socket.callbacks[-1]({"ok": True})
            self.assertEqual(agent.store.outbox(), [])

    def test_terminal_server_rejection_does_not_poison_replay_queue(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, _ = self.build(Path(directory))
            agent.store.update_run("run-1", status="failed")
            agent._emit_run("codex:approval_requested", "run-1", {"approvalId": "old"})
            self.assertEqual(len(agent.store.outbox()), 1)
            socket.callbacks[-1]({"ok": False, "error_code": "STATE_CONFLICT"})
            self.assertEqual(agent.store.outbox(), [])

    def test_public_summary_is_forwarded_but_raw_reasoning_is_dropped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, _ = self.build(Path(directory))
            agent.store.update_run("run-1", threadId="thread-1", turnId="turn-1", status="running")
            agent._on_app_message(
                {"method": "item/reasoning/textDelta", "params": {"threadId": "thread-1", "delta": "hidden"}}
            )
            agent._on_app_message(
                {"method": "item/reasoning/summaryTextDelta", "params": {"threadId": "thread-1", "delta": "public"}}
            )
            events = [payload for event, payload in socket.emitted if event == "codex:event"]
            self.assertEqual(len(events), 1)
            self.assertIn("public", str(events[0]))
            self.assertEqual(events[0]["payload"]["type"], "item/reasoning/summaryTextDelta")
            self.assertNotIn("hidden", str(socket.emitted))

    def test_approval_stays_pending_until_server_decision(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, app = self.build(Path(directory))
            agent.store.update_run("run-1", threadId="thread-1", turnId="turn-1", status="running")
            agent._on_app_message(
                {
                    "id": 42,
                    "method": "item/commandExecution/requestApproval",
                    "params": {"threadId": "thread-1", "turnId": "turn-1", "command": "pytest"},
                }
            )
            request = [payload for event, payload in socket.emitted if event == "codex:approval_requested"][0]
            self.assertEqual(request["approvalType"], "item/commandExecution/requestApproval")
            self.assertEqual(request["detail"]["command"], "pytest")
            self.assertEqual(app.responses, [])
            agent.approval_decision({"approvalId": request["approvalId"], "decision": "accept"})
            self.assertEqual(app.responses, [(42, {"decision": "accept"})])

    def test_server_approved_status_maps_to_app_server_accept(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, app = self.build(Path(directory))
            agent.store.update_run("run-1", threadId="thread-1", turnId="turn-1", status="running")
            agent._on_app_message(
                {
                    "id": 43,
                    "method": "item/commandExecution/requestApproval",
                    "params": {"threadId": "thread-1", "turnId": "turn-1"},
                }
            )
            request = [payload for event, payload in socket.emitted if event == "codex:approval_requested"][0]
            agent.approval_decision({"approvalId": request["approvalId"], "decision": "approved"})
            self.assertEqual(app.responses, [(43, {"decision": "accept"})])

    def test_server_denied_status_maps_to_app_server_decline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, app = self.build(Path(directory))
            agent.store.update_run("run-1", threadId="thread-1", turnId="turn-1", status="running")
            agent._on_app_message(
                {
                    "id": 44,
                    "method": "item/fileChange/requestApproval",
                    "params": {"threadId": "thread-1", "turnId": "turn-1"},
                }
            )
            request = [payload for event, payload in socket.emitted if event == "codex:approval_requested"][0]
            agent.approval_decision({"approvalId": request["approvalId"], "decision": "denied"})
            self.assertEqual(app.responses, [(44, {"decision": "decline"})])

    def test_mcp_elicitation_uses_action_content_protocol(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, app = self.build(Path(directory))
            agent.store.update_run("run-1", threadId="thread-1", turnId="turn-1", status="running")
            agent._on_app_message({
                "id": 45, "method": "mcpServer/elicitation/request",
                "params": {"threadId": "thread-1", "mode": "form", "serverName": "custom",
                           "requestedSchema": {"type": "object", "properties": {}}},
            })
            request = [payload for event, payload in socket.emitted if event == "codex:approval_requested"][0]
            agent.approval_decision({"approvalId": request["approvalId"], "decision": "approved"})
            self.assertEqual(app.responses, [(45, {"action": "accept", "content": {}})])

    def test_controller_auto_accepts_empty_trusted_mcp_gate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, app = self.build(Path(directory))
            agent.store.update_run(
                "run-1", threadId="thread-1", turnId="turn-1", status="running",
                trustedMcpServers=["baota"],
            )
            agent._on_app_message({
                "id": 46, "method": "mcpServer/elicitation/request",
                "params": {"threadId": "thread-1", "mode": "form", "serverName": "baota",
                           "requestedSchema": {"type": "object", "properties": {}}},
            })
            self.assertEqual(app.responses, [(46, {"action": "accept", "content": {}})])
            self.assertFalse(any(event == "codex:approval_requested" for event, _ in socket.emitted))
            public = [payload for event, payload in socket.emitted if event == "codex:event"]
            self.assertEqual(public[0]["type"], "approval/autoAccepted")

    def test_stale_approval_after_restart_is_consumed_with_public_warning(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, app = self.build(Path(directory))
            agent.store.update_run("run-1", status="recovering")
            agent.store.put_approval(
                "approval-old", {"runId": "run-1", "method": "item/fileChange/requestApproval"}
            )
            agent.approval_decision({"approvalId": "approval-old", "decision": "approved"})
            self.assertEqual(app.responses, [])
            event = [payload for name, payload in socket.emitted if name == "codex:event"][0]
            self.assertEqual(event["type"], "approval/staleAfterRestart")
            self.assertIsNone(agent.store.pop_approval("approval-old"))

    def test_completely_unknown_approval_still_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, _, _ = self.build(Path(directory))
            with self.assertRaisesRegex(RuntimeError, "unknown approval"):
                agent.approval_decision({"approvalId": "never-seen", "decision": "approved"})

    def test_turn_completion_and_app_exit_are_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, _ = self.build(Path(directory))
            agent.store.update_run("run-1", threadId="thread-1", turnId="turn-1", status="running")
            agent._on_app_message(
                {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"}}}
            )
            self.assertEqual(agent.store.get_run("run-1")["status"], "succeeded")
            agent.store.update_run("run-1", status="running")
            agent._on_app_message({"method": "app-server/exited", "params": {"returnCode": 1}})
            self.assertEqual(agent.store.get_run("run-1")["status"], "recovering")
            self.assertTrue(any(event == "codex:run_completed" for event, _ in socket.emitted))

    def test_unscoped_current_app_server_notifications_use_only_active_run(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, _ = self.build(Path(directory))
            agent.store.update_run("run-1", threadId="thread-1", status="starting")
            agent._on_app_message(
                {"method": "item/completed", "params": {"item": {"id": "item-1", "type": "agentMessage", "text": "Done"}}}
            )
            agent._on_app_message(
                {"method": "turn/completed", "params": {"turn": {"id": "turn-1", "status": "completed"}}}
            )
            events = [event for event, _ in socket.emitted]
            self.assertIn("codex:event", events)
            self.assertIn("codex:run_completed", events)
            self.assertEqual(agent.store.get_run("run-1")["status"], "succeeded")

    def test_unscoped_notification_is_dropped_when_active_run_is_ambiguous(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, _ = self.build(Path(directory))
            agent.store.update_run("run-1", status="running")
            agent.store.update_run("run-2", status="running")
            agent._on_app_message(
                {"method": "item/completed", "params": {"item": {"id": "item-1", "type": "agentMessage", "text": "Done"}}}
            )
            self.assertEqual(socket.emitted, [])

    def test_worktree_failure_fails_run_without_starting_codex(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, app = self.build(Path(directory))
            agent.worktrees = FailingWorktrees()
            with self.assertRaisesRegex(WorktreeError, "not a git repository"):
                agent.start_run({"runId": "run-1", "prompt": "Fix"})
            self.assertEqual(app.requests, [])
            self.assertEqual(agent.store.get_run("run-1")["status"], "failed")
            completed = [payload for event, payload in socket.emitted if event == "codex:run_completed"]
            self.assertEqual(completed[0]["rawStatus"], "setupFailed")

    def test_completion_status_and_payload_match_server_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, _ = self.build(Path(directory))
            agent.store.update_run("run-1", threadId="thread-1", turnId="turn-1", status="running")
            agent._on_app_message(
                {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "interrupted"}}}
            )
            complete = [payload for event, payload in socket.emitted if event == "codex:run_completed"][0]
            self.assertEqual(complete["status"], "cancelled")
            self.assertEqual(complete["rawStatus"], "interrupted")
            self.assertEqual(complete["payload"]["status"], "cancelled")

    def test_command_ack_does_not_consume_device_event_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, _ = self.build(Path(directory))
            agent._execute_command("codex:interrupt", {"commandId": "cmd-1", "runId": "run-1"}, lambda _: None)
            ack = [payload for event, payload in socket.emitted if event == "codex:command_ack"][0]
            self.assertEqual(ack["runId"], "run-1")
            self.assertNotIn("sequence", ack)
            self.assertNotIn("error", ack)

            agent._emit_run("codex:event", "run-1", {"type": "warning", "data": {}})
            event = [payload for name, payload in socket.emitted if name == "codex:event"][0]
            self.assertEqual(event["sequence"], 1)

    def test_missing_command_id_uses_stable_run_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, _ = self.build(Path(directory))
            agent._execute_command("codex:run_start", {"runId": "run-1"}, lambda _: None)
            ack = [payload for event, payload in socket.emitted if event == "codex:command_ack"][0]
            self.assertEqual(ack["commandId"], "run_start:run-1")

    def test_final_agent_message_is_returned_as_run_summary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent, socket, _ = self.build(Path(directory))
            agent.store.update_run(
                "run-1", threadId="thread-1", turnId="turn-1", status="running"
            )
            agent._on_app_message({
                "method": "item/completed",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "item": {"type": "agentMessage", "phase": "final_answer", "text": "完成了"},
                },
            })
            agent._on_app_message({
                "method": "turn/completed",
                "params": {
                    "threadId": "thread-1",
                    "turn": {"id": "turn-1", "status": "completed"},
                },
            })
            completed = [
                payload for event, payload in socket.emitted if event == "codex:run_completed"
            ][0]
            self.assertEqual(completed["summary"], "完成了")


if __name__ == "__main__":
    unittest.main()
