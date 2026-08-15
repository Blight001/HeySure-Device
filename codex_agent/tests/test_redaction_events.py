from __future__ import annotations

import unittest

from codex_agent.events import public_event
from codex_agent.redaction import sanitize


class RedactionEventTests(unittest.TestCase):
    def test_secrets_are_redacted_recursively(self) -> None:
        value = sanitize(
            {
                "authorization": "Bearer abc.def",
                "nested": {"password": "hello", "text": "token=xyz"},
            }
        )
        self.assertEqual(value["authorization"], "[REDACTED]")
        self.assertEqual(value["nested"]["password"], "[REDACTED]")
        self.assertNotIn("xyz", value["nested"]["text"])

    def test_raw_reasoning_delta_is_never_public(self) -> None:
        self.assertIsNone(public_event("item/reasoning/textDelta", {"delta": "private"}))

    def test_reasoning_item_only_keeps_public_summary(self) -> None:
        event = public_event(
            "item/completed",
            {
                "threadId": "thread-1",
                "item": {
                    "type": "reasoning",
                    "id": "item-1",
                    "summary": ["safe summary"],
                    "content": ["hidden reasoning"],
                },
            },
        )
        self.assertEqual(event["data"]["item"]["summary"], ["safe summary"])
        self.assertNotIn("content", event["data"]["item"])

    def test_command_output_and_diff_are_sanitized(self) -> None:
        command = public_event(
            "item/commandExecution/outputDelta",
            {"threadId": "thread-1", "delta": "api_key=top-secret"},
        )
        diff = public_event(
            "turn/diff/updated", {"threadId": "thread-1", "diff": "+password=hunter2"}
        )
        self.assertNotIn("top-secret", str(command))
        self.assertNotIn("hunter2", str(diff))


if __name__ == "__main__":
    unittest.main()

