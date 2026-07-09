"""
Local bridge server for Label Studio DOM executor.

Serves multiple roles:
  1. Bridge endpoints (legacy) — for bookmarklet-injected JS to register, heartbeat, poll commands
  2. API proxy endpoints (/api/*) — Web UI talks to LS REST API through this server (token stays local)
  3. Web UI static files (/web/*) — serve the modern HTML interface

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
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

# Ensure src/ is in path for sibling module imports
_src_dir = str(Path(__file__).resolve().parent)
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

from ls_api_client import LSApiClient, create_client_from_settings


def _resource_base() -> str:
    """Return project resource root (supports dev and PyInstaller)."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return sys._MEIPASS
    return str(Path(__file__).resolve().parents[1])


ROOT_DIR = Path(_resource_base())
SETTINGS_PATH = ROOT_DIR / "config" / "settings.json"
TEMPLATES_PATH = ROOT_DIR / "config" / "templates.json"


def _get_tm():
    """Get template manager (lazy import to avoid circular deps at top level)."""
    from template_manager import TemplateManager
    return TemplateManager(TEMPLATES_PATH)


# ---------------------------------------------------------------------------
# Settings helpers
# ---------------------------------------------------------------------------

def load_settings() -> dict:
    if SETTINGS_PATH.exists():
        return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    return {
        "bridge": {"host": "127.0.0.1", "port": 17892, "command_timeout_ms": 40000},
        "execution": {"auto_submit": True, "auto_next": True},
        "label_studio": {"api_url": "", "api_token": ""},
    }


def save_settings(cfg: dict) -> None:
    SETTINGS_PATH.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def get_ls_client() -> Optional[LSApiClient]:
    """Create LSApiClient from current settings."""
    return create_client_from_settings(str(SETTINGS_PATH))


# ---------------------------------------------------------------------------
# Bridge state
# ---------------------------------------------------------------------------

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
            new_client_id = str(
                payload.get("clientId") or payload.get("client_id") or uuid.uuid4()
            )
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


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class BridgeHTTPServer(ThreadingHTTPServer):
    def __init__(self, server_address, RequestHandlerClass, state: BridgeState, root_dir: Path):
        super().__init__(server_address, RequestHandlerClass)
        self.state = state
        self.root_dir = root_dir


class BridgeRequestHandler(BaseHTTPRequestHandler):
    server: BridgeHTTPServer

    def log_message(self, format: str, *args: Any) -> None:
        return  # silence default HTTP logging

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _set_cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PATCH")
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

    def _send_text(
        self, text: str, content_type: str = "text/plain; charset=utf-8", status: int = 200
    ) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self._set_cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(
        self, file_path: Path, status: int = 200, extra_headers: Optional[Dict[str, str]] = None
    ) -> None:
        if not file_path.exists() or not file_path.is_file():
            self._send_json({"ok": False, "error": "File not found"}, 404)
            return
        content = file_path.read_bytes()
        mime_type, _ = mimetypes.guess_type(str(file_path))
        if mime_type is None:
            mime_type = "application/octet-stream"
        self.send_response(status)
        self._set_cors()
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(content)))
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(content)

    def _read_json(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def _parse_path(self) -> tuple:
        """Return (path, query_dict)."""
        parsed = urlparse(self.path)
        return parsed.path.rstrip("/"), parse_qs(parsed.query)

    # ------------------------------------------------------------------
    # Route dispatcher
    # ------------------------------------------------------------------

    def _route(self, method: str) -> None:
        path, query = self._parse_path()
        body = self._read_json() if method in ("POST", "PATCH") else None

        try:
            # ---- Bridge endpoints (legacy) ----
            if path == "/ping":
                return self._send_json({"ok": True, "serverTime": int(time.time() * 1000)})

            if path == "/status":
                return self._send_json(self.server.state.status())

            if method == "GET" and path == "/bridge/command":
                client_id = query.get("clientId", [""])[0]
                return self._send_json(self.server.state.pop_command_for_client(client_id))

            if path == "/bridge/register" and method == "POST":
                return self._send_json(self.server.state.register(body or {}))

            if path == "/bridge/heartbeat" and method == "POST":
                return self._send_json(self.server.state.heartbeat(body or {}))

            if path == "/bridge/result" and method == "POST":
                return self._send_json(self.server.state.post_result(body or {}))

            if method == "GET" and path == "/bridge/ls_dom_executor_bridge.js":
                js_path = self.server.root_dir / "bridge" / "ls_dom_executor_bridge.js"
                if not js_path.exists():
                    return self._send_text(
                        "console.error('ls_dom_executor_bridge.js not found');",
                        "application/javascript; charset=utf-8",
                        404,
                    )
                return self._send_file(js_path)

            if method == "GET" and path == "/bridge/ls_dom_executor_bridge_v2.js":
                js_path = self.server.root_dir / "bridge" / "ls_dom_executor_bridge_v2.js"
                if js_path.exists():
                    return self._send_file(js_path)
                # Fallback to v1 if v2 doesn't exist yet
                return self._send_file(
                    self.server.root_dir / "bridge" / "ls_dom_executor_bridge.js"
                )

            if method == "GET" and path == "/bookmarklet.txt":
                return self._send_file(self.server.root_dir / "bridge" / "bookmarklet.txt")

            if method == "GET" and path == "/bridge/loader":
                return self._send_file(
                    self.server.root_dir / "bridge" / "loader.html",
                    extra_headers={"Cache-Control": "no-store"},
                )

            # ---- Bridge command dispatch (for Web UI) ----
            if method == "POST" and path == "/bridge/send-command":
                cmd_body = (body or {}).copy()
                # Pass through all fields (type, remark, autoSubmit, autoNext, nextTaskId, settings, etc.)
                command = dict(cmd_body)
                cmd_id = self.server.state.set_command(command)
                return self._send_json({"ok": True, "commandId": cmd_id})

            if method == "GET" and path == "/bridge/command-result":
                cmd_id = query.get("commandId", [""])[0]
                if not cmd_id:
                    return self._send_json({"ok": False, "error": "commandId required"})
                result = self.server.state.get_result(cmd_id)
                if result is not None:
                    return self._send_json({"ok": True, "found": True, "result": result})
                return self._send_json({"ok": True, "found": False, "result": None})

            # ---- Web UI static files ----
            if method == "GET" and (path == "/web" or path.startswith("/web/")):
                return self._serve_web_ui(path)

            # ---- API proxy endpoints ----
            if path.startswith("/api/"):
                return self._handle_api(method, path, query, body)

            # 404
            self._send_json({"ok": False, "error": f"Unknown {method} path: {path}"}, 404)

        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)

    # ------------------------------------------------------------------
    # Web UI static file serving
    # ------------------------------------------------------------------

    def _serve_web_ui(self, path: str) -> None:
        """Serve files from webui/ directory."""
        web_dir = self.server.root_dir / "webui"
        if not web_dir.exists():
            self._send_json(
                {"ok": False, "error": "Web UI not built yet (webui/ directory missing)"},
                404,
            )
            return

        # Map /web -> /web/index.html, /web/ -> /web/index.html
        rel = path.removeprefix("/web").lstrip("/")
        if not rel:
            rel = "index.html"

        file_path = (web_dir / rel).resolve()
        # Security: prevent directory traversal
        if not str(file_path).startswith(str(web_dir.resolve())):
            self._send_json({"ok": False, "error": "Forbidden"}, 403)
            return

        if file_path.is_dir():
            file_path = file_path / "index.html"

        if not file_path.exists():
            self._send_json({"ok": False, "error": "Not found"}, 404)
            return

        self._send_file(file_path)

    # ------------------------------------------------------------------
    # API proxy handlers
    # ------------------------------------------------------------------

    def _handle_api(
        self,
        method: str,
        path: str,
        query: Dict[str, List[str]],
        body: Optional[Dict[str, Any]],
    ) -> None:
        """Handle /api/* routes — proxy to LS REST API or server internal."""

        # GET /api/ping — test LS API connectivity
        if method == "GET" and path == "/api/ping":
            client = get_ls_client()
            if not client:
                return self._send_json(
                    {"ok": False, "error": "LS API not configured (missing api_url or api_token)"}
                )
            result = client.ping()
            return self._send_json(result)

        # GET /api/settings — return non-sensitive settings
        if method == "GET" and path == "/api/settings":
            cfg = load_settings()
            # Never expose the API token to the browser
            safe = {
                "bridge": cfg.get("bridge", {}),
                "execution": cfg.get("execution", {}),
                "label_studio": {
                    "api_url": cfg.get("label_studio", {}).get("api_url", ""),
                    "api_token_configured": bool(cfg.get("label_studio", {}).get("api_token", "")),
                },
            }
            return self._send_json({"ok": True, "settings": safe})

        # POST /api/settings — save settings (body contains the fields to update)
        if method == "POST" and path == "/api/settings":
            cfg = load_settings()
            if body:
                for section in ("bridge", "execution"):
                    if section in body and isinstance(body[section], dict):
                        cfg.setdefault(section, {}).update(body[section])
                if "label_studio" in body and isinstance(body["label_studio"], dict):
                    ls = body["label_studio"]
                    if "api_url" in ls:
                        cfg.setdefault("label_studio", {})["api_url"] = ls["api_url"]
                    if "api_token" in ls and ls["api_token"]:
                        cfg.setdefault("label_studio", {})["api_token"] = ls["api_token"]
            save_settings(cfg)
            return self._send_json({"ok": True})

        # GET /api/templates — list all templates
        if method == "GET" and path == "/api/templates":
            tm = _get_tm()
            return self._send_json({"ok": True, "templates": tm.templates})

        # POST /api/templates — template CRUD
        # Body: { "action": "add|update|delete|move_up|move_down", "text": "...", "index": N }
        if method == "POST" and path == "/api/templates":
            tm = _get_tm()
            action = (body or {}).get("action", "")
            idx = (body or {}).get("index")

            if action == "add":
                text = (body or {}).get("text", "")
                if not text:
                    return self._send_json({"ok": False, "error": "text required"})
                tm.add(text)
                return self._send_json({"ok": True, "templates": tm.templates})

            elif action == "update":
                if idx is None:
                    return self._send_json({"ok": False, "error": "index required"})
                text = (body or {}).get("text", "")
                if not text:
                    return self._send_json({"ok": False, "error": "text required"})
                tm.update(int(idx), text)
                return self._send_json({"ok": True, "templates": tm.templates})

            elif action == "delete":
                if idx is None:
                    return self._send_json({"ok": False, "error": "index required"})
                tm.delete(int(idx))
                return self._send_json({"ok": True, "templates": tm.templates})

            elif action == "move_up":
                if idx is None:
                    return self._send_json({"ok": False, "error": "index required"})
                tm.move_up(int(idx))
                return self._send_json({"ok": True, "templates": tm.templates})

            elif action == "move_down":
                if idx is None:
                    return self._send_json({"ok": False, "error": "index required"})
                tm.move_down(int(idx))
                return self._send_json({"ok": True, "templates": tm.templates})

            else:
                return self._send_json({"ok": False, "error": f"Unknown action: {action}"})

        # GET /api/projects — list projects
        if method == "GET" and path == "/api/projects":
            client = get_ls_client()
            if not client:
                return self._send_json({"ok": False, "error": "LS API not configured"})
            page = int(query.get("page", ["1"])[0])
            page_size = int(query.get("page_size", ["50"])[0])
            data = client.list_projects(page=page, page_size=page_size)
            return self._send_json({"ok": True, "data": data})

        # GET /api/tasks — list tasks for a project
        if method == "GET" and path == "/api/tasks":
            client = get_ls_client()
            if not client:
                return self._send_json({"ok": False, "error": "LS API not configured"})
            project_id = int(query.get("project_id", ["0"])[0])
            if not project_id:
                return self._send_json({"ok": False, "error": "project_id required"})
            page = int(query.get("page", ["1"])[0])
            page_size = int(query.get("page_size", ["50"])[0])
            data = client.list_tasks(
                project_id=project_id, page=page, page_size=page_size
            )
            return self._send_json({"ok": True, "data": data})

        # GET /api/next-task — find the next uncompleted task
        if method == "GET" and path == "/api/next-task":
            client = get_ls_client()
            if not client:
                return self._send_json({"ok": False, "error": "LS API not configured"})
            project_id = int(query.get("project_id", ["0"])[0])
            current_task_id = int(query.get("current_task_id", ["0"])[0])
            if not project_id:
                return self._send_json({"ok": False, "error": "project_id required"})
            next_task = client.get_next_uncompleted_task(project_id, current_task_id)
            if next_task:
                return self._send_json(
                    {"ok": True, "next_task": next_task, "has_next": True}
                )
            return self._send_json({"ok": True, "has_next": False, "next_task": None})

        # GET /api/task/<id>/status — check if a task is completed
        # MUST come before /api/task/<id> to avoid path conflicts
        if method == "GET" and path.startswith("/api/task/") and path.endswith("/status"):
            parts = path.split("/")
            if len(parts) < 4:
                return self._send_json({"ok": False, "error": "Invalid path"})
            task_id_str = parts[3]
            if not task_id_str.isdigit():
                return self._send_json({"ok": False, "error": "Invalid task ID"})
            client = get_ls_client()
            if not client:
                return self._send_json({"ok": False, "error": "LS API not configured"})
            completed = client.get_task_completed_status(int(task_id_str))
            return self._send_json({"ok": True, "task_id": int(task_id_str), "completed": completed})

        # GET /api/task/<id> — get task details
        if method == "GET" and path.startswith("/api/task/"):
            task_id_str = path.removeprefix("/api/task/")
            if not task_id_str.isdigit():
                return self._send_json({"ok": False, "error": "Invalid task ID"})
            client = get_ls_client()
            if not client:
                return self._send_json({"ok": False, "error": "LS API not configured"})
            data = client.get_task(int(task_id_str))
            return self._send_json({"ok": True, "data": data})

        # Fallback: unknown API endpoint
        self._send_json({"ok": False, "error": f"Unknown API path: {method} {path}"}, 404)

    # ------------------------------------------------------------------
    # HTTP method handlers
    # ------------------------------------------------------------------

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._set_cors()
        self.end_headers()

    def do_GET(self) -> None:
        self._route("GET")

    def do_POST(self) -> None:
        self._route("POST")

    def do_PATCH(self) -> None:
        self._route("PATCH")


# ---------------------------------------------------------------------------
# Server wrapper
# ---------------------------------------------------------------------------

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
        self._server = BridgeHTTPServer(
            (self.host, self.port), BridgeRequestHandler, self.state, self.root_dir
        )
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def status(self) -> Dict[str, Any]:
        return self.state.status()

    def send_execute_template(
        self, remark: str, auto_submit: bool, auto_next: bool, settings: Dict[str, Any]
    ) -> str:
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


# ---------------------------------------------------------------------------
# Standalone: serve until Ctrl+C
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import signal
    import sys

    server = LocalBridgeServer()
    try:
        server.start()

        # Test LS API
        client = get_ls_client()
        ls_status = "✅ OK" if client and client.ping().get("ok") else "⚠️ 未配置"
        print(f"📡 LS API: {ls_status}")
        print(f"🔌 桥接服务: http://127.0.0.1:17892")
        print(f"   Web UI:  http://127.0.0.1:17892/web/")
        print(f"   API:     http://127.0.0.1:17892/api/ping")
        print("按 Ctrl+C 停止...")

        def handle_sigint(sig, frame):
            print("\n⏹ 正在停止...")
            server.stop()
            sys.exit(0)

        signal.signal(signal.SIGINT, handle_sigint)
        signal.pause()
    except Exception as e:
        print(f"❌ 启动失败: {e}")
        sys.exit(1)
