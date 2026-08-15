import json
import socket
import tempfile
import time
import unittest
from pathlib import Path
from urllib.request import urlopen

from codex_agent.dashboard import DashboardServer
from codex_agent.diagnostics import AgentDiagnostics, JsonFormatter


class DashboardTests(unittest.TestCase):
    def test_status_dashboard_is_loopback_and_reports_events(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "agent.jsonl"
            path.write_text('{"message":"ready"}\n', encoding="utf-8")
            diagnostics = AgentDiagnostics(
                device_id="codex-test", server="https://example.test", workspace=Path(directory)
            )
            diagnostics.update(socket_connected=True, registered=True, app_server="running")
            diagnostics.record("command.received", run_id="run-1")
            port = _free_port()
            dashboard = DashboardServer("127.0.0.1", port, diagnostics, path)
            dashboard.start()
            try:
                with urlopen(f"http://127.0.0.1:{port}/api/status", timeout=3) as response:
                    status = json.load(response)
                self.assertTrue(status["registered"])
                self.assertEqual(status["events"][-1]["kind"], "command.received")
                with urlopen(f"http://127.0.0.1:{port}/api/logs", timeout=3) as response:
                    logs = json.load(response)
                self.assertEqual(logs["items"][0]["message"], "ready")
            finally:
                dashboard.close()

    def test_json_formatter_redacts_secret_values(self) -> None:
        import logging

        record = logging.LogRecord(
            "test", logging.INFO, "", 0, "token=%s", ("secret",), None
        )
        value = json.loads(JsonFormatter().format(record))
        self.assertNotIn("secret", value["message"])


def _free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


if __name__ == "__main__":
    unittest.main()
