from __future__ import annotations

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .diagnostics import AgentDiagnostics, read_recent_json_lines


logger = logging.getLogger("heysure.codex.dashboard")


class DashboardServer:
    def __init__(
        self, host: str, port: int, diagnostics: AgentDiagnostics, log_path: Path
    ) -> None:
        self.host = host
        self.port = port
        self.diagnostics = diagnostics
        self.log_path = log_path
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self.port <= 0:
            return
        handler = _handler(self.diagnostics, self.log_path)
        self._server = ThreadingHTTPServer((self.host, self.port), handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="codex-agent-dashboard", daemon=True
        )
        self._thread.start()
        logger.info("local status dashboard listening on http://%s:%s", self.host, self.port)

    def close(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)


def _handler(diagnostics: AgentDiagnostics, log_path: Path):
    class Handler(BaseHTTPRequestHandler):
        server_version = "HeySureCodexDashboard/1"

        def do_GET(self) -> None:
            if self.path == "/" or self.path.startswith("/?"):
                self._send(200, "text/html; charset=utf-8", _HTML.encode("utf-8"))
                return
            if self.path.startswith("/api/status"):
                self._json(diagnostics.snapshot())
                return
            if self.path.startswith("/api/logs"):
                self._json({"items": read_recent_json_lines(log_path)})
                return
            if self.path == "/health":
                self._json({"ok": True})
                return
            self._json({"error": "not found"}, status=404)

        def log_message(self, _format: str, *args: Any) -> None:
            return

        def _json(self, value: Any, status: int = 200) -> None:
            data = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self._send(status, "application/json; charset=utf-8", data)

        def _send(self, status: int, content_type: str, data: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
            )
            self.end_headers()
            self.wfile.write(data)

    return Handler


_HTML = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HeySure Codex Agent</title><style>
:root{color-scheme:dark;font-family:Inter,"Microsoft YaHei",sans-serif;background:#09090b;color:#e4e4e7}*{box-sizing:border-box}body{margin:0;padding:24px;background:radial-gradient(circle at top,#172554 0,#09090b 42%)}main{max-width:1180px;margin:auto}.head{display:flex;justify-content:space-between;gap:16px;align-items:center}.badge{padding:7px 12px;border-radius:999px;background:#27272a}.ok{color:#34d399}.bad{color:#fb7185}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:18px 0}.card,.panel{background:#18181bcc;border:1px solid #3f3f46;border-radius:14px;padding:15px;box-shadow:0 12px 30px #0005}.label{font-size:12px;color:#a1a1aa}.value{font-size:18px;font-weight:700;margin-top:7px;word-break:break-all}.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}.panel{min-height:340px}.scroll{max-height:430px;overflow:auto}.row{padding:10px 0;border-bottom:1px solid #27272a}.time{font-size:11px;color:#71717a}.kind{font-weight:700;margin:3px 0}.detail{font:12px ui-monospace,Consolas,monospace;color:#d4d4d8;white-space:pre-wrap;word-break:break-word}.run{display:grid;grid-template-columns:1fr auto;gap:8px}.empty{color:#71717a;padding:20px 0}@media(max-width:760px){body{padding:12px}.cols{grid-template-columns:1fr}.head{align-items:flex-start;flex-direction:column}}
</style></head><body><main><div class="head"><div><h1>HeySure Codex Agent</h1><div class="label" id="identity">正在读取本地状态…</div></div><div class="badge" id="overall">连接检查中</div></div><section class="grid" id="cards"></section><section class="cols"><div class="panel"><h2>运行与消息</h2><div class="scroll" id="runs"></div></div><div class="panel"><h2>实时事件</h2><div class="scroll" id="events"></div></div></section><section class="panel" style="margin-top:14px"><h2>结构化日志</h2><div class="scroll" id="logs"></div></section></main><script>
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when=t=>t?new Date(t*1000).toLocaleString():'—';
const card=(label,value,good)=>`<div class="card"><div class="label">${esc(label)}</div><div class="value ${good===true?'ok':good===false?'bad':''}">${esc(value)}</div></div>`;
async function refresh(){try{const [s,l]=await Promise.all([fetch('/api/status').then(r=>r.json()),fetch('/api/logs').then(r=>r.json())]);const online=s.socket_connected&&s.registered;document.querySelector('#overall').innerHTML=online?'<span class="ok">● 服务器已连接</span>':'<span class="bad">● 服务器未就绪</span>';document.querySelector('#identity').textContent=`${s.device_id} · ${s.server} · UI 每 2 秒刷新`;document.querySelector('#cards').innerHTML=[card('Socket',s.socket_connected?'已连接':'断开',s.socket_connected),card('设备注册',s.registered?'已注册':'未注册',s.registered),card('Codex App Server',s.app_server,s.app_server==='running'),card('待发送事件',s.outbox_count??0,(s.outbox_count??0)===0),card('命令队列',s.command_queue??0,(s.command_queue??0)===0),card('最近收到命令',s.last_command?.event||'尚无'),card('运行时长',`${s.uptime_seconds}s`),card('日志文件',s.log_path||'—')].join('');const runs=Object.entries(s.runs||{}).sort((a,b)=>(b[1].updatedAt||0)-(a[1].updatedAt||0)).slice(0,30);document.querySelector('#runs').innerHTML=runs.length?runs.map(([id,r])=>`<div class="row run"><div><div class="kind">${esc(id)}</div><div class="detail">${esc(r.branch||r.workspace||'')}</div></div><div class="badge">${esc(r.status||'unknown')}</div></div>`).join(''):'<div class="empty">还没有收到服务器工单</div>';document.querySelector('#events').innerHTML=(s.events||[]).slice().reverse().map(e=>`<div class="row"><div class="time">${when(e.timestamp)} · ${esc(e.level)}</div><div class="kind">${esc(e.kind)}</div><div class="detail">${esc(JSON.stringify(e.detail))}</div></div>`).join('')||'<div class="empty">暂无事件</div>';document.querySelector('#logs').innerHTML=(l.items||[]).slice().reverse().map(e=>`<div class="row"><div class="time">${when(e.timestamp)} · ${esc(e.level||'')}</div><div class="detail">${esc(e.logger||'')} ${esc(e.message||'')}</div></div>`).join('')||'<div class="empty">暂无日志</div>';}catch(e){document.querySelector('#overall').innerHTML='<span class="bad">● UI 读取失败</span>'}}
refresh();setInterval(refresh,2000);
</script></body></html>"""
