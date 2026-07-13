"""持久化交互式控制台：console.*（危险，与 shell.exec 同级，默认随 shell_exec 开启）。

shell.exec 是一次性命令：起子进程、跑完、拿全部输出。遇到「安装时问你 y/n 或
让你选镜像」这类交互式提示就卡住——命令不会退出，也拿不到中间输出。

console.* 用 PTY 起一个**常驻** shell 会话，AI 可以：
  - console.open   新建一个控制台（可多开），拿到 sessionId 和初始输出
  - console.send   往会话写入内容（默认自动回车），等输出稳定后返回**这一轮的新增输出**
  - console.read   主动拉取会话「最新输出」（自上次读取以来的新增，可等待）
  - console.list   列出当前所有会话及是否存活
  - console.close  关闭一个会话（杀进程组）

因此「安装 → 被问确认 → 我来选 → 看结果 → 再确认」这种多轮交互得以进行。
以 agent 进程自身权限起 shell；会话常驻，直到显式 close 或 agent 退出。
"""

from __future__ import annotations

import fcntl
import logging
import os
import pty
import re
import select
import signal
import struct
import termios
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .base import Tool, clamp_timeout, obj_schema

logger = logging.getLogger("heysure.console")

# 同时最多常驻的会话数，防滥用/泄漏。
_MAX_SESSIONS = 8
# 已结束的会话保留个数（留着让 AI 读最后输出 / 拿 exitCode），超出的连缓冲一起回收。
_KEEP_FINISHED = 8
_READ_CHUNK = 65536
# 每个会话保留的输出环形缓冲上限（字节）；超出丢弃最旧的。
_BUFFER_CAP = 256 * 1024
# 单次工具返回的解码文本上限（与 shellrun.MAX_OUTPUT_CHARS 对齐）。
_MAX_OUTPUT_CHARS = 60_000

# CSI / OSC / 其它转义序列与裸控制字符（保留 \t \n）。用于把 PTY 原始输出洗成可读文本。
_ANSI_RE = re.compile(
    r"\x1b\[[0-9;?]*[ -/]*[@-~]"       # CSI
    r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC
    r"|\x1b[@-Z\\-_]"                   # 其它两字符转义
    r"|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]"  # 裸控制字符（不含 \t=09 \n=0a）
)

# Ctrl+<字母> 便捷键：control="c" → \x03（中断），"d" → \x04（EOF）等。
_CTRL_KEYS = {chr(c): chr(c - 96) for c in range(ord("a"), ord("z") + 1)}


@dataclass
class ConsoleSession:
    session_id: str
    pid: int
    master_fd: int
    shell: str
    lock: threading.Lock = field(default_factory=threading.Lock)
    closed: threading.Event = field(default_factory=threading.Event)
    buffer: bytearray = field(default_factory=bytearray)
    base: int = 0            # buffer[0] 对应的全局字节偏移（丢弃最旧后 > 0）
    total: int = 0           # 迄今产生的总字节数
    cursor: int = 0          # 上次被 read/send 消费到的全局偏移
    last_activity: float = field(default_factory=time.time)
    finished: bool = False
    exit_code: Optional[int] = None
    started_at: float = field(default_factory=time.time)


class ConsoleManager:
    """管理多路常驻 PTY 会话，按 sessionId 路由。线程安全，不依赖 Socket.IO。"""

    def __init__(self, default_shell: str = "") -> None:
        self._default_shell = default_shell
        self._sessions: Dict[str, ConsoleSession] = {}
        self._lock = threading.Lock()

    # ---- 生命周期 -----------------------------------------------------------

    def open(
        self,
        *,
        shell: Any = None,
        cwd: Optional[str] = None,
        cols: int = 120,
        rows: int = 32,
        max_wait: float = 1.5,
        quiet: float = 0.4,
    ) -> Tuple[ConsoleSession, str]:
        with self._lock:
            alive = [s for s in self._sessions.values() if not s.finished]
            if len(alive) >= _MAX_SESSIONS:
                raise RuntimeError(f"控制台会话数已达上限 {_MAX_SESSIONS}，请先 console.close 释放")
            # 已结束的会话故意留着（AI 还能读它的最后输出、也能拿到明确的 exitCode），
            # 但不能无限攒——只保留最近 _KEEP_FINISHED 个，其余连缓冲一起丢掉。
            dead = sorted((s for s in self._sessions.values() if s.finished), key=lambda s: s.started_at)
            for stale in dead[:max(0, len(dead) - _KEEP_FINISHED)]:
                self._sessions.pop(stale.session_id, None)
        resolved = self._resolve_shell(shell)
        pid, master_fd = self._spawn(resolved, cols, rows, cwd)
        session = ConsoleSession(session_id=uuid.uuid4().hex[:12], pid=pid, master_fd=master_fd, shell=resolved)
        with self._lock:
            self._sessions[session.session_id] = session
        logger.info("console open session=%s shell=%s %dx%d pid=%s", session.session_id, resolved, cols, rows, pid)
        threading.Thread(target=self._reader_loop, args=(session,), daemon=True).start()
        # 收集起始输出（shell 提示符等），让 AI 知道会话就绪。
        return session, self._collect(session, max_wait=max_wait, quiet=quiet)

    def send(
        self,
        session_id: str,
        data: str,
        *,
        enter: bool = True,
        control: str = "",
        max_wait: float = 3.0,
        quiet: float = 0.4,
    ) -> Tuple[ConsoleSession, str]:
        session = self._require(session_id)
        payload = data or ""
        control = (control or "").strip().lower()
        if control:
            key = _CTRL_KEYS.get(control)
            if key is None:
                raise ValueError(f"不支持的 control 键: {control!r}（用单个字母，如 'c'=Ctrl+C）")
            payload = payload + key
        elif enter:
            payload = payload + "\n"
        # 从当前光标开始计新增输出（发送即视为已消费旧输出）。
        with session.lock:
            session.cursor = session.total
        try:
            os.write(session.master_fd, payload.encode("utf-8", "replace"))
        except OSError as exc:
            self._finish(session)
            raise RuntimeError(f"写入会话失败（可能已退出）: {exc}") from exc
        output = self._collect(session, max_wait=max_wait, quiet=quiet)
        return session, output

    def read(
        self,
        session_id: str,
        *,
        max_wait: float = 0.0,
        quiet: float = 0.3,
    ) -> Tuple[ConsoleSession, str]:
        session = self._require(session_id)
        output = self._collect(session, max_wait=max_wait, quiet=quiet)
        return session, output

    def close(self, session_id: str) -> ConsoleSession:
        session = self._require(session_id)
        session.closed.set()
        self._finish(session)
        return session

    def list_sessions(self) -> List[Dict[str, Any]]:
        with self._lock:
            sessions = list(self._sessions.values())
        return [
            {
                "sessionId": s.session_id,
                "shell": s.shell,
                "pid": s.pid,
                "running": not s.finished,
                "exitCode": s.exit_code,
                "pendingBytes": max(0, s.total - s.cursor),
                "ageSeconds": round(time.time() - s.started_at, 1),
            }
            for s in sessions
        ]

    def close_all(self) -> None:
        for session in list(self._sessions.values()):
            session.closed.set()
            self._finish(session)

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
        env["HEYSURE_AI_CONSOLE"] = "1"
        pid, master_fd = pty.fork()
        if pid == 0:
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

    def _reader_loop(self, session: ConsoleSession) -> None:
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
            with session.lock:
                session.buffer.extend(chunk)
                session.total += len(chunk)
                session.last_activity = time.time()
                overflow = len(session.buffer) - _BUFFER_CAP
                if overflow > 0:
                    del session.buffer[:overflow]
                    session.base += overflow
        self._finish(session)

    def _collect(self, session: ConsoleSession, *, max_wait: float, quiet: float) -> str:
        """等到「有新增输出且已静默 quiet 秒」或超过 max_wait，然后取走新增文本。

        这样能在交互式提示（如 [Y/n]）打印完、进程停下等待输入时及时返回，
        不必傻等命令彻底结束。
        """
        start = time.time()
        quiet = max(0.05, quiet)
        while True:
            now = time.time()
            with session.lock:
                unread = session.total - session.cursor
                idle = now - session.last_activity
            if session.finished:
                break
            if unread > 0 and idle >= quiet:
                break
            if now - start >= max_wait:
                break
            time.sleep(0.05)
        return self._drain(session)

    def _drain(self, session: ConsoleSession) -> str:
        """取走 [cursor, total) 的字节并推进 cursor，返回洗净后的可读文本。"""
        with session.lock:
            start = max(session.cursor, session.base)
            raw = bytes(session.buffer[start - session.base:])
            session.cursor = session.total
        text = raw.decode("utf-8", "replace")
        text = _ANSI_RE.sub("", text).replace("\r\n", "\n").replace("\r", "\n")
        if len(text) > _MAX_OUTPUT_CHARS:
            text = text[-_MAX_OUTPUT_CHARS:]
            text = f"…[输出过长，仅显示最后 {_MAX_OUTPUT_CHARS} 字符]\n" + text
        return text

    def _finish(self, session: ConsoleSession) -> None:
        with self._lock:
            if session.finished:
                return
            session.finished = True
        try:
            os.killpg(os.getpgid(session.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        try:
            _, status = os.waitpid(session.pid, 0)
            if os.WIFEXITED(status):
                session.exit_code = os.WEXITSTATUS(status)
            elif os.WIFSIGNALED(status):
                session.exit_code = -os.WTERMSIG(status)
        except (ChildProcessError, OSError):
            pass
        try:
            os.close(session.master_fd)
        except OSError:
            pass
        logger.info("console end session=%s code=%s", session.session_id, session.exit_code)

    def _require(self, session_id: Any) -> ConsoleSession:
        sid = str(session_id or "").strip()
        session = self._sessions.get(sid)
        if session is None:
            raise ValueError(f"会话不存在: {sid!r}（可能已关闭；用 console.list 查看，或 console.open 新建）")
        return session


# 进程内单例：registry 构建一次，工具 handler 与 shutdown 共享同一个 manager。
_MANAGER: Optional[ConsoleManager] = None


def get_manager() -> Optional[ConsoleManager]:
    return _MANAGER


def _as_int(value: Any, default: int) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError):
        return default
    return result if result > 0 else default


def _status(session: ConsoleSession, output: str) -> Dict[str, Any]:
    return {
        "sessionId": session.session_id,
        "output": output,
        "running": not session.finished,
        "exitCode": session.exit_code,
        "pendingBytes": max(0, session.total - session.cursor),
    }


# ---- 工具 handler ----------------------------------------------------------

def _open(args: Dict[str, Any]) -> Tuple[Any, str]:
    assert _MANAGER is not None
    cwd = str(args.get("cwd", "") or "").strip() or None
    if cwd and not os.path.isdir(cwd):
        raise NotADirectoryError(f"cwd 不是有效目录: {cwd}")
    session, output = _MANAGER.open(
        shell=args.get("shell"),
        cwd=cwd,
        cols=_as_int(args.get("cols"), 120),
        rows=_as_int(args.get("rows"), 32),
        max_wait=float(clamp_timeout(args, 2)),
    )
    return _status(session, output), f"已新建控制台 {session.session_id}（shell={session.shell}）"


def _send(args: Dict[str, Any]) -> Tuple[Any, str]:
    assert _MANAGER is not None
    session_id = str(args.get("sessionId", "") or "").strip()
    if not session_id:
        raise ValueError("缺少 sessionId")
    if "input" not in args and "text" not in args and not args.get("control"):
        raise ValueError("缺少 input（要写入的内容；如仅按回车传空串 input=\"\"）")
    data = args.get("input")
    if data is None:
        data = args.get("text")
    session, output = _MANAGER.send(
        session_id,
        str(data or ""),
        enter=bool(args.get("enter", True)),
        control=str(args.get("control", "") or ""),
        max_wait=float(clamp_timeout(args, 3)),
    )
    result = _status(session, output)
    tail = "（已退出）" if session.finished else ""
    return result, f"已发送到 {session_id}{tail}，返回 {len(output)} 字符新增输出"


def _read(args: Dict[str, Any]) -> Tuple[Any, str]:
    assert _MANAGER is not None
    session_id = str(args.get("sessionId", "") or "").strip()
    if not session_id:
        raise ValueError("缺少 sessionId")
    # 复用 timeout_seconds 命名：服务器据它延长任务超时，避免「等 200s 但服务器 120s 就掐」。
    max_wait = float(max(0, min(300, _as_int(args.get("timeout_seconds"), 0))))
    session, output = _MANAGER.read(session_id, max_wait=max_wait)
    result = _status(session, output)
    return result, f"读取 {session_id}：{len(output)} 字符新增输出"


def _list(_args: Dict[str, Any]) -> Tuple[Any, str]:
    assert _MANAGER is not None
    sessions = _MANAGER.list_sessions()
    running = sum(1 for s in sessions if s["running"])
    return {"sessions": sessions}, f"共 {len(sessions)} 个控制台（{running} 个存活）"


def _close(args: Dict[str, Any]) -> Tuple[Any, str]:
    assert _MANAGER is not None
    session_id = str(args.get("sessionId", "") or "").strip()
    if not session_id:
        raise ValueError("缺少 sessionId")
    session = _MANAGER.close(session_id)
    return {"sessionId": session_id, "exitCode": session.exit_code}, f"已关闭控制台 {session_id}"


def build_tools(enabled: bool, default_shell: str = "") -> List[Tool]:
    global _MANAGER
    if not enabled:
        return []
    _MANAGER = ConsoleManager(default_shell=default_shell)
    return [
        Tool(
            name="console.open",
            description=(
                "新建一个常驻交互式控制台（PTY shell），返回 sessionId 与初始输出（提示符等）。"
                "之后用 console.send 往里输入、console.read 拉最新输出。适合需要多轮交互的场景"
                "（如安装程序中途要确认/选择）。可同时开多个。以 agent 进程权限运行，属危险工具。"
            ),
            input_schema=obj_schema(
                {
                    "shell": {"type": "string", "description": "shell 路径（可选，默认自动探测 bash→sh）"},
                    "cwd": {"type": "string", "description": "启动工作目录（可选）"},
                    "cols": {"type": "integer", "description": "终端列数（可选，默认 120）"},
                    "rows": {"type": "integer", "description": "终端行数（可选，默认 32）"},
                    "timeout_seconds": {
                        "type": "integer",
                        "description": "等待起始输出的最长秒数（可选，默认 2）",
                        "minimum": 1,
                        "maximum": 300,
                    },
                }
            ),
            handler=_open,
            destructive=True,
        ),
        Tool(
            name="console.send",
            description=(
                "向指定控制台写入内容（默认自动追加回车），等输出稳定后返回**这一轮的新增输出**。"
                "用于回答交互式提示：如安装时问 [Y/n] 就 input='y'；选菜单就 input='2'。"
                "只按回车传 input=''。发送 Ctrl+C 等控制键用 control（如 control='c'）。"
            ),
            input_schema=obj_schema(
                {
                    "sessionId": {"type": "string", "description": "console.open 返回的会话 ID"},
                    "input": {"type": "string", "description": "要写入的文本（不含回车；回车由 enter 控制）"},
                    "enter": {"type": "boolean", "description": "是否在末尾追加回车（默认 true）"},
                    "control": {
                        "type": "string",
                        "description": "发送 Ctrl+<字母> 控制键，如 'c'=Ctrl+C 中断、'd'=Ctrl+D EOF（与 input 二选一常用）",
                    },
                    "timeout_seconds": {
                        "type": "integer",
                        "description": "等待输出稳定的最长秒数（可选，默认 3；命令较慢时上调）",
                        "minimum": 1,
                        "maximum": 300,
                    },
                },
                required=["sessionId"],
            ),
            handler=_send,
            destructive=True,
        ),
        Tool(
            name="console.read",
            description=(
                "拉取指定控制台自上次读取以来的**最新输出**（不写入任何内容）。"
                "用于命令还在跑、想再看看进展；传 wait_seconds 可等待一段时间收集输出。"
            ),
            input_schema=obj_schema(
                {
                    "sessionId": {"type": "string", "description": "console.open 返回的会话 ID"},
                    "timeout_seconds": {
                        "type": "integer",
                        "description": "最长等待秒数以收集输出（可选，默认 0=立即返回当前已有的新增）",
                        "minimum": 1,
                        "maximum": 300,
                    },
                },
                required=["sessionId"],
            ),
            handler=_read,
            destructive=False,
        ),
        Tool(
            name="console.list",
            description="列出当前所有常驻控制台会话及其存活状态、待读字节数、存活时长。",
            input_schema=obj_schema({}),
            handler=_list,
            destructive=False,
        ),
        Tool(
            name="console.close",
            description="关闭指定控制台会话（杀掉其进程组）。用完请关闭以释放会话名额（上限 8）。",
            input_schema=obj_schema(
                {"sessionId": {"type": "string", "description": "要关闭的会话 ID"}},
                required=["sessionId"],
            ),
            handler=_close,
            destructive=True,
        ),
    ]
