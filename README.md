# Label Studio DOM 模板助手（页面桥接直接操作版）

本项目用于 Label Studio 高频“不符合”场景的半自动化标注。当前版本已经彻底放弃屏幕坐标、截图 marker、pyautogui 点击网页按钮等方案，改为：

> 桌面工具只负责展示备注模板和发送命令；浏览器页面里的 LS 连接器直接操作 Label Studio DOM 按钮。

## 核心流程

业务员点击桌面工具中的备注模板后：

1. 桌面工具向页面桥接脚本发送 `execute_template` 命令；
2. 页面桥接脚本直接在 Label Studio 页面内部执行：
   - 点击 `input[name='不符合']` 或其外层 label；
   - 点击 `input[name='是']` 或其外层 label；
   - 写入 `textarea[name='remark']`；
   - 触发 `input/change` 事件；
   - 点击备注 Add 按钮，失败则模拟 Shift+Enter；
   - 点击 Submit；
   - 等待当前 task 状态变为 `completed=1`；
   - 点击当前完成任务下面的真实下一任务行。
3. 页面桥接脚本将执行结果返回给桌面工具。

## 目录结构

```text
label_studio_dom_bridge_executor/
├── README.md
├── CLAUDE_CODE_TASK.md
├── PROJECT_MEMORY_FOR_CLAUDE_CODE.md
├── STAFF_QUICK_START.md
├── install_bookmarklet.html
├── requirements.txt
├── run_mac_linux.sh
├── run_windows.bat
├── config/
│   ├── settings.json
│   └── templates.json
├── src/
│   ├── main.py
│   ├── local_bridge_server.py
│   └── template_manager.py
└── bridge/
    ├── bookmarklet.txt
    └── ls_dom_executor_bridge.js
```

## 使用步骤

### 1. 启动桌面工具

Mac/Linux：

```bash
bash run_mac_linux.sh
```

Windows：

```bat
run_windows.bat
```

启动后，本地服务会监听：

```text
http://127.0.0.1:17892
```

### 2. 安装 LS连接器书签

用浏览器打开：

```text
install_bookmarklet.html
```

把页面里的 **LS连接器** 拖到浏览器收藏栏。Safari 需要先打开：

```text
显示 → 显示个人收藏栏
```

### 3. 连接 Label Studio 页面

打开 Label Studio 的具体任务页，例如：

```text
/projects/3920/data?tab=2838&task=587521
```

点击收藏栏里的 **LS连接器**。桌面工具显示“已连接”后即可开始使用。

### 4. 执行模板

业务员人眼看视频，遇到高频不符合问题时，点击桌面工具中的备注模板按钮。页面桥接脚本会直接完成选择、备注、提交、下一条。

## 重要设计边界

当前版本不使用：

- 手动坐标校准；
- 屏幕截图 marker；
- `pyautogui` 点击网页按钮；
- 历史 `next_row` 坐标；
- 人工 `row_delta_y`；
- Label Studio API；
- 刷新页面或重新打开 URL。

当前版本使用：

- 浏览器 Bookmarklet 注入桥接脚本；
- JS DOM click/input/change；
- 本地 HTTP 服务传递命令和结果；
- 桌面 Tkinter 工具管理模板。

## 故障排查

### 桌面工具显示未连接

1. 确认桌面工具已启动；
2. 确认当前浏览器页面是具体 task 标注页；
3. 再点一次收藏栏里的 LS连接器。

### 点击模板后没有反应

查看桌面工具日志和浏览器 Console。常见原因：

- Label Studio DOM 选择器变化；
- 当前页面不是任务页；
- Safari 或浏览器阻止本地 `127.0.0.1` 请求；
- Submit 按钮不可用；
- 左侧任务列表未显示。

### 找不到下一条

桥接脚本会先找当前 `task_id` 对应的完成行，再找最后一个 `completed=1` 的可见行。如果列表底部下一行不可见，会滚动一行后重试。若仍找不到，会停止并返回错误，不会盲点。


## 2026-07 修复说明：下一任务逻辑

当前版本的下一任务逻辑已改为：Submit 后等待页面状态更新，然后从当前可见任务列表自上而下扫描，点击第一个 completed/annotations_count 为 0 的任务行。桌面端超时时间已提升到 30 秒。严格不要恢复坐标点击、历史 next_row 或 row_delta_y 递推。

## GitHub / 下载 Windows EXE

```text
远程仓库：https://github.com/mty-cloud/label-studio-dom-executor
```

每次推送到 `main` 分支，GitHub Actions 会自动编译成 `.exe` 文件：

1. 打开 https://github.com/mty-cloud/label-studio-dom-executor/actions
2. 点击最新一次成功的工作流
3. 在页面底部找到 **Artifacts**，点击下载 `LabelStudio助手-Windows-x64.zip`
4. 解压后运行 `LabelStudio助手.exe`

要创建发行版（Release）版本，打 tag 推送：
```bash
git tag v1.0.0
git push origin v1.0.0
```
