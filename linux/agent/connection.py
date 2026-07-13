"""登录 + Socket.IO 连接 + 注册 + 自动恢复（read.md 3、4）。

登录换 token → 连 agent_socket_url → device:register；断线自动重连重注册，
token 失效（device:register_rejected）自动重登录。装配 task:* 与 rt:* 两条链路。
"""

from __future__ import annotations

import logging
import platform
import time
from typing import Any, Dict, Optional

import requests
import socketio

from . import __version__
from .config import Config
from .dispatch import TaskDispatcher
from .remote_terminal import TerminalManager
from .tools import build_registry
from .tools.console import get_manager as get_console_manager

logger = logging.getLogger("heysure.conn")


class Agent:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.registry = build_registry(
            enable_shell_exec=config.enable_shell_exec,
            enable_console=config.enable_console,
            default_shell=config.default_shell,
        )
        self.state: Dict[str, Any] = {
            "token": None,
            "socket_url": config.server,
            "registered": False,
        }
        self.sio = socketio.Client(
            reconnection=True,
            reconnection_delay=2,
            reconnection_delay_max=30,
            logger=False,
            engineio_logger=False,
        )
        self.dispatcher = TaskDispatcher(self.sio, self.registry, config.service_id)
        self.terminal = TerminalManager(self.sio, config.default_shell) \
            if config.enable_remote_terminal else None
        self._register_handlers()

    # ---- 登录 ---------------------------------------------------------------

    def login(self) -> None:
        url = f"{self.config.server}/api/auth/login"
        resp = requests.post(
            url,
            json={"account": self.config.account, "password": self.config.password},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        token = data.get("access_token")
        if not token:
            raise RuntimeError(f"登录响应缺少 access_token: {data}")
        self.state["token"] = token
        # 永远优先用服务器给的 agent_socket_url（可能经反代/独立对外地址）。
        self.state["socket_url"] = (data.get("agent_socket_url") or self.config.server).rstrip("/")
        logger.info("登录成功，socket=%s", self.state["socket_url"])

    def _login_with_retry(self, attempts: int = 30) -> None:
        delay = 2
        for i in range(1, attempts + 1):
            try:
                self.login()
                return
            except Exception as exc:
                logger.warning("登录失败(%d/%d): %s", i, attempts, exc)
                time.sleep(min(delay, 30))
                delay = min(delay * 2, 30)
        raise SystemExit("多次登录失败，退出。请检查 HEYSURE_SERVER / 账号密码 / 网络。")

    # ---- 注册 ---------------------------------------------------------------

    def _register_payload(self) -> Dict[str, Any]:
        caps = list(self.registry.capabilities) + self.config.capabilities_extra()
        payload: Dict[str, Any] = {
            "id": self.config.service_id,
            "name": self.config.service_name,
            "token": self.state["token"],
            "deviceType": "custom",          # 固定值：服务器据此归类为「自定义设备」
            "platform": "custom-service",    # 自由串；勿含 desktop/windows/browser/android/workshop
            "capabilities": caps,            # MCP 工具名 + remote_terminal（传输层能力字）
            "toolDefs": self.registry.tool_defs,
            "version": __version__,
            "lifecycle": "registered",
            "os": {
                "platform": "linux",
                "arch": platform.machine(),
                "hostname": self.config.hostname,
            },
        }
        if self.config.icon:
            payload["icon"] = self.config.icon
        return payload

    def register(self) -> None:
        self.sio.emit("device:register", self._register_payload())

    # ---- 事件装配 -----------------------------------------------------------

    def _register_handlers(self) -> None:
        sio = self.sio

        @sio.event
        def connect() -> None:
            self.state["registered"] = False
            logger.info("Socket 已连接，注册中…")
            self.register()

            def _retry() -> None:  # 收到确认前每 3 秒重发，防握手期丢包
                while sio.connected and not self.state["registered"]:
                    sio.sleep(3)
                    if sio.connected and not self.state["registered"]:
                        self.register()

            sio.start_background_task(_retry)

        @sio.event
        def disconnect() -> None:
            self.state["registered"] = False
            logger.warning("Socket 断开")
            if self.terminal:
                self.terminal.close_all()  # 断线杀掉全部 PTY（read.md 9.2）

        @sio.on("device:registered")
        def on_registered(data: Dict[str, Any]) -> None:
            self.state["registered"] = True
            ai = (data or {}).get("aiConfigId")
            if ai in (None, "", 0):
                logger.info("✅ 已注册（未绑定 AI）——请到网页控制台作坊面板给本服务分配 AI 并勾选工具权限。")
            else:
                logger.info("✅ 已注册，已绑定 AI aiConfigId=%s", ai)

        @sio.on("device:register_rejected")
        def on_rejected(data: Dict[str, Any]) -> None:
            reason = (data or {}).get("reason")
            logger.warning("注册被拒: %s —— 尝试重新登录后重注册", reason)
            try:
                self.login()
                self.register()
            except Exception:
                logger.exception("重登录失败")

        @sio.on("task:dispatch")
        def on_task(task: Dict[str, Any]) -> None:
            self.dispatcher.on_dispatch(task if isinstance(task, dict) else {})

        if self.terminal:
            @sio.on("rt:open")
            def rt_open(data: Dict[str, Any]) -> None:
                self.terminal.on_open(data if isinstance(data, dict) else {})

            @sio.on("rt:input")
            def rt_input(data: Dict[str, Any]) -> None:
                self.terminal.on_input(data if isinstance(data, dict) else {})

            @sio.on("rt:resize")
            def rt_resize(data: Dict[str, Any]) -> None:
                self.terminal.on_resize(data if isinstance(data, dict) else {})

            @sio.on("rt:close")
            def rt_close(data: Dict[str, Any]) -> None:
                self.terminal.on_close(data if isinstance(data, dict) else {})

    # ---- 运行 ---------------------------------------------------------------

    def run(self) -> None:
        self._login_with_retry()
        logger.info(
            "服务 id=%s name=%s｜工具 %d 个%s",
            self.config.service_id,
            self.config.service_name,
            len(self.registry.capabilities),
            "｜命令行远程: 开" if self.terminal else "｜命令行远程: 关",
        )
        self.sio.connect(self.state["socket_url"], wait_timeout=15)
        self.sio.wait()

    def shutdown(self) -> None:
        # console.* 会话刻意不随 socket 断线关闭（长时间安装要能跨重连继续），
        # 只在进程退出时统一回收。
        try:
            if self.terminal:
                self.terminal.close_all()
            console = get_console_manager()
            if console:
                console.close_all()
        finally:
            if self.sio.connected:
                self.sio.disconnect()
