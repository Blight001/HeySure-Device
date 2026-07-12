"""工具装配：把各域模块的 Tool 汇总成 read.md 需要的 toolDefs + 路由表。

用法：
    registry = build_registry(enable_shell_exec=True)
    registry.tool_defs        -> device:register 的 toolDefs（read.md 5）
    registry.capabilities     -> capabilities 工具名清单
    registry.dispatch(tool, args) -> (result, summary)，未知工具抛 KeyError
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

from . import network, packages, services, storage, system
from . import shell as shell_mod
from .base import Tool


class UnknownToolError(Exception):
    """派发到一个本服务未申报的工具名。与工具内部异常区分开，避免误报。"""


@dataclass
class Registry:
    tools: List[Tool]

    @property
    def capabilities(self) -> List[str]:
        return [t.name for t in self.tools]

    @property
    def tool_defs(self) -> List[Dict[str, Any]]:
        return [t.to_def() for t in self.tools]

    def dispatch(self, tool: str, args: Dict[str, Any]) -> Tuple[Any, str]:
        handler = self._index().get(tool)
        if handler is None:
            raise UnknownToolError(tool)
        return handler(args or {})

    def _index(self) -> Dict[str, Any]:
        return {t.name: t.handler for t in self.tools}


def build_registry(*, enable_shell_exec: bool) -> Registry:
    tools: List[Tool] = []
    tools += system.TOOLS
    tools += services.TOOLS
    tools += storage.TOOLS
    tools += network.TOOLS
    tools += packages.TOOLS
    tools += shell_mod.build_tools(enable_shell_exec)
    # 唯一性自检：同名工具会让服务器派发歧义（read.md 5.1）。
    seen: Dict[str, int] = {}
    for t in tools:
        seen[t.name] = seen.get(t.name, 0) + 1
    dupes = [name for name, count in seen.items() if count > 1]
    if dupes:
        raise RuntimeError(f"工具名重复: {dupes}")
    return Registry(tools=tools)
