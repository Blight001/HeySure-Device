"""命令行远程（rt:*）：真人在网页控制台驱动本机交互式 shell（read.md 9.2）。

不是 AI 工具，也不进任务队列——是独立数据面。字节流经 Socket.IO relay（无需 TURN）：

    server → device   rt:open  {sessionId, shell?, cols?, rows?, cwd?}
    device → server   rt:data  {sessionId, data(base64)}   PTY 输出
                      rt:exit  {sessionId, code}           shell 退出
                      rt:error {sessionId, code, message}
    server → device   rt:input {sessionId, data(base64)}   写入 PTY
                      rt:resize{sessionId, cols, rows}
                      rt:close {sessionId}                 关闭

data 一律是 PTY 原始字节的 base64，让 ANSI/光标序列原样穿过 JSON。
以 agent 进程自身权限起 shell；socket 断线时杀掉全部 PTY。
"""

from __future__ import annotations

import base64
import fcntl
import logging
import os
import pty
import select
import signal
import struct
import termios
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger("heysure.rt")

# 同时最多开的终端会话数，防滥用。
_MAX_SESSIONS = 8
_READ_CHUNK = 65536


@dataclass
class PtySession:
    session_id: str
    pid: int
    master_fd: int
    closed: threading.Event
    finished: bool = False


class TerminalManager:
    """管理多路 PTY 会话，按 sessionId 路由。线程安全。"""

    def __init__(self, sio, default_shell: str = "") -> None:
        self._sio = sio
        self._default_shell = default_shell
        self._sessions: Dict[str, PtySession] = {}
        self._lock = threading.Lock()

    # ---- 事件入口（由 connection 的 socket handler 转发） --------------------

    def on_open(self, data: Dict[str, Any]) -> None:
        session_id = str(data.get("sessionId") or "").strip()
        if not session_id:
            return
        with self._lock:
            if session_id in self._sessions:
                return  # 幂等
            if len(self._sessions) >= _MAX_SESSIONS:
                self._emit("rt:error", {"sessionId": session_id, "code": "too_many",
                                        "message": f"终端会话数已达上限 {_MAX_SESSIONS}"})
                return
        shell = self._resolve_shell(data.get("shell"))
        cols = _as_int(data.get("cols"), 80)
        rows = _as_int(data.get("rows"), 24)
        cwd = str(data.get("cwd") or "").strip() or None
        try:
            pid, master_fd = self._spawn(shell, cols, rows, cwd)
        except Exception as exc:  # 起 PTY 失败：如实回报，不静默
            logger.exception("rt open failed session=%s", session_id)
            self._emit("rt:error", {"sessionId": session_id, "code": "spawn_failed", "message": str(exc)})
            return
        session = PtySession(session_id=session_id, pid=pid, master_fd=master_fd, closed=threading.Event())
        with self._lock:
            self._sessions[session_id] = session
        logger.info("rt open session=%s shell=%s %dx%d pid=%s", session_id, shell, cols, rows, pid)
        self._sio.start_background_task(self._reader_loop, session)

    def on_input(self, data: Dict[str, Any]) -> None:
        session = self._get(data.get("sessionId"))
        if not session:
            return
        try:
            raw = base64.b64decode(str(data.get("data") or ""), validate=False)
        except Exception:
            return
        try:
            os.write(session.master_fd, raw)
        except OSError:
            self._finish(session)

    def on_resize(self, data: Dict[str, Any]) -> None:
        session = self._get(data.get("sessionId"))
        if not session:
            return
        self._set_winsize(session.master_fd, _as_int(data.get("cols"), 80), _as_int(data.get("rows"), 24))

    def on_close(self, data: Dict[str, Any]) -> None:
        session = self._get(data.get("sessionId"))
        if session:
            session.closed.set()
            self._finish(session)

    def close_all(self) -> None:
        for session in list(self._sessions.values()):
            session.closed.set()
            self._finish(session, emit_exit=False)

    # ---- 内部实现 -----------------------------------------------------------

    def _resolve_shell(self, requested: Any) -> str:
        candidate = str(requested or "").strip() or self._default_shell or os.environ.get("SHELL", "")
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
        for fallback in ("/bin/bash", "/usr/bin/bash", "/bin/sh"):
            if os.path.isfile(fallback):
                return fallback
        return "/bin/sh"

    def _spawn(self, shell: str, cols: int, rows: int, cwd: Optional[str]):
        env = dict(os.environ)
        env.setdefault("TERM", "xterm-256color")
        env["HEYSURE_REMOTE_TERMINAL"] = "1"
        pid, master_fd = pty.fork()
        if pid == 0:
            # 子进程：pty.fork 已把 slave 设为控制终端并接到 0/1/2。尽量少做事后立即 exec。
            try:
                if cwd and os.path.isdir(cwd):
                    os.chdir(cwd)
            except Exception:
                pass
            try:
                os.execvpe(shell, [shell], env)
            except Exception:
                os._exit(127)
        self._set_winsize(master_fd, cols, rows)
        return pid, master_fd

    @staticmethod
    def _set_winsize(fd: int, cols: int, rows: int) -> None:
        try:
            winsize = struct.pack("HHHH", max(1, rows), max(1, cols), 0, 0)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
        except OSError:
            pass

    def _reader_loop(self, session: PtySession) -> None:
        fd = session.master_fd
        while not session.closed.is_set():
            try:
                readable, _, _ = select.select([fd], [], [], 0.25)
            except (OSError, ValueError):
                break
            if fd not in readable:
                continue
            try:
                chunk = os.read(fd, _READ_CHUNK)
            except OSError:
                chunk = b""
            if not chunk:
                break  # EOF：shell 已退出
            self._emit("rt:data", {"sessionId": session.session_id,
                                   "data": base64.b64encode(chunk).decode("ascii")})
        self._finish(session)

    def _finish(self, session: PtySession, emit_exit: bool = True) -> None:
        with self._lock:
            if session.finished:
                return
            session.finished = True
            self._sessions.pop(session.session_id, None)
        # 若进程仍在（多为 rt:close 主动关闭），杀掉整个进程组。
        try:
            os.killpg(os.getpgid(session.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        code: Optional[int] = None
        try:
            _, status = os.waitpid(session.pid, 0)
            if os.WIFEXITED(status):
                code = os.WEXITSTATUS(status)
            elif os.WIFSIGNALED(status):
                code = -os.WTERMSIG(status)
        except (ChildProcessError, OSError):
            pass
        try:
            os.close(session.master_fd)
        except OSError:
            pass
        logger.info("rt end session=%s code=%s", session.session_id, code)
        if emit_exit:
            self._emit("rt:exit", {"sessionId": session.session_id, "code": code})

    def _get(self, session_id: Any) -> Optional[PtySession]:
        return self._sessions.get(str(session_id or "").strip())

    def _emit(self, event: str, payload: Dict[str, Any]) -> None:
        try:
            self._sio.emit(event, payload)
        except Exception:
            logger.debug("rt emit failed event=%s", event, exc_info=True)


def _as_int(value: Any, default: int) -> int:
    try:
        result = int(value)
        return result if result > 0 else default
    except (TypeError, ValueError):
        return default
