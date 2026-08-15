from __future__ import annotations

import logging
import signal

from .agent import CodexAgent
from .config import Config
from .state import InstanceLock


def main() -> int:
    config = Config.from_env()
    logging.basicConfig(
        level=getattr(logging, config.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    with InstanceLock(config.state_dir):
        agent = CodexAgent(config)

        def stop(*_: object) -> None:
            agent.shutdown()

        signal.signal(signal.SIGINT, stop)
        if hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, stop)
        try:
            agent.run()
        finally:
            agent.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

