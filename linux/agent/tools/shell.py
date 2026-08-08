"""一次性 shell 执行及大输出的持久化、分页读取与搜索。"""
from __future__ import annotations

import json
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Tuple

from ..shellrun import MAX_OUTPUT_CHARS, run
from .base import TIMEOUT_PROP, Tool, clamp_timeout, obj_schema

_OUTPUT_ROOT = Path(os.environ.get("HEYSURE_SHELL_OUTPUT_DIR", "/www/linux/data/shell-output"))
_TTL_SECONDS = 24 * 3600
_MAX_SAVED_CHARS = 20 * 1024 * 1024
_SUMMARY_PART = 12_000


def _cleanup() -> None:
    if not _OUTPUT_ROOT.exists():
        return
    cutoff = time.time() - _TTL_SECONDS
    for item in _OUTPUT_ROOT.iterdir():
        try:
            if item.is_dir() and item.stat().st_mtime < cutoff:
                shutil.rmtree(item)
        except OSError:
            pass


def _preview(text: str) -> Tuple[str, bool]:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text, False
    omitted = len(text) - 2 * _SUMMARY_PART
    return text[:_SUMMARY_PART] + f"\n…[中间省略 {omitted} 字符；完整输出可用 outputId 续读/搜索]…\n" + text[-_SUMMARY_PART:], True


def _save(stdout: str, stderr: str, command: str) -> Tuple[str, Dict[str, Any]]:
    _cleanup()
    _OUTPUT_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    output_id = uuid.uuid4().hex[:16]
    folder = _OUTPUT_ROOT / output_id
    folder.mkdir(mode=0o700)
    streams = {}
    for name, text in (("stdout", stdout), ("stderr", stderr)):
        saved = text[:_MAX_SAVED_CHARS]
        (folder / f"{name}.txt").write_text(saved, encoding="utf-8")
        streams[name] = {"chars": len(text), "lines": text.count("\n"), "savedChars": len(saved), "storageTruncated": len(saved) < len(text)}
    meta = {"outputId": output_id, "command": command, "createdAt": int(time.time()), "expiresAt": int(time.time()) + _TTL_SECONDS, "streams": streams}
    (folder / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return output_id, meta


def _folder(output_id: Any) -> Path:
    oid = str(output_id or "").strip()
    if not oid or any(c not in "0123456789abcdef" for c in oid):
        raise ValueError("无效 outputId")
    folder = _OUTPUT_ROOT / oid
    if not folder.is_dir():
        raise ValueError(f"outputId 不存在或已过期: {oid}")
    return folder


def shell_exec(args: Dict[str, Any]) -> Tuple[Any, str]:
    command = str(args.get("command", "") or "").strip()
    if not command:
        raise ValueError("缺少 command")
    cwd = str(args.get("cwd", "") or "").strip() or None
    if cwd and not os.path.isdir(cwd):
        raise NotADirectoryError(f"cwd 不是有效目录: {cwd}")
    mode = str(args.get("output_mode", "summary") or "summary").lower()
    if mode not in {"summary", "full", "discard"}:
        raise ValueError("output_mode 仅支持 summary/full/discard")
    timeout = clamp_timeout(args, 30)
    res = run(command, shell=True, cwd=cwd, timeout=timeout, truncate_output=False)
    stdout, stderr = str(res["stdout"]), str(res["stderr"])
    output_id = None
    meta = None
    truncated = len(stdout) > MAX_OUTPUT_CHARS or len(stderr) > MAX_OUTPUT_CHARS
    if truncated or mode == "summary":
        output_id, meta = _save(stdout, stderr, command)
    if mode == "discard":
        out_view = err_view = ""
    elif mode == "full" and not truncated:
        out_view, err_view = stdout, stderr
    else:
        out_view, _ = _preview(stdout)
        err_view, _ = _preview(stderr)
    result = {"command": command, "cwd": cwd, "exit_code": res["code"], "timed_out": res["timed_out"], "stdout": out_view, "stderr": err_view, "truncated": truncated, "outputId": output_id, "outputMeta": meta}
    if res["timed_out"]:
        return result, f"命令超时（>{timeout}s）：{command[:80]}"
    status = "成功" if res["ok"] else f"退出码 {res['code']}"
    return result, f"{status}：{command[:80]}" + (f"（完整输出 {output_id}）" if output_id else "")


def output_read(args: Dict[str, Any]) -> Tuple[Any, str]:
    folder = _folder(args.get("outputId"))
    stream = str(args.get("stream", "stdout"))
    if stream not in {"stdout", "stderr"}:
        raise ValueError("stream 仅支持 stdout/stderr")
    text = (folder / f"{stream}.txt").read_text(encoding="utf-8")
    offset = max(0, int(args.get("offset", 0) or 0))
    limit = max(1000, min(60000, int(args.get("limit", 20000) or 20000)))
    chunk = text[offset:offset + limit]
    next_offset = offset + len(chunk)
    result = {"outputId": folder.name, "stream": stream, "offset": offset, "limit": limit, "text": chunk, "nextOffset": next_offset, "remainingChars": max(0, len(text) - next_offset), "done": next_offset >= len(text)}
    return result, f"读取 {folder.name}/{stream}：{len(chunk)} 字符，剩余 {result['remainingChars']}"


def output_search(args: Dict[str, Any]) -> Tuple[Any, str]:
    folder = _folder(args.get("outputId"))
    stream = str(args.get("stream", "stdout"))
    if stream not in {"stdout", "stderr"}:
        raise ValueError("stream 仅支持 stdout/stderr")
    query = str(args.get("query", ""))
    if not query:
        raise ValueError("缺少 query")
    text = (folder / f"{stream}.txt").read_text(encoding="utf-8")
    context = max(50, min(2000, int(args.get("context_chars", 300) or 300)))
    max_matches = max(1, min(50, int(args.get("max_matches", 10) or 10)))
    matches, pos = [], 0
    while len(matches) < max_matches:
        idx = text.find(query, pos)
        if idx < 0:
            break
        matches.append({"offset": idx, "excerpt": text[max(0, idx-context):min(len(text), idx+len(query)+context)]})
        pos = idx + max(1, len(query))
    return {"outputId": folder.name, "stream": stream, "query": query, "matches": matches}, f"在 {folder.name}/{stream} 找到 {len(matches)} 个匹配"


def build_tools(enabled: bool) -> List[Tool]:
    if not enabled:
        return []
    return [
        Tool(name="shell.exec", description="在本机执行命令。大输出默认返回头尾摘要并保存全文，返回 outputId；可用 shell.output.read/search 续读。", input_schema=obj_schema({"command":{"type":"string","description":"要执行的 shell 命令"},"cwd":{"type":"string","description":"工作目录（可选）"},"output_mode":{"type":"string","enum":["summary","full","discard"],"description":"输出模式，默认 summary"},"timeout_seconds":TIMEOUT_PROP}, required=["command"]), handler=shell_exec, destructive=True),
        Tool(name="shell.output.read", description="按字符偏移分页读取 shell.exec 保存的完整 stdout/stderr。", input_schema=obj_schema({"outputId":{"type":"string"},"stream":{"type":"string","enum":["stdout","stderr"]},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1000,"maximum":60000}}, required=["outputId"]), handler=output_read, destructive=False),
        Tool(name="shell.output.search", description="在 shell.exec 保存的完整输出中搜索关键词并返回命中上下文。", input_schema=obj_schema({"outputId":{"type":"string"},"stream":{"type":"string","enum":["stdout","stderr"]},"query":{"type":"string"},"context_chars":{"type":"integer","minimum":50,"maximum":2000},"max_matches":{"type":"integer","minimum":1,"maximum":50}}, required=["outputId","query"]), handler=output_search, destructive=False),
    ]
