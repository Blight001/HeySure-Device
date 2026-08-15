from __future__ import annotations

import signal

from .agent import CodexAgent
from .config import Config
from .dashboard import DashboardServer
from .diagnostics import configure_logging
from .state import InstanceLock


def main() -> int:
    config = Config.from_env()
    log_path = configure_logging(config.state_dir, config.log_level)
    with InstanceLock(config.state_dir):
        agent = CodexAgent(config)
        agent.diagnostics.update(log_path=str(log_path))
        dashboard = DashboardServer(
            config.dashboard_host, config.dashboard_port, agent.diagnostics, log_path
        )
        dashboard.start()

        def stop(*_: object) -> None:
            agent.shutdown()

        signal.signal(signal.SIGINT, stop)
        if hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, stop)
        try:
            agent.run()
        finally:
            agent.shutdown()
            dashboard.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
