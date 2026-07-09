"""
Label Studio DOM Executor — 纯服务端入口

适用于：
- Windows 打包（PyInstaller 单文件 .exe）
- 不想依赖 Tkinter 的用户
- 纯 Web UI 模式（浏览器操作）

启动后：
1. 运行桥接 HTTP 服务器
2. 自动打开 Web UI (http://127.0.0.1:17892/web/)
3. 按 Ctrl+C 停止
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
import webbrowser
from pathlib import Path


def _resource_base() -> Path:
    """返回项目资源根目录，支持开发模式和 PyInstaller 打包模式。"""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parents[1]


ROOT_DIR = _resource_base()
_src_dir = str(Path(__file__).resolve().parent)
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

from local_bridge_server import LocalBridgeServer, get_ls_client


def print_banner() -> None:
    print("""
╔══════════════════════════════════════════════════╗
║       🚀 LS 标注助手 — 服务已启动              ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║   🌐 Web UI:  http://127.0.0.1:17892/web/       ║
║                                                  ║
║   使用步骤：                                     ║
║   1. 在浏览器打开上方地址                        ║
║   2. 在 LS 标注页点击书签「LS连接器」            ║
║   3. 在 Web UI 中点模板按钮即可执行             ║
║                                                  ║
║   按 Ctrl+C 停止服务                             ║
║                                                  ║
╚══════════════════════════════════════════════════╝
    """)


def main() -> None:
    # 加载设置
    settings_path = ROOT_DIR / "config" / "settings.json"
    settings = {}
    if settings_path.exists():
        settings = json.loads(settings_path.read_text(encoding="utf-8"))

    bridge_cfg = settings.get("bridge", {})
    host = bridge_cfg.get("host", "127.0.0.1")
    port = int(bridge_cfg.get("port", 17892))

    # 启动桥接服务器
    server = LocalBridgeServer(host=host, port=port, root_dir=ROOT_DIR)
    try:
        server.start()
    except OSError as e:
        print(f"❌ 启动失败（端口 {port} 被占用？）: {e}")
        print(f"   请检查是否已有实例在运行。")
        input("按 Enter 退出...")
        sys.exit(1)

    # 测试 LS API 连通性
    client = get_ls_client()
    if client:
        result = client.ping()
        if result.get("ok"):
            count = result.get("data", {}).get("count", 0)
            print(f"📡 LS API: ✅ 已连接（{count} 个项目）")
        else:
            print(f"📡 LS API: ⚠️  {result.get('error', '未知错误')}")
    else:
        print(f"📡 LS API: ⚠️  未配置（请在 Web UI 设置中填入 LS 地址和 Token）")

    # 显示启动信息
    print_banner()

    # 自动打开 Web UI
    web_url = f"http://{host}:{port}/web/"
    print(f"   正在打开浏览器: {web_url}")
    webbrowser.open(web_url)

    # 等待退出信号
    shutdown_event = threading.Event()

    def handle_signal(sig, frame):
        print("\n⏹  正在停止服务...")
        server.stop()
        shutdown_event.set()
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        shutdown_event.wait()
    except KeyboardInterrupt:
        handle_signal(None, None)


if __name__ == "__main__":
    import threading
    main()
