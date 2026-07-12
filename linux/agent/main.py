"""进程入口：python -m agent.main（或 agent/run.sh）。

加载配置 → 起 Agent → 阻塞运行。收到 SIGINT/SIGTERM 优雅退出（杀 PTY、断开 socket）。
"""

from __future__ import annotations

import logging
import signal
import sys

from .config import Config
from .connection import Agent


def _setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    # socketio/engineio 的 INFO 太吵，压到 WARNING。
    for noisy in ("socketio", "engineio", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def main() -> int:
    config = Config.load()
    _setup_logging(config.log_level)
    log = logging.getLogger("heysure")
    log.info("HeySure Linux 服务器端 agent 启动｜服务器=%s", config.server)

    agent = Agent(config)

    def _on_signal(signum, _frame):
        log.info("收到信号 %s，正在退出…", signum)
        agent.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    try:
        agent.run()
    except KeyboardInterrupt:
        agent.shutdown()
    except SystemExit:
        raise
    except Exception:
        log.exception("agent 运行异常退出")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
