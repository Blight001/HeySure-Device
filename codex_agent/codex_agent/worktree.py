from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


@dataclass(frozen=True)
class WorktreeInfo:
    workspace: Path
    branch: str | None
    base_sha: str | None
    warning: str | None = None


class WorktreeError(RuntimeError):
    pass


class WorktreeManager:
    def __init__(
        self,
        workspace: Path,
        root: Path | None = None,
        mode: str = "on",
        runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    ) -> None:
        self.workspace = workspace.resolve()
        self.root = root.resolve() if root else None
        self.mode = mode
        self.runner = runner

    def prepare(
        self, run_id: str, task_id: str, existing: dict[str, Any] | None = None
    ) -> WorktreeInfo:
        if self.mode == "off":
            return self._unmanaged_info()
        repo = self._repo_root(self.workspace)
        relative = self.workspace.relative_to(repo)
        if existing and existing.get("workspace"):
            return self._recover(existing, relative)
        base_sha = self._git(repo, "rev-parse", "HEAD")
        safe_id = safe_task_id(task_id or run_id)
        branch = f"codex/maintenance/{safe_id}"
        root = self.root or repo.parent / ".heysure-codex-worktrees" / repo.name
        try:
            root.relative_to(repo)
        except ValueError:
            pass
        else:
            raise WorktreeError(f"managed worktree root must be outside the main repository: {root}")
        worktree = root / safe_id
        if worktree.exists():
            raise WorktreeError(f"unmanaged worktree path already exists: {worktree}")
        root.mkdir(parents=True, exist_ok=True)
        self._git(repo, "worktree", "add", "-b", branch, str(worktree), base_sha)
        warning = self._initialize_submodules(worktree)
        return WorktreeInfo(worktree / relative, branch, base_sha, warning)

    def _unmanaged_info(self) -> WorktreeInfo:
        try:
            repo = self._repo_root(self.workspace)
            branch = self._git(repo, "branch", "--show-current") or None
            base_sha = self._git(repo, "rev-parse", "HEAD")
        except WorktreeError:
            branch, base_sha = None, None
        return WorktreeInfo(self.workspace, branch, base_sha)

    def _recover(self, existing: dict[str, Any], relative: Path) -> WorktreeInfo:
        workspace = Path(str(existing["workspace"])).resolve()
        if not workspace.is_dir():
            raise WorktreeError(f"persisted run worktree is missing: {workspace}")
        repo = self._repo_root(workspace)
        if repo == self._repo_root(self.workspace):
            raise WorktreeError("persisted run workspace points to the main checkout, not a worktree")
        expected_root = workspace
        if relative != Path("."):
            expected_root = workspace.parents[len(relative.parts) - 1]
        if repo != expected_root:
            raise WorktreeError(f"persisted workspace is not its recorded worktree: {workspace}")
        branch = self._git(repo, "branch", "--show-current") or None
        recorded_branch = existing.get("branch")
        if recorded_branch and branch != recorded_branch:
            raise WorktreeError(
                f"persisted worktree branch changed: expected {recorded_branch}, got {branch}"
            )
        return WorktreeInfo(
            workspace,
            str(recorded_branch or branch) if recorded_branch or branch else None,
            str(existing.get("baseSha")) if existing.get("baseSha") else None,
        )

    def _repo_root(self, path: Path) -> Path:
        try:
            root = Path(self._git(path, "rev-parse", "--show-toplevel")).resolve()
            path.relative_to(root)
            return root
        except (ValueError, WorktreeError) as exc:
            raise WorktreeError(f"workspace is not inside a Git repository: {path}") from exc

    def _initialize_submodules(self, worktree: Path) -> str | None:
        modules = worktree / ".gitmodules"
        if not modules.is_file():
            return None
        result = self._run(
            worktree, "submodule", "update", "--init", "--recursive", "--no-fetch", check=False
        )
        if result.returncode == 0:
            return None
        detail = (result.stderr or result.stdout or "local submodule objects unavailable").strip()
        return f"Submodules could not be initialized from local Git data only: {detail[:1000]}"

    def _git(self, cwd: Path, *arguments: str) -> str:
        result = self._run(cwd, *arguments, check=False)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "unknown Git error").strip()
            raise WorktreeError(f"git {' '.join(arguments[:3])} failed: {detail[:1000]}")
        return result.stdout.strip()

    def _run(
        self, cwd: Path, *arguments: str, check: bool
    ) -> subprocess.CompletedProcess[str]:
        try:
            return self.runner(
                ["git", "-C", str(cwd), *arguments],
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                check=check,
            )
        except OSError as exc:
            raise WorktreeError(f"cannot execute Git: {exc}") from exc


def safe_task_id(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip(".-").lower()
    if not safe:
        raise WorktreeError("task id cannot be converted to a safe Git branch segment")
    return safe[:80]
