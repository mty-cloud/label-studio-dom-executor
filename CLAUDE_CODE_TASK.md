# Claude Code 开发任务：Label Studio DOM 桥接直接操作版

## 一、项目背景

用户在 Label Studio 中进行短视频标注。高频场景是：

```text
选项一：不符合
选项二：是/符合
备注：选择固定模板
然后 Submit 并进入下一条任务
```

旧方案经历过多个阶段：

1. Python 桌面工具 + 手动坐标校准；
2. 截图扫描状态列；
3. Bookmarklet 读取坐标；
4. marker 截图换算屏幕坐标；
5. Safari 实测仍会乱点。

当前最终方向：

> 不再使用任何屏幕坐标点击网页按钮。页面桥接脚本直接操作 Label Studio DOM。桌面工具只发送模板命令和显示日志。

## 二、强约束

必须遵守：

```text
1. 不使用 pyautogui 点击网页控件；
2. 不采集 screen 坐标；
3. 不使用 marker 截图；
4. 不手动校准坐标；
5. 不使用历史 next_row；
6. 不使用人工 row_delta_y；
7. 不刷新页面；
8. 不重新打开 URL；
9. 不调用 Label Studio API；
10. 通过页面 DOM 的真实控件完成点击和输入。
```

桌面工具保留：

```text
1. 模板管理；
2. 自动 Submit / 自动下一条开关；
3. 本地 bridge server；
4. 命令发送；
5. 结果日志。
```

页面桥接脚本负责：

```text
1. 读取当前 task_id；
2. 点击 input[name='不符合']；
3. 点击 input[name='是']；
4. 填写 textarea[name='remark']；
5. 点击 Add；
6. 点击 Submit；
7. 等待当前任务 annotations_count/completed 变成 1；
8. 找到下一任务行；
9. 点击下一任务行 DOM；
10. 返回执行结果。
```

## 三、关键文件

```text
src/main.py
- Tkinter 桌面工具
- 点击模板后调用 LocalBridgeServer.send_execute_template()

src/local_bridge_server.py
- 本地 HTTP 服务
- /bridge/register
- /bridge/heartbeat
- /bridge/command
- /bridge/result
- /bridge/ls_dom_executor_bridge.js

bridge/ls_dom_executor_bridge.js
- 核心页面桥接脚本
- executeTemplateCommand(command)
- ensureChoice()
- fillRemark()
- clickRemarkAdd()
- clickSubmit()
- waitForTaskCompleted()
- clickNextTask()

config/templates.json
- 默认备注模板

config/settings.json
- 执行开关和延时参数
```

## 四、当前 DOM 选择器依据

用户提供过 Label Studio 标注页结构：

```text
不符合：input[name='不符合']
符合：input[name='符合']
是：input[name='是']
不是：input[name='不是']
备注框：textarea[name='remark']
备注 Add：data-testid='textarea-add-button'
Submit：button[name='submit'] 或 data-testid='bottombar-submit-button'
任务行：div.lsf-table__row-wrapper
任务单元格：div.lsf-table__cell
URL：/projects/{project_id}/data?tab={tab_id}&task={task_id}
```

## 五、下一任务逻辑

提交后：

1. 读取 Submit 前的 `currentTaskId`；
2. 等待当前 task 行 `completed=1`；
3. 优先找 `taskId === currentTaskId && completed === 1` 的行；
4. 点击该行下面的下一行；
5. 如果当前 task 行找不到，则从上到下找最后一个 `completed=1` 的可见行，点击它下面的下一行；
6. 如果下一行不可见，滚动左侧列表一行后重新扫描；
7. 找不到则返回错误，不允许盲点。

## 六、需要重点测试

1. Safari 中点击 LS连接器后能否注册到桌面工具；
2. 桌面工具点击模板后，页面是否成功选择“不符合”和“是”；
3. 备注是否真正进入 Label Studio annotation，而不仅是 textarea 里显示；
4. Submit 后任务状态是否变为 1；
5. 下一任务行是否正确点击；
6. 中间人工处理特殊任务后，下一次模板执行是否仍按当前页面状态工作。

## 七、明确禁止回退

不要把项目改回以下方案：

```text
- 坐标采集版；
- pyautogui 点击控件版；
- marker 截图换算坐标版；
- DOM 只读取坐标，桌面端点击坐标版。
```

当前正确方向是：

```text
桌面端发命令；页面桥接脚本直接 DOM 操作。
```


## 2026-07 修复说明：下一任务逻辑

当前版本的下一任务逻辑已改为：Submit 后等待页面状态更新，然后从当前可见任务列表自上而下扫描，点击第一个 completed/annotations_count 为 0 的任务行。桌面端超时时间已提升到 30 秒。严格不要恢复坐标点击、历史 next_row 或 row_delta_y 递推。
