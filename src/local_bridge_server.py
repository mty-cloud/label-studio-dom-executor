"""
Local bridge server for Label Studio DOM executor.

The browser-side bookmarklet injects bridge/ls_dom_executor_bridge.js into the
current Label Studio page. The injected script registers to this local server,
polls for commands, executes DOM operations inside the page, and posts results
back.

This module intentionally contains no screen coordinate logic and no pyautogui.
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse


def _resource_base() -> str:
    """返回项目资源根目录，支持开发模式和 PyInstaller 打包模式。"""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return sys._MEIPASS
    return str(Path(__file__).resolve().parents[1])


@dataclass
class BridgeState:
    lock: threading.RLock = field(default_factory=threading.RLock)
    connected: bool = False
    client_id: Optional[str] = None
    page_url: str = ""
    page_title: str = ""
    task_id: str = ""
    last_seen_ts: float = 0.0
    pending_command: Optional[Dict[str, Any]] = None
    last_result: Optional[Dict[str, Any]] = None
    command_results: Dict[str, Dict[str, Any]] = field(default_factory=dict)

    def register(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            new_client_id = str(payload.get("clientId") or payload.get("client_id") or uuid.uuid4())
            self.connected = True
            self.client_id = new_client_id
            self.page_url = str(payload.get("url") or "")
            self.page_title = str(payload.get("title") or "")
            self.task_id = str(payload.get("taskId") or payload.get("task_id") or "")
            self.last_seen_ts = time.time()
            return {
                "ok": True,
                "clientId": self.client_id,
                "serverTime": int(time.time() * 1000),
            }

    def heartbeat(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            incoming_id = str(payload.get("clientId") or "")
            # 只接受当前已注册 client 的心跳，屏蔽旧 session 残留
            if self.client_id and incoming_id and incoming_id != self.client_id:
                return {"ok": False, "error": "stale_client"}
            self.connected = True
            if incoming_id:
                self.client_id = incoming_id
            self.page_url = str(payload.get("url") or self.page_url)
            self.page_title = str(payload.get("title") or self.page_title)
            self.task_id = str(payload.get("taskId") or self.task_id)
            self.last_seen_ts = time.time()
            return {"ok": True, "serverTime": int(time.time() * 1000)}

    def set_command(self, command: Dict[str, Any]) -> str:
        with self.lock:
            command_id = str(uuid.uuid4())
            command = dict(command)
            command["commandId"] = command_id
            command["createdAt"] = int(time.time() * 1000)
            self.pending_command = command
            self.last_result = None
            return command_id

    def pop_command_for_client(self, client_id: str) -> Dict[str, Any]:
        with self.lock:
            if self.client_id and client_id and client_id != self.client_id:
                return {"ok": True, "command": None, "reason": "client_id_mismatch"}
            cmd = self.pending_command
            self.pending_command = None
            return {"ok": True, "command": cmd}

    def post_result(self, result: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            command_id = str(result.get("commandId") or result.get("command_id") or "")
            self.last_result = result
            if command_id:
                self.command_results[command_id] = result
            self.last_seen_ts = time.time()
            return {"ok": True}

    def get_result(self, command_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            return self.command_results.get(command_id)

    def status(self) -> Dict[str, Any]:
        with self.lock:
            age = time.time() - self.last_seen_ts if self.last_seen_ts else None
            connected = bool(self.connected and age is not None and age < 8.0)
            return {
                "ok": True,
                "connected": connected,
                "clientId": self.client_id,
                "pageUrl": self.page_url,
                "pageTitle": self.page_title,
                "taskId": self.task_id,
                "lastSeenAgeSec": round(age, 2) if age is not None else None,
                "hasPendingCommand": self.pending_command is not None,
            }


class BridgeHTTPServer(ThreadingHTTPServer):
    def __init__(self, server_address, RequestHandlerClass, state: BridgeState, root_dir: Path):
        super().__init__(server_address, RequestHandlerClass)
        self.state = state
        self.root_dir = root_dir


class BridgeRequestHandler(BaseHTTPRequestHandler):
    server: BridgeHTTPServer

    def log_message(self, format: str, *args: Any) -> None:
        # Silence default HTTP logging; GUI has its own logs.
        return

    def _set_cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Requested-With")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send_json(self, data: Dict[str, Any], status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._set_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, text: str, content_type: str = "text/plain; charset=utf-8", status: int = 200) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self._set_cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._set_cors()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/ping":
            self._send_json({"ok": True, "serverTime": int(time.time() * 1000)})
            return

        if path == "/status":
            self._send_json(self.server.state.status())
            return

        if path == "/bridge/command":
            client_id = query.get("clientId", [""])[0]
            self._send_json(self.server.state.pop_command_for_client(client_id))
            return

        if path == "/bridge/ls_dom_executor_bridge.js":
            js_path = self.server.root_dir / "bridge" / "ls_dom_executor_bridge.js"
            if not js_path.exists():
                self._send_text("console.error('ls_dom_executor_bridge.js not found');", "application/javascript; charset=utf-8", 404)
                return
            self._send_text(js_path.read_text(encoding="utf-8"), "application/javascript; charset=utf-8")
            return

        if path == "/bookmarklet.txt":
            txt_path = self.server.root_dir / "bridge" / "bookmarklet.txt"
            self._send_text(txt_path.read_text(encoding="utf-8"), "text/plain; charset=utf-8")
            return

        if path == "/bridge/loader":
            html_path = self.server.root_dir / "bridge" / "loader.html"
            self._send_text(html_path.read_text(encoding="utf-8"), "text/html; charset=utf-8")
            return

        self._send_json({"ok": False, "error": f"Unknown GET path: {path}"}, 404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        payload = self._read_json()

        if path == "/bridge/register":
            self._send_json(self.server.state.register(payload))
            return

        if path == "/bridge/heartbeat":
            self._send_json(self.server.state.heartbeat(payload))
            return

        if path == "/bridge/result":
            self._send_json(self.server.state.post_result(payload))
            return

        self._send_json({"ok": False, "error": f"Unknown POST path: {path}"}, 404)


class LocalBridgeServer:
    def __init__(self, host: str = "127.0.0.1", port: int = 17892, root_dir: Optional[Path] = None):
        self.host = host
        self.port = port
        self.root_dir = Path(_resource_base()) if root_dir is None else root_dir
        self.state = BridgeState()
        self._server: Optional[BridgeHTTPServer] = None
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._server:
            return
        self._server = BridgeHTTPServer((self.host, self.port), BridgeRequestHandler, self.state, self.root_dir)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def status(self) -> Dict[str, Any]:
        return self.state.status()

    def send_execute_template(self, remark: str, auto_submit: bool, auto_next: bool, settings: Dict[str, Any]) -> str:
        command = {
            "type": "execute_template",
            "remark": remark,
            "autoSubmit": auto_submit,
            "autoNext": auto_next,
            "settings": settings,
        }
        return self.state.set_command(command)

    def wait_result(self, command_id: str, timeout_ms: int = 12000) -> Dict[str, Any]:
        start = time.time()
        timeout_sec = max(1, timeout_ms / 1000.0)
        while time.time() - start < timeout_sec:
            result = self.state.get_result(command_id)
            if result is not None:
                return result
            time.sleep(0.05)
        raise TimeoutError(f"等待页面桥接执行结果超时：{command_id}")
