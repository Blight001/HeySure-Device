"""工具注册的公共类型与小工具。

每个工具 = 一个 Tool(name, description, input_schema, handler, destructive)。
handler(args) -> (result, summary)：result 任意可 JSON 序列化，summary 一句人话。
tools/__init__.py 汇总各域模块的 Tool 列表，装配成 read.md 需要的 TOOLS + HANDLERS。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Tuple

# handler 返回 (result, summary)
Handler = Callable[[Dict[str, Any]], Tuple[Any, str]]


@dataclass
class Tool:
    name: str
    description: str
    input_schema: Dict[str, Any]
    handler: Handler
    destructive: bool = False

    def to_def(self) -> Dict[str, Any]:
        """转成 device:register 的 toolDefs 元素（read.md 5）。"""
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
            "destructive": self.destructive,
        }


# 允许工具描述里声明可延长的执行时长（read.md 8.3）。
TIMEOUT_PROP: Dict[str, Any] = {
    "type": "integer",
    "description": "可选，最长等待秒数（默认按服务器 120s，上限 300）。耗时命令请上调。",
    "minimum": 1,
    "maximum": 300,
}


def clamp_timeout(args: Dict[str, Any], default: int) -> int:
    """从 args.timeout_seconds 解析执行超时，夹在 [1, 300]。"""
    raw = args.get("timeout_seconds")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, min(300, value))


def obj_schema(properties: Dict[str, Any], required: list[str] | None = None) -> Dict[str, Any]:
    schema: Dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema
