from __future__ import annotations

import json
import queue
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, simpledialog, ttk

from local_bridge_server import LocalBridgeServer
from template_manager import TemplateManager


def _resource_base() -> Path:
    """返回项目资源根目录，同时支持开发模式和 PyInstaller 打包模式。"""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parents[1]


ROOT_DIR = _resource_base()
CONFIG_DIR = ROOT_DIR / "config"
SETTINGS_PATH = CONFIG_DIR / "settings.json"
TEMPLATES_PATH = CONFIG_DIR / "templates.json"


APP_BG = "#f5f5f0"
PANEL_BG = "#fafaf8"
PRIMARY = "#1a7a5a"
PRIMARY_HOVER = "#219d73"
PRIMARY_ACTIVE = "#136147"
TEXT_FG = "#1c1c1a"
MUTED_FG = "#7a7a72"


def load_settings() -> dict:
    if SETTINGS_PATH.exists():
        return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    return {
        "bridge": {"host": "127.0.0.1", "port": 17892, "command_timeout_ms": 12000},
        "execution": {"auto_submit": True, "auto_next": True},
    }


# --------------------------------------------------------------------------
# 组件：矩形模板按钮
# --------------------------------------------------------------------------

class QuickTemplateButton(tk.Button):
    """稳定的矩形模板按钮，显示完整备注文本，点击即执行。"""

    def __init__(self, master, text: str, command=None):
        super().__init__(
            master,
            text=text,
            command=command,
            anchor="w",
            justify="left",
            wraplength=240,
            padx=14,
            pady=10,
            relief=tk.FLAT,
            bd=0,
            cursor="hand2",
            bg=PRIMARY,
            fg="#ffffff",
            activebackground=PRIMARY_ACTIVE,
            activeforeground="#ffffff",
            font=("PingFang SC", 11, "bold"),
        )
        self._normal_bg = PRIMARY
        self._hover_bg = PRIMARY_HOVER
        self.bind("<Enter>", lambda _e: self.configure(bg=self._hover_bg))
        self.bind("<Leave>", lambda _e: self.configure(bg=self._normal_bg))


# --------------------------------------------------------------------------
# 组件：可滚动 Frame
# --------------------------------------------------------------------------

class ScrollableFrame(ttk.Frame):
    """内部使用 Canvas 实现滚动的 Frame，用于右侧快速按钮列表。"""

    def __init__(self, master, *args, **kwargs):
        super().__init__(master, *args, **kwargs)

        self.canvas = tk.Canvas(
            self,
            highlightthickness=0,
            bd=0,
            bg=PANEL_BG,
        )
        self.scrollbar = ttk.Scrollbar(
            self,
            orient="vertical",
            command=self.canvas.yview,
        )
        self.inner = ttk.Frame(self.canvas)

        self.inner.bind(
            "<Configure>",
            lambda _e: self.canvas.configure(scrollregion=self.canvas.bbox("all")),
        )

        self.window_id = self.canvas.create_window(
            (0, 0), window=self.inner, anchor="nw"
        )
        self.canvas.configure(yscrollcommand=self.scrollbar.set)

        self.canvas.pack(side="left", fill="both", expand=True)
        self.scrollbar.pack(side="right", fill="y")

        self.canvas.bind(
            "<Configure>",
            lambda e: self.canvas.itemconfig(self.window_id, width=e.width),
        )


# --------------------------------------------------------------------------
# 主应用
# --------------------------------------------------------------------------

class LabelStudioDomExecutorApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Label Studio DOM 模板助手")
        self.geometry("980x720")
        self.minsize(900, 620)

        self.settings = load_settings()
        bridge_cfg = self.settings.get("bridge", {})
        self.bridge_server = LocalBridgeServer(
            host=bridge_cfg.get("host", "127.0.0.1"),
            port=int(bridge_cfg.get("port", 17892)),
            root_dir=ROOT_DIR,
        )
        self.template_manager = TemplateManager(TEMPLATES_PATH)
        self.log_queue: queue.Queue[str] = queue.Queue()

        self.auto_submit_var = tk.BooleanVar(
            value=bool(self.settings.get("execution", {}).get("auto_submit", True))
        )
        self.auto_next_var = tk.BooleanVar(
            value=bool(self.settings.get("execution", {}).get("auto_next", True))
        )

        self._setup_style()
        self._build_ui()
        self._start_server()
        self.after(300, self._refresh_status_loop)
        self.after(200, self._drain_logs)

    # ===================== 统一主题 =====================

    def _setup_style(self) -> None:
        self.configure(bg=APP_BG)

        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass

        style.configure("TFrame", background=APP_BG)
        style.configure("TLabelframe", background=APP_BG)
        style.configure("TLabelframe.Label", background=APP_BG, foreground=TEXT_FG)
        style.configure("TLabel", background=APP_BG, foreground=TEXT_FG)
        style.configure("TCheckbutton", background=APP_BG, foreground=TEXT_FG)
        style.configure("TButton", padding=(10, 5))

    # ===================== 界面布局 =====================

    def _build_ui(self) -> None:
        # ---- 顶部：状态 + 安装说明 ----
        top = ttk.Frame(self, padding=10)
        top.pack(fill=tk.X)

        self.status_var = tk.StringVar(value="桥接状态：未连接")
        ttk.Label(top, textvariable=self.status_var, font=("Arial", 12, "bold")).pack(
            side=tk.LEFT
        )
        ttk.Button(
            top, text="复制书签安装说明", command=self._show_bookmarklet_help
        ).pack(side=tk.RIGHT)

        # ---- 执行模式选项 ----
        opts = ttk.LabelFrame(self, text="执行模式", padding=10)
        opts.pack(fill=tk.X, padx=10, pady=(0, 8))
        ttk.Checkbutton(
            opts, text="自动 Submit", variable=self.auto_submit_var
        ).pack(side=tk.LEFT, padx=(0, 20))
        ttk.Checkbutton(
            opts, text="Submit 后自动进入下一任务", variable=self.auto_next_var
        ).pack(side=tk.LEFT)
        ttk.Label(
            opts,
            text="说明：网页操作由 LS连接器在页面内部完成，不使用坐标点击。",
            foreground="#555",
        ).pack(side=tk.LEFT, padx=20)

        # ---- 主体：左侧模板管理 + 右侧快速执行 ----
        middle = ttk.Frame(self, padding=(10, 0, 10, 8))
        middle.pack(fill=tk.BOTH, expand=True)
        middle.columnconfigure(0, weight=1)
        middle.columnconfigure(1, weight=0)
        middle.rowconfigure(0, weight=1)

        # --- 左侧面板 ---
        left = ttk.LabelFrame(middle, text="模板管理", padding=8)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 8))
        left.columnconfigure(0, weight=1)
        left.rowconfigure(0, weight=1)

        self.template_list = tk.Listbox(
            left,
            height=14,
            font=("PingFang SC", 11),
            bg=PANEL_BG,
            fg=TEXT_FG,
            selectbackground=PRIMARY,
            selectforeground="#ffffff",
            activestyle="none",
            relief=tk.SOLID,
            bd=1,
        )
        self.template_list.grid(row=0, column=0, sticky="nsew")
        self.template_list.bind(
            "<Double-Button-1>", lambda e: self._execute_selected_template()
        )
        self._reload_template_list()

        btn_row = ttk.Frame(left)
        btn_row.grid(row=1, column=0, sticky="ew", pady=(8, 0))
        ttk.Button(
            btn_row,
            text="执行选中模板",
            command=self._execute_selected_template,
        ).pack(side=tk.LEFT, padx=(0, 6))
        ttk.Button(btn_row, text="新增", command=self._add_template).pack(
            side=tk.LEFT, padx=3
        )
        ttk.Button(btn_row, text="修改", command=self._edit_template).pack(
            side=tk.LEFT, padx=3
        )
        ttk.Button(btn_row, text="删除", command=self._delete_template).pack(
            side=tk.LEFT, padx=3
        )
        ttk.Button(btn_row, text="上移", command=self._move_up).pack(
            side=tk.LEFT, padx=3
        )
        ttk.Button(btn_row, text="下移", command=self._move_down).pack(
            side=tk.LEFT, padx=3
        )

        # --- 右侧面板 ---
        right = ttk.LabelFrame(middle, text="快速执行", padding=8)
        right.grid(row=0, column=1, sticky="ns")
        right.configure(width=290)
        right.grid_propagate(False)
        right.rowconfigure(0, weight=1)
        right.columnconfigure(0, weight=1)

        self.quick_scroll = ScrollableFrame(right)
        self.quick_scroll.grid(row=0, column=0, sticky="nsew")
        self.quick_frame = self.quick_scroll.inner
        self._build_quick_buttons()

        # ---- 底部日志 ----
        log_frame = ttk.LabelFrame(self, text="日志", padding=8)
        log_frame.pack(fill=tk.BOTH, expand=False, padx=10, pady=(0, 10))

        self.log_text = tk.Text(
            log_frame,
            height=7,
            wrap=tk.WORD,
            font=("Menlo", 10),
            bg="#1e2a25",
            fg="#c4d4cc",
            insertbackground="#ffffff",
            relief=tk.FLAT,
        )
        self.log_text.pack(fill=tk.BOTH, expand=True)

    # ===================== 服务启动 =====================

    def _start_server(self) -> None:
        try:
            self.bridge_server.start()
            cfg = self.settings.get("bridge", {})
            self._log(
                f"本地桥接服务已启动：http://{cfg.get('host', '127.0.0.1')}:{cfg.get('port', 17892)}"
            )
            self._log("请在 Label Studio 任务页点击浏览器收藏栏里的『LS连接器』。")
        except OSError as e:
            messagebox.showerror("启动失败", f"本地桥接服务启动失败：{e}")
            raise

    def _show_bookmarklet_help(self) -> None:
        messagebox.showinfo(
            "LS连接器安装说明",
            "1. 打开项目里的 install_bookmarklet.html\n"
            "2. 将页面中的『LS连接器』拖到浏览器收藏栏\n"
            "3. 打开 Label Studio 具体任务页\n"
            "4. 点击收藏栏『LS连接器』，桌面工具显示已连接后即可使用。",
        )

    # ===================== 模板列表 =====================

    def _reload_template_list(self, select_index: int | None = None) -> None:
        self.template_list.delete(0, tk.END)
        for item in self.template_manager.templates:
            self.template_list.insert(tk.END, item)
        if select_index is not None and self.template_manager.templates:
            self.template_list.selection_set(
                max(0, min(select_index, len(self.template_manager.templates) - 1))
            )

    # ===================== 快速按钮 =====================

    def _build_quick_buttons(self) -> None:
        """重新构建右侧矩形模板按钮列表。"""
        for w in self.quick_frame.winfo_children():
            w.destroy()

        templates = self.template_manager.templates

        if not templates:
            empty = ttk.Label(
                self.quick_frame,
                text="暂无模板\n请在左侧添加备注模板",
                foreground=MUTED_FG,
                justify="center",
                padding=20,
            )
            empty.pack(fill=tk.BOTH, expand=True)
            return

        for text in templates:
            btn = QuickTemplateButton(
                self.quick_frame,
                text=text,
                command=lambda t=text: self._execute_template(t),
            )
            btn.pack(fill=tk.X, padx=4, pady=5)

    # ===================== 模板管理操作 =====================

    def _get_selected_index(self) -> int | None:
        sel = self.template_list.curselection()
        if not sel:
            return None
        return int(sel[0])

    def _execute_selected_template(self) -> None:
        idx = self._get_selected_index()
        if idx is None:
            messagebox.showwarning("未选择模板", "请先选择一个备注模板。")
            return
        self._execute_template(self.template_manager.templates[idx])

    def _add_template(self) -> None:
        text = simpledialog.askstring("新增模板", "请输入备注模板：", parent=self)
        if text:
            self.template_manager.add(text)
            self._reload_template_list(len(self.template_manager.templates) - 1)
            self._build_quick_buttons()

    def _edit_template(self) -> None:
        idx = self._get_selected_index()
        if idx is None:
            return
        old = self.template_manager.templates[idx]
        text = simpledialog.askstring(
            "修改模板", "请输入备注模板：", initialvalue=old, parent=self
        )
        if text:
            self.template_manager.update(idx, text)
            self._reload_template_list(idx)
            self._build_quick_buttons()

    def _delete_template(self) -> None:
        idx = self._get_selected_index()
        if idx is None:
            return
        if messagebox.askyesno(
            "确认删除", f"删除模板：{self.template_manager.templates[idx]}？"
        ):
            self.template_manager.delete(idx)
            self._reload_template_list(
                min(idx, len(self.template_manager.templates) - 1)
            )
            self._build_quick_buttons()

    def _move_up(self) -> None:
        idx = self._get_selected_index()
        if idx is None:
            return
        new_idx = self.template_manager.move_up(idx)
        self._reload_template_list(new_idx)
        self._build_quick_buttons()

    def _move_down(self) -> None:
        idx = self._get_selected_index()
        if idx is None:
            return
        new_idx = self.template_manager.move_down(idx)
        self._reload_template_list(new_idx)
        self._build_quick_buttons()

    # ===================== 模板执行（保持不变） =====================

    def _execute_template(self, remark: str) -> None:
        status = self.bridge_server.status()
        if not status.get("connected"):
            messagebox.showwarning(
                "页面未连接",
                "请先在 Label Studio 任务页点击浏览器收藏栏里的『LS连接器』。",
            )
            self._log("执行取消：页面未连接。")
            return

        self._log(f"开始执行模板：{remark}")
        settings = dict(self.settings)
        settings.setdefault("execution", {})
        settings["execution"]["auto_submit"] = self.auto_submit_var.get()
        settings["execution"]["auto_next"] = self.auto_next_var.get()

        command_id = self.bridge_server.send_execute_template(
            remark=remark,
            auto_submit=self.auto_submit_var.get(),
            auto_next=self.auto_next_var.get(),
            settings=settings,
        )
        timeout_ms = int(
            self.settings.get("bridge", {}).get("command_timeout_ms", 12000)
        )
        threading.Thread(
            target=self._wait_command_result, args=(command_id, timeout_ms), daemon=True
        ).start()

    def _wait_command_result(self, command_id: str, timeout_ms: int) -> None:
        try:
            result = self.bridge_server.wait_result(command_id, timeout_ms=timeout_ms)
            if result.get("ok"):
                detail = result.get("result", {})
                self._log(detail.get("message") or "执行完成。")
            else:
                self._log("执行失败：" + str(result.get("error") or result))
        except Exception as e:
            self._log(f"执行失败：{e}")

    # ===================== 状态 & 日志 =====================

    def _refresh_status_loop(self) -> None:
        status = self.bridge_server.status()
        if status.get("connected"):
            self.status_var.set(
                f"桥接状态：已连接 | task_id={status.get('taskId') or '-'}"
            )
        else:
            self.status_var.set(
                "桥接状态：未连接，请在 Label Studio 页面点击 LS连接器"
            )
        self.after(1000, self._refresh_status_loop)

    def _log(self, msg: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self.log_queue.put(f"[{stamp}] {msg}")

    def _drain_logs(self) -> None:
        try:
            while True:
                msg = self.log_queue.get_nowait()
                self.log_text.insert(tk.END, msg + "\n")
                self.log_text.see(tk.END)
        except queue.Empty:
            pass
        self.after(200, self._drain_logs)

    def destroy(self) -> None:
        try:
            self.bridge_server.stop()
        finally:
            super().destroy()


if __name__ == "__main__":
    app = LabelStudioDomExecutorApp()
    app.mainloop()
