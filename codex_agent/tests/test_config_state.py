from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codex_agent.config import Config
from codex_agent.state import InstanceLock, StateStore


class ConfigStateTests(unittest.TestCase):
    def test_command_is_parsed_as_argv_and_app_server_suffix_is_owned(self) -> None:
        with patch.dict(
            "os.environ",
            {"CODEX_COMMAND": '"C:\\Program Files\\Codex\\codex.exe" --profile maintainer'},
            clear=False,
        ):
            config = Config.from_env()
        self.assertEqual(config.codex_command[0], "C:\\Program Files\\Codex\\codex.exe")
        self.assertEqual(config.codex_command[-2:], ("--profile", "maintainer"))
        self.assertEqual(config.app_server_argv[-3:], ["app-server", "--listen", "stdio://"])

    def test_command_accepts_explicit_json_argv(self) -> None:
        with patch.dict("os.environ", {"CODEX_COMMAND": '["codex", "--profile", "safe"]'}):
            config = Config.from_env()
        self.assertEqual(config.codex_command, ("codex", "--profile", "safe"))

    def test_state_is_persistent_and_sequence_is_monotonic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            first = StateStore(path)
            device_id = first.device_id(None)
            first.update_run("run-1", threadId="thread-1")
            self.assertEqual(first.next_sequence("run-1"), 1)
            self.assertEqual(first.next_sequence("run-1"), 2)
            second = StateStore(path)
            self.assertEqual(second.device_id(None), device_id)
            self.assertEqual(second.next_sequence("run-1"), 3)
            json.loads((path / "state.json").read_text(encoding="utf-8"))

    def test_single_instance_lock_rejects_second_owner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            with InstanceLock(path):
                with self.assertRaises(RuntimeError):
                    InstanceLock(path).acquire()
            with InstanceLock(path):
                self.assertTrue((path / "agent.lock").exists())

    def test_single_instance_lock_recovers_stale_owner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "agent.lock").write_text("99999999", encoding="ascii")
            with InstanceLock(path):
                self.assertNotEqual((path / "agent.lock").read_text(), "99999999")


if __name__ == "__main__":
    unittest.main()
