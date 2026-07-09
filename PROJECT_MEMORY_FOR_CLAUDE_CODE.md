# 项目记忆文档：Label Studio 模板助手

## 当前最终版本

项目名称：`label_studio_dom_bridge_executor`

当前方向：**页面桥接脚本直接操作 DOM**。

用户已经明确放弃以下方案：

- 纯坐标点击；
- 手动坐标采集；
- 截图扫描；
- marker 换算屏幕坐标；
- pyautogui 操作网页控件；
- 读取坐标后再由桌面端点击。

原因：Safari 实测坐标点击会乱点，受工具栏、缩放、Retina、窗口位置影响。

## 业务流程

标注员看视频，如果属于高频不符合情况，点击桌面工具中的备注模板。系统自动完成：

```text
不符合 → 是/符合 → 填备注 → Add → Submit → 下一条任务
```

## 技术架构

```text
桌面 Tkinter 工具
    ↓ 发送 execute_template 命令
本地 HTTP bridge server: 127.0.0.1:17892
    ↓ browser polling
Label Studio 页面内 bridge/ls_dom_executor_bridge.js
    ↓ 直接操作 DOM
Label Studio 控件和任务行
```

## 用户使用流程

1. 启动桌面工具；
2. 在浏览器打开 `install_bookmarklet.html`；
3. 把 LS连接器拖到收藏栏；
4. 打开 Label Studio 具体任务页；
5. 点击收藏栏 LS连接器；
6. 桌面工具显示已连接；
7. 点击备注模板执行。

## 核心文件

- `src/main.py`：桌面 GUI；
- `src/local_bridge_server.py`：本地服务和命令队列；
- `src/template_manager.py`：模板增删改；
- `bridge/ls_dom_executor_bridge.js`：核心 DOM 操作脚本；
- `bridge/bookmarklet.txt`：LS连接器书签；
- `install_bookmarklet.html`：安装页面；
- `config/templates.json`：备注模板；
- `config/settings.json`：执行参数。

## Label Studio 页面关键结构

- `input[name='不符合']`
- `input[name='符合']`
- `input[name='是']`
- `input[name='不是']`
- `textarea[name='remark']`
- `[data-testid='textarea-add-button']`
- `button[name='submit']`
- `div.lsf-table__row-wrapper`
- `div.lsf-table__cell`
- URL 参数 `task={task_id}`

## 当前版本必须保持的原则

1. 桌面端不点击网页坐标；
2. 所有网页操作都在桥接脚本内用 DOM 完成；
3. 不刷新页面；
4. 不重新打开 URL；
5. Submit 后必须等待状态变成 1；
6. 下一任务必须根据当前页面真实任务行决定；
7. 桥接失败或找不到元素时停止并报错。

## 给 Claude Code 的启动指令

```text
请先阅读 PROJECT_MEMORY_FOR_CLAUDE_CODE.md 和 CLAUDE_CODE_TASK.md。
当前版本是 DOM Bridge 直接操作版，不要恢复坐标点击、marker、pyautogui 或手动校准方案。
重点检查 bridge/ls_dom_executor_bridge.js 的 executeTemplateCommand 和下一任务定位逻辑。
```


## 2026-07 修复说明：下一任务逻辑

当前版本的下一任务逻辑已改为：Submit 后等待页面状态更新，然后从当前可见任务列表自上而下扫描，点击第一个 completed/annotations_count 为 0 的任务行。桌面端超时时间已提升到 30 秒。严格不要恢复坐标点击、历史 next_row 或 row_delta_y 递推。
