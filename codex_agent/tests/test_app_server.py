from __future__ import annotations

import json
import queue
import unittest

from codex_agent.app_server import AppServer


class QueueStream:
    def __init__(self) -> None:
        self.values: queue.Queue[str | None] = queue.Queue()

    def push(self, value: dict) -> None:
        self.values.put(json.dumps(value) + "\n")

    def close(self) -> None:
        self.values.put(None)

    def __iter__(self):
        while True:
            value = self.values.get()
            if value is None:
                return
            yield value


class FakeInput:
    def __init__(self, process: "FakeProcess") -> None:
        self.process = process

    def write(self, line: str) -> None:
        message = json.loads(line)
        self.process.writes.append(message)
        if "id" in message:
            self.process.stdout.push({"id": message["id"], "result": self.process.result(message)})

    def flush(self) -> None:
        return None


class FakeProcess:
    def __init__(self, *_args, **_kwargs) -> None:
        self.stdout = QueueStream()
        self.stderr = QueueStream()
        self.stdin = FakeInput(self)
        self.writes: list[dict] = []
        self.return_code = None

    def result(self, message: dict) -> dict:
        if message["method"] == "initialize":
            return {"userAgent": "fake"}
        return {"echo": message["method"]}

    def poll(self):
        return self.return_code

    def terminate(self) -> None:
        self.return_code = 0
        self.stdout.close()
        self.stderr.close()

    def wait(self, timeout=None) -> int:
        return self.return_code or 0

    def kill(self) -> None:
        self.terminate()


class AppServerTests(unittest.TestCase):
    def test_stdio_handshake_request_and_notification(self) -> None:
        processes: list[FakeProcess] = []

        def factory(*args, **kwargs):
            process = FakeProcess(*args, **kwargs)
            processes.append(process)
            return process

        client = AppServer(["fake-codex", "app-server"], ".", lambda _: None, factory)
        client.start()
        result = client.request("thread/list", {})
        client.close()
        methods = [item.get("method") for item in processes[0].writes]
        self.assertEqual(methods[:2], ["initialize", "initialized"])
        self.assertEqual(result, {"echo": "thread/list"})

    def test_server_initiated_request_reaches_callback(self) -> None:
        received: list[dict] = []
        process = FakeProcess()
        client = AppServer(["fake"], ".", received.append, lambda *_a, **_k: process)
        client.start()
        process.stdout.push(
            {"id": 99, "method": "item/fileChange/requestApproval", "params": {"threadId": "t"}}
        )
        for _ in range(100):
            if received:
                break
            __import__("time").sleep(0.005)
        client.close()
        self.assertEqual(received[0]["id"], 99)

    def test_start_error_mentions_configurable_command(self) -> None:
        def denied(*_args, **_kwargs):
            raise PermissionError("denied")

        client = AppServer(["bad-codex"], ".", lambda _: None, denied)
        with self.assertRaisesRegex(RuntimeError, "CODEX_COMMAND"):
            client.start()


if __name__ == "__main__":
    unittest.main()

