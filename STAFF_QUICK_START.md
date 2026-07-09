# 业务员快速使用说明

## 第一次使用

1. 运行桌面工具：
   - Windows：双击 `run_windows.bat`
   - Mac：运行 `bash run_mac_linux.sh`
2. 用 Safari/Chrome 打开 `install_bookmarklet.html`。
3. 把页面里的 **LS连接器** 拖到浏览器收藏栏。
4. 打开 Label Studio 具体任务页。
5. 点击收藏栏里的 **LS连接器**。
6. 桌面工具显示“已连接”后开始标注。

## 每天使用

1. 先开桌面工具；
2. 打开 Label Studio 任务页；
3. 点收藏栏 **LS连接器**；
4. 看视频；
5. 遇到常见不符合问题，点击桌面工具中的备注模板。

## 注意

- 不需要手动采集坐标；
- 不需要刷新页面；
- 不需要安装浏览器插件；
- 如果页面未连接，请回到 Label Studio 页面再点一次 LS连接器。


## 2026-07 修复说明：下一任务逻辑

当前版本的下一任务逻辑已改为：Submit 后等待页面状态更新，然后从当前可见任务列表自上而下扫描，点击第一个 completed/annotations_count 为 0 的任务行。桌面端超时时间已提升到 30 秒。严格不要恢复坐标点击、历史 next_row 或 row_delta_y 递推。
