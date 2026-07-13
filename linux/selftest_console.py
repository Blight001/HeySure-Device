#!/usr/bin/env python3
"""console.* 自检：在本机真起 PTY，跑一遍「命令中途要确认 → 回答 → 看结果」的完整交互。

不连服务器、不依赖账号，纯本地验证工具链路是否可用：

    cd device/linux && python3 selftest_console.py

Windows/CI 上跑不了（需要 pty，Unix-only）——请在目标 Linux 机器上执行。
"""

from __future__ import annotations

import sys

from agent.tools import console as C


def main() -> int:
    mgr = C.ConsoleManager()
    fails = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(("  PASS " if ok else "  FAIL ") + name + (f"  {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    print("1) 新建控制台")
    session, output = mgr.open(max_wait=2.0)
    print(f"   sessionId={session.session_id} shell={session.shell} pid={session.pid}")
    check("会话存活", not session.finished)

    print("2) 跑一条会「中途要确认」的命令（模拟安装程序问 [Y/n]）")
    _, out = mgr.send(
        session.session_id,
        "read -p 'Do you want to continue? [Y/n] ' ans && echo \"ANSWER=$ans\"",
        max_wait=5.0,
    )
    print(f"   收到输出: {out.strip()!r}")
    check("命令停在提示符处等待输入（而不是卡死/直接结束）", "[Y/n]" in out)
    check("此时还没有结果（说明确实在等我回答）", "ANSWER=" not in out)

    print("3) 回答 y + 回车，拿这一轮的新增输出")
    _, out = mgr.send(session.session_id, "y", max_wait=5.0)
    print(f"   收到输出: {out.strip()!r}")
    check("拿到确认后的结果", "ANSWER=y" in out)

    print("4) 会话是有状态的（cd / 变量能跨调用保留）")
    mgr.send(session.session_id, "cd /tmp && FOO=bar", max_wait=5.0)
    _, out = mgr.send(session.session_id, "echo $PWD-$FOO", max_wait=5.0)
    print(f"   收到输出: {out.strip()!r}")
    check("上一次调用的 cwd 与变量仍在", "/tmp-bar" in out)

    print("5) 长命令边跑边用 console.read 轮询进展（AI 的真实用法：反复拉最新输出）")
    _, out = mgr.send(session.session_id, "for i in 1 2 3; do echo step-$i; sleep 1; done", max_wait=1.5)
    seen = out
    for _ in range(10):
        if "step-3" in seen:
            break
        _, more = mgr.read(session.session_id, max_wait=2.0)
        seen += more
    print(f"   累计输出: {seen.strip()!r}")
    check("轮询 read 拿全了 step-1..3", all(f"step-{i}" in seen for i in (1, 2, 3)))

    print("6) Ctrl+C 能中断卡住的前台命令")
    mgr.send(session.session_id, "sleep 300", max_wait=1.0)
    _, out = mgr.send(session.session_id, "", control="c", max_wait=3.0)
    _, out = mgr.send(session.session_id, "echo alive", max_wait=3.0)
    print(f"   收到输出: {out.strip()!r}")
    check("Ctrl+C 后 shell 仍可用", "alive" in out)

    print("7) 多开与列表")
    s2, _ = mgr.open(max_wait=2.0)
    sessions = mgr.list_sessions()
    check("两个会话都在", len([s for s in sessions if s["running"]]) == 2, f"{[s['sessionId'] for s in sessions]}")

    print("8) 关闭")
    mgr.close(s2.session_id)
    mgr.close(session.session_id)
    alive = [s for s in mgr.list_sessions() if s["running"]]
    check("关闭后无存活会话", not alive)

    print()
    if fails:
        print(f"❌ {len(fails)} 项失败: {fails}")
        return 1
    print("✅ console.* 全部自检通过——AI 可以持续操作交互式控制台了。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
