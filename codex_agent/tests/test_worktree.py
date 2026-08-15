from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from codex_agent.worktree import WorktreeError, WorktreeManager, safe_task_id


class FakeGit:
    def __init__(self, repo: Path, *, submodule_failure: bool = False) -> None:
        self.repo = repo.resolve()
        self.calls: list[tuple[list[str], dict]] = []
        self.submodule_failure = submodule_failure

    def __call__(self, argv, **kwargs):
        self.calls.append((list(argv), dict(kwargs)))
        command = argv[3:]
        cwd = Path(argv[2]).resolve()
        if command == ["rev-parse", "--show-toplevel"]:
            root = cwd if cwd != self.repo else self.repo
            return result(argv, str(root))
        if command == ["rev-parse", "HEAD"]:
            return result(argv, "abc123")
        if command == ["branch", "--show-current"]:
            return result(argv, "codex/maintenance/task-1")
        if command[:3] == ["worktree", "add", "-b"]:
            Path(command[4]).mkdir(parents=True)
            return result(argv, "")
        if command[:3] == ["submodule", "update", "--init"]:
            if self.submodule_failure:
                return result(argv, "", "missing local object", 1)
            return result(argv, "")
        return result(argv, "", "unexpected fake git command", 1)


def result(argv, stdout, stderr="", code=0):
    return subprocess.CompletedProcess(argv, code, stdout=stdout, stderr=stderr)


class WorktreeTests(unittest.TestCase):
    def test_creates_sibling_worktree_with_argv_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            repo = parent / "project"
            repo.mkdir()
            git = FakeGit(repo)
            info = WorktreeManager(repo, runner=git).prepare("run-1", "Task 1")
            self.assertEqual(info.branch, "codex/maintenance/task-1")
            self.assertEqual(info.base_sha, "abc123")
            self.assertEqual(info.workspace, parent / ".heysure-codex-worktrees" / "project" / "task-1")
            add = next(call for call, _ in git.calls if "worktree" in call)
            self.assertEqual(add[:3], ["git", "-C", str(repo)])
            self.assertTrue(all("shell" not in kwargs for _, kwargs in git.calls))

    def test_recovers_persisted_worktree_without_creating_another(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "project"
            worktree = Path(directory) / "managed" / "task-1"
            repo.mkdir()
            worktree.mkdir(parents=True)
            git = FakeGit(repo)
            info = WorktreeManager(repo, runner=git).prepare(
                "run-1",
                "Task 1",
                {"workspace": str(worktree), "branch": "codex/maintenance/task-1", "baseSha": "abc123"},
            )
            self.assertEqual(info.workspace, worktree)
            self.assertFalse(any("worktree" in call for call, _ in git.calls))

    def test_submodule_initialization_is_local_only_and_warning_is_nonfatal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            repo = parent / "project"
            repo.mkdir()
            root = parent / "managed"
            target = root / "task-1"
            git = FakeGit(repo, submodule_failure=True)

            def runner(argv, **kwargs):
                outcome = git(argv, **kwargs)
                if argv[3:6] == ["worktree", "add", "-b"]:
                    (target / ".gitmodules").write_text('[submodule "x"]\npath=x\n', encoding="utf-8")
                return outcome

            info = WorktreeManager(repo, root=root, runner=runner).prepare("run-1", "Task 1")
            self.assertIn("local Git data only", info.warning)
            submodule, kwargs = next(item for item in git.calls if "submodule" in item[0])
            self.assertIn("--no-fetch", submodule)
            self.assertEqual(kwargs["env"]["GIT_ALLOW_PROTOCOL"], "file")
            self.assertEqual(kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")

    def test_non_git_workspace_fails_without_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)

            def failing(argv, **_kwargs):
                return result(argv, "", "not a git repository", 128)

            with self.assertRaisesRegex(WorktreeError, "not inside a Git repository"):
                WorktreeManager(repo, runner=failing).prepare("run-1", "task")

    def test_mode_on_rejects_persisted_main_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            git = FakeGit(repo)
            with self.assertRaisesRegex(WorktreeError, "main checkout"):
                WorktreeManager(repo, runner=git).prepare(
                    "run-1",
                    "task",
                    {"workspace": str(repo), "branch": "codex/maintenance/task-1", "baseSha": "abc"},
                )

    def test_mode_off_explicitly_uses_configured_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)

            def failing(argv, **_kwargs):
                return result(argv, "", "not git", 128)

            info = WorktreeManager(workspace, mode="off", runner=failing).prepare("run", "task")
            self.assertEqual(info.workspace, workspace)
            self.assertIsNone(info.branch)

    def test_managed_root_inside_main_repository_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            git = FakeGit(repo)
            with self.assertRaisesRegex(WorktreeError, "must be outside"):
                WorktreeManager(repo, root=repo / "worktrees", runner=git).prepare("run", "task")

    def test_safe_task_id_rejects_empty_value(self) -> None:
        self.assertEqual(safe_task_id("Ticket 12/A"), "ticket-12-a")
        with self.assertRaises(WorktreeError):
            safe_task_id("///")


if __name__ == "__main__":
    unittest.main()
