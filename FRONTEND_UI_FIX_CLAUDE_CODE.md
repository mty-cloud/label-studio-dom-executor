# Label Studio DOM 模板助手 — 前端 UI 修复说明（给 Claude Code）

## 0. 背景

当前项目为 `label_studio_dom_bridge_executor_first`，桌面端使用 Tkinter GUI，页面操作由浏览器内的 DOM Bridge 完成。当前问题集中在桌面端前端 UI：

1. 右侧“快速选择”圆形按钮显示混乱；
2. 圆形按钮出现白色/浅色背景块，和 macOS 深色窗口、`ttk.LabelFrame` 背景不一致；
3. 右侧区域过窄，圆形按钮被裁切，只能看到一部分蓝色圆；
4. `RoundTemplateButton(tk.Canvas)` 视觉不稳定，在 macOS/Safari 使用场景下不适合业务人员；
5. 当前前端看起来复杂，不利于业务人员快速点击模板。

本次只修复 **桌面 GUI 前端布局与按钮组件**。不要改 DOM Bridge 执行逻辑，不要恢复坐标点击、pyautogui、截图 marker、手动校准等旧方案。

---

## 1. 根因分析

当前代码中使用了 `RoundTemplateButton(tk.Canvas)` 绘制圆形按钮。这个方案在 Tkinter/ttk 混合布局中不稳定：

- `ttk.Frame` / `ttk.LabelFrame` 的背景由系统主题管理，`tk.Canvas` 的背景需要手动指定，很容易出现白块；
- macOS 深色模式下，`ttk` 和 `tk` 控件颜色不一致；
- 圆形按钮宽高固定，但右侧“快速选择”区域宽度不足，导致按钮被裁切；
- 当前 `middle` 区域左右都使用 `pack(side=tk.LEFT, fill=tk.BOTH, expand=True)`，左侧模板列表和右侧快速按钮同时扩展，窗口尺寸较小时右侧会被挤压；
- 圆形按钮只显示前 2-3 个字，业务人员不一定能快速理解，实际效率不如完整文字按钮。

结论：**不要继续修 RoundTemplateButton。直接删除圆形按钮组件，改为稳定的矩形模板按钮。**

---

## 2. 修改目标

请把右侧“快速选择”区域改成：

- 使用 **矩形按钮**，显示完整模板文字；
- 支持自动换行/固定高度；
- 按钮一列或两列排列，不裁切；
- 支持滚动，模板多时不挤压；
- 颜色统一、不要出现白色 Canvas 块；
- 保持左侧“模板管理”功能不变；
- 保持执行逻辑 `_execute_template()` 不变。

建议最终界面结构：

```text
顶部：连接状态 + 复制说明
执行模式：自动 Submit / 自动下一任务
主体：
  左侧：模板管理 Listbox + 新增/修改/删除/上移/下移
  右侧：快速执行按钮区（矩形按钮，可滚动）
底部：日志
```

---

## 3. 必须删除/禁用的旧前端组件

删除或不再使用：

```python
class RoundTemplateButton(tk.Canvas):
    ...
```

删除原因：

- Canvas 背景与 ttk 容器背景不一致；
- 圆形按钮在 macOS 深色模式下表现差；
- 圆形按钮被裁切；
- 简称按钮不适合业务人员。

如果暂时不删除，也必须保证 `_build_quick_buttons()` 不再实例化 `RoundTemplateButton`。

---

## 4. 新增稳定按钮组件

建议新增一个简单的矩形按钮组件，不使用 Canvas。

```python
class QuickTemplateButton(tk.Button):
    """稳定的矩形模板按钮：显示完整备注，点击即执行。"""

    def __init__(self, master, text: str, command=None):
        super().__init__(
            master,
            text=text,
            command=command,
            anchor="w",
            justify="left",
            wraplength=220,
            padx=12,
            pady=8,
            relief=tk.FLAT,
            bd=0,
            cursor="hand2",
            bg="#2563eb",
            fg="#ffffff",
            activebackground="#1d4ed8",
            activeforeground="#ffffff",
            font=("PingFang SC", 11, "bold"),
        )
        self._normal_bg = "#2563eb"
        self._hover_bg = "#3b82f6"
        self.bind("<Enter>", lambda _e: self.configure(bg=self._hover_bg))
        self.bind("<Leave>", lambda _e: self.configure(bg=self._normal_bg))
```

说明：

- 这里使用 `tk.Button` 而不是 `ttk.Button`，因为 macOS 下 `ttk.Button` 很难稳定控制按钮背景色；
- 显示完整模板文本，避免简称误解；
- `wraplength=220` 可根据右侧区域宽度微调。

---

## 5. 新增可滚动区域组件

右侧快速按钮需要支持模板数量增加，因此建议新增 `ScrollableFrame`。

```python
class ScrollableFrame(ttk.Frame):
    """可滚动 Frame，用于右侧快速模板按钮区。"""

    def __init__(self, master, *args, **kwargs):
        super().__init__(master, *args, **kwargs)

        self.canvas = tk.Canvas(
            self,
            highlightthickness=0,
            bd=0,
            bg="#f6f7fb",
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

        self.window_id = self.canvas.create_window((0, 0), window=self.inner, anchor="nw")
        self.canvas.configure(yscrollcommand=self.scrollbar.set)

        self.canvas.pack(side="left", fill="both", expand=True)
        self.scrollbar.pack(side="right", fill="y")

        self.canvas.bind(
            "<Configure>",
            lambda e: self.canvas.itemconfig(self.window_id, width=e.width),
        )
```

注意：这里的 Canvas 只用于滚动容器，不画按钮。背景统一设为浅色，避免白块。

---

## 6. 建议统一窗口主题

当前截图显示 macOS 深色窗口中混入浅色/白色块。为了稳定，建议桌面工具强制使用浅色主题。

在 `LabelStudioDomExecutorApp.__init__()` 中，`self._build_ui()` 前调用：

```python
def _setup_style(self) -> None:
    self.APP_BG = "#f6f7fb"
    self.PANEL_BG = "#ffffff"
    self.TEXT_FG = "#111827"
    self.MUTED_FG = "#6b7280"

    self.configure(bg=self.APP_BG)

    style = ttk.Style(self)
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass

    style.configure("TFrame", background=self.APP_BG)
    style.configure("TLabelframe", background=self.APP_BG)
    style.configure("TLabelframe.Label", background=self.APP_BG, foreground=self.TEXT_FG)
    style.configure("TLabel", background=self.APP_BG, foreground=self.TEXT_FG)
    style.configure("TCheckbutton", background=self.APP_BG, foreground=self.TEXT_FG)
    style.configure("TButton", padding=(10, 5))
```

然后在 `__init__()` 里：

```python
self._setup_style()
self._build_ui()
```

---

## 7. 修改主窗口尺寸

当前 `760x650` 太窄，右侧快速区容易被挤压。改成：

```python
self.geometry("980x720")
self.minsize(900, 620)
```

---

## 8. 重构 `_build_ui()` 中主体布局

不要再用左右两个 `pack(side=tk.LEFT, expand=True)` 平分空间。建议用 `grid`，明确左侧大、右侧固定宽度。

替换 `middle` 后半部分布局：

```python
middle = ttk.Frame(self, padding=(10, 0, 10, 8))
middle.pack(fill=tk.BOTH, expand=True)
middle.columnconfigure(0, weight=1)
middle.columnconfigure(1, weight=0)
middle.rowconfigure(0, weight=1)

left = ttk.LabelFrame(middle, text="模板管理", padding=8)
left.grid(row=0, column=0, sticky="nsew", padx=(0, 8))

right = ttk.LabelFrame(middle, text="快速执行", padding=8)
right.grid(row=0, column=1, sticky="ns")
right.configure(width=280)
right.grid_propagate(False)

self.quick_scroll = ScrollableFrame(right)
self.quick_scroll.pack(fill=tk.BOTH, expand=True)
self.quick_frame = self.quick_scroll.inner
```

目的：

- 左侧模板管理可以扩展；
- 右侧快速执行固定宽度，不再被挤压变形；
- 模板多时右侧内部滚动。

---

## 9. 修改 `_build_quick_buttons()`

替换为矩形按钮版本：

```python
def _build_quick_buttons(self) -> None:
    """重新构建右侧快速模板按钮。"""
    for w in self.quick_frame.winfo_children():
        w.destroy()

    templates = self.template_manager.templates

    if not templates:
        empty = ttk.Label(
            self.quick_frame,
            text="暂无模板\n请在左侧添加备注模板",
            foreground="#9ca3af",
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
```

不要再使用：

```python
cols = 3
btn.grid(...)
RoundTemplateButton(...)
```

原因：固定 3 列在右侧窄区域会裁切；一列全宽按钮更适合业务人员快速点选。

---

## 10. 优化左侧模板列表视觉

建议给 `Listbox` 明确颜色和字体，避免深色模式下混乱：

```python
self.template_list = tk.Listbox(
    left,
    height=14,
    font=("PingFang SC", 11),
    bg="#ffffff",
    fg="#111827",
    selectbackground="#2563eb",
    selectforeground="#ffffff",
    activestyle="none",
    relief=tk.SOLID,
    bd=1,
)
```

底部日志同理：

```python
self.log_text = tk.Text(
    log_frame,
    height=7,
    wrap=tk.WORD,
    font=("Menlo", 10),
    bg="#111827",
    fg="#e5e7eb",
    insertbackground="#ffffff",
    relief=tk.FLAT,
)
```

---

## 11. 保持不变的业务逻辑

以下逻辑不要改：

```python
_execute_template()
_wait_command_result()
_refresh_status_loop()
_start_server()
TemplateManager
LocalBridgeServer
```

除非需要适配新的 UI 控件命名，否则不要动执行链路。

本次只修前端显示。

---

## 12. 验收标准

修复后必须满足：

1. 右侧不再出现蓝色圆形残缺/被裁切；
2. 不再出现明显白色 Canvas 背景块；
3. 快速按钮显示完整模板文本；
4. 右侧模板多时可以滚动；
5. 窗口缩放时按钮不乱跑、不重叠、不裁切；
6. 左侧模板管理功能正常：新增、修改、删除、上移、下移；
7. 点击右侧任意模板按钮仍然调用 `_execute_template(text)`；
8. 日志区正常输出；
9. 不引入 pyautogui、坐标点击、截图 marker、手动坐标采集等旧逻辑；
10. macOS Safari 使用场景下界面干净、可读、业务人员容易理解。

---

## 13. 推荐的最终视觉方向

不要追求圆形按钮。当前项目是给标注员高频作业使用，核心是稳定和易点：

```text
[说话内容有误]
[镜头分割有误]
[是否人物可见：是]
[是否人物可见：否]
[丢弃]
[有不确定字段（人物不可见）]
...
```

一列大按钮比 3 列圆形按钮更适合当前业务。

