/**
 * Label Studio DOM Executor Bridge v2 (极速版)
 *
 * 特性：
 * - 全流程单次命令执行（选不符合→填备注→Add→Submit→导航下一任务）
 * - 导航使用 API 查找 + DOM 点击，保持 SPA 不重载
 * - 极低延迟，最小化所有 sleep
 */

(function () {
  'use strict';

  const SERVER = 'http://127.0.0.1:17892';
  const VERSION = 'dom-executor-2.2.0';

  // Cleanup previous instance
  if (window.__LS_DOM_EXECUTOR_BRIDGE__) {
    const old = window.__LS_DOM_EXECUTOR_BRIDGE__;
    if (old.heartbeatTimer) clearInterval(old.heartbeatTimer);
    if (old.pollTimer) clearInterval(old.pollTimer);
    window.__LS_DOM_EXECUTOR_BRIDGE__ = null;
  }

  const bridge = {
    running: true,
    clientId: 'ls-dom-bridge-' + Math.random().toString(36).slice(2) + '-' + Date.now(),
    pollTimer: null,
    heartbeatTimer: null,
    executing: false,
    lastCommandId: null,
    version: VERSION,
  };
  window.__LS_DOM_EXECUTOR_BRIDGE__ = bridge;

  // ======================== Utilitaires ========================

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function log() { console.log('[LS DOM Bridge v2]', ...arguments); }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  // ======================== XHR (compatible HTTPS→HTTP) ========================

  function xhrJson(method, path, body) {
    return new Promise(function (resolve, reject) {
      var url = SERVER + path;
      if (method === 'GET') url += (path.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
      var x = new XMLHttpRequest();
      x.open(method, url, true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.timeout = 8000;
      x.onload = function () {
        try { resolve(JSON.parse(x.responseText)); }
        catch (e) { reject(new Error('JSON parse error')); }
      };
      x.onerror = function () { reject(new Error('xhr error')); };
      x.ontimeout = function () { reject(new Error('timeout')); };
      x.send(body ? JSON.stringify(body) : null);
    });
  }

  function apiPost(path, payload) { return xhrJson('POST', path, payload); }
  function apiGet(path) { var _sep = path.indexOf('?') >= 0 ? '&' : '?'; return xhrJson('GET', path + _sep + 'clientId=' + encodeURIComponent(bridge.clientId), null); }

  // ======================== Page Info ========================

  function getCurrentTaskId() {
    try {
      var url = new URL(window.location.href);
      for (var _i = 0, _arr = ['task', 'task_id', 'id', 'selected']; _i < _arr.length; _i++) {
        var val = url.searchParams.get(_arr[_i]);
        if (val && /^\d+$/.test(val)) return String(val);
      }
      if (url.hash) {
        var hp = new URLSearchParams(url.hash.split('?')[1] || '');
        val = hp.get('task');
        if (val && /^\d+$/.test(val)) return String(val);
      }
    } catch (_) {}

    var sels = ['div.lsf-current-task__task-id', '[class*="current-task"] [class*="task-id"]', '.lsf-task-id', '[data-testid="task-id"]'];
    for (var _i2 = 0; _i2 < sels.length; _i2++) {
      var el = document.querySelector(sels[_i2]);
      if (el) {
        var m = normalizeText(el.textContent).match(/\b(\d{5,})\b/);
        if (m) return m[1];
      }
    }
    return '';
  }

  function hasLabelingControls() {
    var controls = ['input[name="不符合"]', 'input[name="符合"]', 'textarea[name="remark"]', 'button[name="submit"]', '[data-testid="bottombar-submit-button"]'];
    for (var _i3 = 0; _i3 < controls.length; _i3++) {
      if (document.querySelector(controls[_i3])) return true;
    }
    return false;
  }

  function parsePageInfo() {
    var url = new URL(window.location.href);
    var projectMatch = url.pathname.match(/\/projects\/(\d+)/);
    return {
      url: window.location.href,
      title: document.title,
      projectId: projectMatch ? projectMatch[1] : '',
      taskId: getCurrentTaskId(),
      isLabelingPage: hasLabelingControls(),
    };
  }

  // ======================== Toast ========================

  function showToast(message, type) {
    type = type || 'info';
    var box = document.getElementById('ls-dom-bridge-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ls-dom-bridge-toast';
      box.style.cssText = 'position:fixed;right:16px;top:16px;z-index:2147483647;padding:10px 12px;border-radius:8px;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.18);background:#1f2937;color:#fff;max-width:360px;';
      document.body.appendChild(box);
    }
    box.textContent = message;
    box.style.background = type === 'error' ? '#991b1b' : type === 'success' ? '#166534' : '#1f2937';
    clearTimeout(box.__timer);
    box.__timer = setTimeout(function () { if (box && box.parentNode) box.parentNode.removeChild(box); }, 2000);
  }
  bridge.showToast = showToast;

  // ======================== DOM 操作（极速版） ========================

  function queryInputByName(name) {
    return document.querySelector('input[name="' + CSS.escape(name) + '"]');
  }

  function candidateClickableForInput(input) {
    if (!input) return null;
    return input.closest('label') || input.closest('.ant-checkbox-wrapper') || input.closest('.lsf-choice') || input.parentElement || input;
  }

  // 极速点击：最小化 sleep，合并事件队列
  function fastClick(element) {
    if (!element) throw new Error('fastClick 收到空元素');
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    var rect = element.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var types = ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'];
    for (var _i4 = 0; _i4 < types.length; _i4++) {
      element.dispatchEvent(new MouseEvent(types[_i4], { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
    }
  }

  // 极速选择：一次点击直接到位
  async function fastEnsureChoice(nameToSelect, namesToUnselect) {
    namesToUnselect = namesToUnselect || [];
    for (var _i5 = 0; _i5 < namesToUnselect.length; _i5++) {
      var inp = queryInputByName(namesToUnselect[_i5]);
      if (inp && inp.checked) { fastClick(candidateClickableForInput(inp)); await sleep(20); }
    }
    var target = queryInputByName(nameToSelect);
    if (!target) throw new Error("input[name='" + nameToSelect + "'] 未找到");
    if (!target.checked) { fastClick(candidateClickableForInput(target)); await sleep(30); }
    return { ok: true, name: nameToSelect };
  }

  function getRemarkTextarea() {
    return document.querySelector('textarea[name="remark"]') || document.querySelector('[data-testid="textarea-input"]');
  }

  function setTextareaValue(textarea, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    setter = setter && setter.set;
    if (setter) setter.call(textarea, value); else textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function fillRemark(remark) {
    var textarea = getRemarkTextarea();
    if (!textarea) throw new Error("textarea[name='remark'] 未找到");
    textarea.focus();
    setTextareaValue(textarea, '');
    setTextareaValue(textarea, remark);
    await sleep(30);
    return { ok: true };
  }

  function findButtonByExactText(text) {
    var buttons = Array.from(document.querySelectorAll('button'));
    for (var _i6 = 0; _i6 < buttons.length; _i6++) {
      if (normalizeText(buttons[_i6].textContent) === text) return buttons[_i6];
    }
    return null;
  }

  async function clickRemarkAdd() {
    var addButton = document.querySelector('[data-testid="textarea-add-button"]') || findButtonByExactText('Add');
    if (addButton && !addButton.disabled && addButton.getAttribute('aria-disabled') !== 'true') {
      fastClick(addButton); await sleep(80); return { ok: true, method: 'button' };
    }
    var textarea = getRemarkTextarea();
    if (!textarea) throw new Error('没有 Add 按钮');
    textarea.focus();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true }));
    await sleep(80);
    return { ok: true, method: 'shift_enter' };
  }

  async function clickSubmit() {
    var submit = document.querySelector('button[name="submit"]') || document.querySelector('[data-testid="bottombar-submit-button"]') || findButtonByExactText('Submit');
    if (!submit) throw new Error('Submit 按钮未找到');
    if (submit.disabled || submit.getAttribute('aria-disabled') === 'true') throw new Error('Submit 不可用');
    fastClick(submit);
    await sleep(100);
    return { ok: true };
  }

  // ======================== 行查找（基于 API 返回的精确 task ID） ========================

  function findRowByTaskId(taskId) {
    var taskIdStr = String(taskId);

    // 策略1: checkbox aria-label → 向上找行包装器（你的 LS 版本的结构）
    var checkbox = document.querySelector('input[type="checkbox"][aria-label*="' + CSS.escape(taskIdStr) + '"]');
    if (checkbox) {
      var row = checkbox.closest('div.lsf-table__row-wrapper') ||
                checkbox.closest('[data-testid="table-row-wrapper"]') ||
                checkbox.closest('[class*="table__row-wrapper"]') ||
                checkbox.closest('[role="row"]') ||
                checkbox.closest('div.lsf-table-row');
      if (row) return row;
    }

    // 策略2: 遍历行，文本匹配 task ID
    var allRows = document.querySelectorAll('div.lsf-table__row-wrapper, [data-testid="table-row-wrapper"], [class*="table__row-wrapper"]');
    for (var _r = 0; _r < allRows.length; _r++) {
      if ((allRows[_r].textContent || '').indexOf(taskIdStr) >= 0) {
        var rect = allRows[_r].getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return allRows[_r];
      }
    }

    // 策略3: aria-label 元素向上找行
    var labeled = document.querySelectorAll('[aria-label*="' + CSS.escape(taskIdStr) + '"]');
    for (var _e = 0; _e < labeled.length; _e++) {
      var r = labeled[_e].closest('div.lsf-table__row-wrapper') ||
              labeled[_e].closest('[data-testid="table-row-wrapper"]') ||
              labeled[_e].closest('[class*="table__row-wrapper"]') ||
              labeled[_e].closest('[role="row"]');
      if (r) return r;
    }

    return null;
  }

  function getScrollContainer() {
    var containers = [
      document.querySelector('.lsf-label-view__table'),
      document.querySelector('.lsf-table'),
      document.querySelector('[class*="table__body"]'),
      document.querySelector('.lsf-label-view__dataview'),
      document.querySelector('.lsf-table-view'),
    ];
    for (var _c = 0; _c < containers.length; _c++) {
      if (containers[_c]) {
        var p = containers[_c];
        while (p && p !== document.body) {
          var style = window.getComputedStyle(p);
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && p.scrollHeight > p.clientHeight) {
            return p;
          }
          p = p.parentElement;
        }
      }
    }
    return document.querySelector('[class*="table__container"]') ||
           document.querySelector('[class*="virtual-list"]') ||
           null;
  }

  async function waitForRowByTaskId(taskId, timeoutMs, pollMs) {
    var taskIdStr = String(taskId);
    if (!pollMs) pollMs = 300;
    var start = Date.now();
    var lastRow = null;

    while (Date.now() - start < timeoutMs) {
      // 先看当前 DOM 有没有
      var row = findRowByTaskId(taskIdStr);
      if (row) return row;

      // 没有就滚动查找
      var scroller = getScrollContainer();
      if (scroller) {
        var elapsed = Date.now() - start;
        var ratio = (elapsed % 4000) / 4000;  // 每 4 秒循环一次位置
        scroller.scrollTop = scroller.scrollHeight * ratio;
      } else {
        // 没有滚动容器，尝试滚动文档
        window.scrollBy(0, 100);
      }
      await sleep(pollMs);
    }
    return null;
  }

  async function clickTaskRowById(taskId) {
    if (!taskId) throw new Error('缺少目标 task ID');
    var taskIdStr = String(taskId);

    // 等最长 6 秒让行出现
    var row = await waitForRowByTaskId(taskIdStr, 6000, 300);

    if (!row) {
      // 实在找不到，URL 跳转
      var currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set('task', taskIdStr);
      log('未找到行，回退到 URL 导航: ' + currentUrl);
      window.location.href = currentUrl.toString();
      return { ok: true, method: 'url_navigation', taskId: taskIdStr };
    }

    row.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(30);
    fastClick(row);
    return { ok: true, method: 'dom_click', taskId: taskIdStr };
  }

  // ======================== 一站式命令执行（极速版） ========================

  async function executeTemplateCommand(command) {
    var remark = String(command.remark || '');
    var autoSubmit = command.autoSubmit === true;
    var autoNext = command.autoNext === true;
    var currentTaskId = getCurrentTaskId();
    var pageInfo = parsePageInfo();

    if (!pageInfo.isLabelingPage) throw new Error('当前页面不是标注页');
    if (!currentTaskId) throw new Error('未能读取 task_id');
    if (!remark) throw new Error('备注模板为空');

    // Step 1: 选择"不符合"
    await fastEnsureChoice('不符合', ['符合']);

    // Step 2: 选择"是"
    await fastEnsureChoice('是', ['不是']);

    // Step 3: 填写备注
    await fillRemark(remark);

    // Step 4: 点击 Add
    await clickRemarkAdd();

    if (!autoSubmit) {
      return { ok: true, mode: 'filled_only', taskId: currentTaskId, message: '已填充' };
    }

    // Step 5: 点击 Submit
    await clickSubmit();

    if (!autoNext) {
      return { ok: true, mode: 'submitted_only', taskId: currentTaskId, message: '已提交' };
    }

    // Step 6: 等 LS 更新表格
    await sleep(500);

    // Step 7: API 查下一任务 + DOM 导航（在桥接内一步完成）
    if (pageInfo.projectId) {
      try {
        var apiResult = await apiGet('/api/next-task?project_id=' + pageInfo.projectId + '&current_task_id=' + currentTaskId);
        if (apiResult && apiResult.ok && apiResult.has_next && apiResult.next_task) {
          var nextTaskId = String(apiResult.next_task.id);
          var navResult = await clickTaskRowById(nextTaskId);
          return {
            ok: true,
            mode: 'submitted_and_navigated',
            taskId: currentTaskId,
            nextTaskId: nextTaskId,
            navMethod: navResult.method,
            message: 'task ' + currentTaskId + ' 完成，进入 ' + nextTaskId,
          };
        }
      } catch (e) {
        log('导航失败: ' + e.message);
        return { ok: true, mode: 'submitted_nav_failed', taskId: currentTaskId, message: '已提交，但导航失败: ' + e.message };
      }
    }

    return { ok: true, mode: 'submitted_no_next', taskId: currentTaskId, message: '已提交，无下一任务' };
  }

  async function handleCommand(command) {
    if (!command || !command.type) return;
    if (bridge.executing && command.type !== 'navigate') return;

    if (command.type === 'navigate') {
      // 保留 navigate 命令作为备选
      if (command.nextTaskId) {
        showToast('导航到: ' + command.nextTaskId, 'info');
        try {
          var nr = await clickTaskRowById(command.nextTaskId);
          await apiPost('/bridge/result', {
            commandId: command.commandId, ok: true,
            result: { message: '导航到 ' + command.nextTaskId, method: nr.method, taskId: command.nextTaskId },
            page: parsePageInfo(), version: VERSION,
          });
        } catch (e) {
          await apiPost('/bridge/result', {
            commandId: command.commandId, ok: false, error: e.message,
            page: parsePageInfo(), version: VERSION,
          });
        }
      }
      return;
    }

    if (bridge.executing) return;

    showToast('执行：' + (command.remark || command.type), 'info');
    bridge.executing = true;
    bridge.lastCommandId = command.commandId;
    try {
      var result = await executeTemplateCommand(command);
      await apiPost('/bridge/result', {
        commandId: command.commandId, ok: true, result: result,
        page: parsePageInfo(), version: VERSION,
      });
      showToast(result.message || '完成', 'success');
    } catch (err) {
      var msg = err && err.message || String(err);
      await apiPost('/bridge/result', {
        commandId: command.commandId, ok: false, error: msg,
        page: parsePageInfo(), version: VERSION,
      });
      showToast('执行失败：' + msg, 'error');
      console.error('[LS DOM Bridge v2] fail', err);
    } finally { bridge.executing = false; }
  }

  async function pollCommands() {
    if (bridge.executing) return;
    try {
      var res = await apiGet('/bridge/command');
      if (res && res.command) await handleCommand(res.command);
    } catch (e) { /* poll fail silently */ }
  }

  // ======================== 启动 ========================

  async function start() {
    try {
      var page = parsePageInfo();
      var regResult = await apiPost('/bridge/register', {
        clientId: bridge.clientId, url: page.url, title: page.title, taskId: page.taskId, version: VERSION,
      });
      if (!regResult.ok) { showToast('注册失败', 'error'); return; }
      showToast('LS Bridge 已连接', 'success');

      bridge.heartbeatTimer = setInterval(async function () {
        try {
          var p = parsePageInfo();
          await apiPost('/bridge/heartbeat', { clientId: bridge.clientId, url: p.url, title: p.title, taskId: p.taskId, version: VERSION });
        } catch (e) { /* hb fail */ }
      }, 3000);

      bridge.pollTimer = setInterval(pollCommands, 200);  // 200ms 轮询，比之前更快
    } catch (e) {
      showToast('连接失败：请确认桌面工具已启动', 'error');
      console.error('[LS DOM Bridge v2] start fail', e);
    }
  }

  start();
})();
