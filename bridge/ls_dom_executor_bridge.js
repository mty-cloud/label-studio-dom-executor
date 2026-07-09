/**
 * Label Studio DOM Executor Bridge
 *
 * Injecté dans la page Label Studio via Bookmarklet (iframe + postMessage).
 * Communique avec le serveur local via XHR (compatible HTTPS → HTTP).
 * Ne PAS utiliser de coordonnées écran, ni pyautogui, ni marker.
 */
(function () {
  'use strict';

  const SERVER = 'http://127.0.0.1:17892';
  const VERSION = 'dom-executor-2.0.0';

  // --- Nettoyage d'une ancienne instance ---
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
  function log() { console.log('[LS DOM Bridge]', ...arguments); }

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
      x.timeout = 5000;
      x.onload = function () {
        try { resolve(JSON.parse(x.responseText)); }
        catch (e) { reject(new Error('JSON parse error')); }
      };
      x.onerror = function () { reject(new Error('xhr error')); };
      x.ontimeout = function () { reject(new Error('timeout')); };
      x.send(body ? JSON.stringify(body) : null);
    });
  }

  function apiPost(path, payload) {
    return xhrJson('POST', path, payload);
  }

  function apiGet(path) {
    return xhrJson('GET', path + '?clientId=' + encodeURIComponent(bridge.clientId), null);
  }

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
    var taskId = getCurrentTaskId();
    var hasControls = hasLabelingControls();
    return {
      url: window.location.href,
      title: document.title,
      projectId: projectMatch ? projectMatch[1] : '',
      tabId: url.searchParams.get('tab') || '',
      taskId: taskId,
      isLabelingPage: (!!projectMatch && !!taskId && (/\/projects\/\d+\/(data|labeling|label)/.test(url.pathname) || hasControls)) || hasControls,
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
    box.__timer = setTimeout(function () { if (box && box.parentNode) box.parentNode.removeChild(box); }, 2600);
  }
  bridge.showToast = showToast;

  // ======================== DOM 操作 ========================

  function queryInputByName(name) {
    return document.querySelector('input[name="' + CSS.escape(name) + '"]');
  }

  function candidateClickableForInput(input) {
    if (!input) return null;
    return input.closest('label') || input.closest('.ant-checkbox-wrapper') || input.closest('.lsf-choice') || input.parentElement || input;
  }

  function humanClick(element) {
    if (!element) throw new Error('humanClick 收到空元素');
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    var rect = element.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var types = ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'];
    for (var _i4 = 0; _i4 < types.length; _i4++) {
      element.dispatchEvent(new MouseEvent(types[_i4], { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
    }
  }

  async function ensureChoice(nameToSelect, namesToUnselect) {
    namesToUnselect = namesToUnselect || [];
    for (var _i5 = 0; _i5 < namesToUnselect.length; _i5++) {
      var inp = queryInputByName(namesToUnselect[_i5]);
      if (inp && inp.checked) { humanClick(candidateClickableForInput(inp)); await sleep(80); }
    }
    var target = queryInputByName(nameToSelect);
    if (!target) throw new Error("input[name='" + nameToSelect + "'] 未找到");
    if (!target.checked) { humanClick(candidateClickableForInput(target)); await sleep(100); }
    return { ok: true, name: nameToSelect, checked: queryInputByName(nameToSelect) && queryInputByName(nameToSelect).checked === true };
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
    textarea.scrollIntoView({ block: 'center', inline: 'nearest' });
    textarea.focus();
    setTextareaValue(textarea, '');
    await sleep(60);
    setTextareaValue(textarea, remark);
    await sleep(120);
    return { ok: true, length: String(remark || '').length };
  }

  function findButtonByExactText(text) {
    var buttons = Array.from(document.querySelectorAll('button'));
    for (var _i6 = 0; _i6 < buttons.length; _i6++) {
      if (normalizeText(buttons[_i6].textContent) === text) return buttons[_i6];
    }
    return null;
  }

  async function clickRemarkAdd() {
    var textarea = getRemarkTextarea();
    var addButton = document.querySelector('[data-testid="textarea-add-button"]') || findButtonByExactText('Add');
    if (addButton && !addButton.disabled && addButton.getAttribute('aria-disabled') !== 'true') {
      humanClick(addButton); await sleep(250); return { ok: true, method: 'button' };
    }
    if (!textarea) throw new Error('没有 Add 按钮');
    textarea.focus();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    await sleep(250);
    return { ok: true, method: 'shift_enter' };
  }

  async function clickSubmit() {
    var submit = document.querySelector('button[name="submit"]') || document.querySelector('[data-testid="bottombar-submit-button"]') || findButtonByExactText('Submit');
    if (!submit) throw new Error('Submit 按钮未找到');
    if (submit.disabled || submit.getAttribute('aria-disabled') === 'true') throw new Error('Submit 不可用');
    humanClick(submit);
    await sleep(200);
    return { ok: true };
  }

  // ======================== 任务行 ========================

  // 尝试获取左面板容器（Quick View），后续行搜索限定在此区域内
  function getLeftPanel() {
    // 标注页左面板 Quick View 的各种可能容器
    var containers = [
      document.querySelector('.lsf-label-view__table'),          // 标准标注页 Quick View
      document.querySelector('.lsf-label-view__dataview'),       // Quick View 数据视图
      document.querySelector('.lsf-data-view-dm'),               // DM 数据视图
      document.querySelector('.lsf-table'),                      // 表格容器
    ];
    for (var _c = 0; _c < containers.length; _c++) {
      if (containers[_c] && containers[_c].offsetWidth > 0) return containers[_c];
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    // 同时检查元素本身和 offsetParent 是否可见
    if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) {
      // style="position:absolute" 的元素 offsetParent 可能为 null，此时用 getBoundingClientRect
    }
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  }

  function getRowCandidates() {
    // 限定搜索范围为左面板或整个文档
    var root = getLeftPanel() || document;

    // 选择器列表，覆盖不同版本的 Label Studio
    var sels = [
      'div.lsf-table__row-wrapper',          // 标准 LS 行
      '[class*="table__row-wrapper"]',       // 带变体的行
      '[data-testid="table-row-wrapper"]',   // data-testid 行
      'div.lsf-table-row',                   // 行内部容器
      '[data-testid="table-row"]',           // data-testid 行内部
      '[role="row"]',                        // ARIA role 行
    ];
    // 添加 tr 但仅当在 table 内且不属于标注编辑器区域
    var editorTables = root.querySelectorAll('.lsf-label-view__lsf-wrapper table, .lsf-main-view table, .lsf-editor table');
    var editorTableSet = new Set();
    for (var _ed = 0; _ed < editorTables.length; _ed++) {
      editorTableSet.add(editorTables[_ed]);
    }

    var seen = new Set();
    var out = [];
    for (var _i7 = 0; _i7 < sels.length; _i7++) {
      var els = Array.from(root.querySelectorAll(sels[_i7]));
      for (var _i8 = 0; _i8 < els.length; _i8++) {
        // 跳过标注编辑器内的 tr 行
        if (sels[_i7] === 'tr') {
          var inEditor = false;
          var p = els[_i8].parentElement;
          while (p) {
            if (editorTableSet.has(p)) { inEditor = true; break; }
            p = p.parentElement;
          }
          if (inEditor) continue;
        }
        if (!seen.has(els[_i8])) {
          seen.add(els[_i8]);
          if (isVisible(els[_i8])) out.push(els[_i8]);
        }
      }
    }
    return out;
  }

  function cellTextsForRow(row) {
    // 优先使用表格单元格选择器
    var cells = Array.from(row.querySelectorAll('div.lsf-table__cell, span.lsf-table__cell, [class*="table__cell"], [role="cell"], td'));
    if (cells.length) return cells.map(function (c) { return normalizeText(c.textContent); });
    // 兜底：提取行内所有非空文本节点
    var t = normalizeText(row.textContent);
    return t ? t.split(/\s+/) : [];
  }

  function inferTaskId(texts) {
    // 方法1：纯数字5位+
    for (var _i9 = 0; _i9 < texts.length; _i9++) {
      if (/^\d{5,}$/.test(texts[_i9])) return texts[_i9];
    }
    // 方法2：4位数字（部分项目短ID）
    for (var _i9b = 0; _i9b < texts.length; _i9b++) {
      if (/^\d{4,}$/.test(texts[_i9b])) return texts[_i9b];
    }
    // 方法3：在文本框内找任意5+位数字
    var joined = texts.join(' ');
    var m = joined.match(/\b\d{5,}\b/);
    if (m) return m[0];
    // 方法4：找4位数字
    m = joined.match(/\b\d{4,}\b/);
    return m ? m[0] : '';
  }

  function inferCompleted(row, texts) {
    // 方法1: 看第一列是否有已勾选的复选框（最可靠，跨项目通用）
    var cells = Array.from(row.querySelectorAll('div.lsf-table__cell, span.lsf-table__cell, [class*="table__cell"], [role="cell"], td'));
    if (cells.length > 0) {
      var cb = cells[0].querySelector('input[type="checkbox"]');
      if (cb) return cb.checked ? 1 : 0;
    }

    // 方法2: 看整行是否有 completed 状态类或 selected 属性
    var rowClasses = row.className || '';
    if (
      row.classList.contains('completed') ||
      row.getAttribute('data-completed') === 'true' ||
      row.getAttribute('aria-selected') === 'true' ||
      rowClasses.indexOf('row-wrapper_highlighted') >= 0 ||   // 当前选中行（已高亮的行可能是正在做的）
      rowClasses.indexOf('row-wrapper_selected') >= 0          // 已选中的行
    ) {
      // selected/highlighted 不能单独确认 completed，如果同时还有 completed class 才算
      if (row.classList.contains('completed') || row.getAttribute('data-completed') === 'true') return 1;
      // 这里不直接返回，继续方法3判断
    }

    // 方法3: 扫描所有单元格文本中的 0/1 值
    // 优先跳过第0列（checkbox文本）和第1列（task id），从靠后的列找
    for (var _i = cells.length - 1; _i >= 2; _i--) {
      if (cells[_i] && /^[01]$/.test(normalizeText(cells[_i].textContent))) return Number(normalizeText(cells[_i].textContent));
    }
    // 兜底: 从前向后扫描
    for (var _i2 = 0; _i2 < texts.length; _i2++) {
      if (/^[01]$/.test(texts[_i2])) return Number(texts[_i2]);
    }
    return 0;
  }

  // 从行元素的 data-* 属性或 aria-label 中获取任务ID（比文本更可靠）
  function getTaskIdFromAttrs(row) {
    // data-task-id 属性
    var tid = row.getAttribute('data-task-id') || row.getAttribute('data-id');
    if (tid && /^\d+$/.test(tid)) return tid;
    // aria-label: "Select Task 587521"
    var label = row.getAttribute('aria-label');
    if (label) {
      var m = label.match(/\b(\d{4,})\b/);
      if (m) return m[1];
    }
    return '';
  }

  function getTaskRows() {
    var rows = getRowCandidates().map(function (row, idx) {
      var rect = row.getBoundingClientRect();
      var texts = cellTextsForRow(row);
      var taskId = inferTaskId(texts) || getTaskIdFromAttrs(row);
      return { row: row, index: idx, rectTop: rect.top, rectBottom: rect.bottom, texts: texts, taskId: taskId, completed: inferCompleted(row, texts) };
    }).filter(function (r) { return r.taskId; });
    rows.sort(function (a, b) { return a.rectTop - b.rectTop; });
    rows.forEach(function (r, idx) { r.index = idx; });
    return rows;
  }

  function findScrollContainer(element) {
    var node = element && element.parentElement;
    while (node && node !== document.body) {
      var style = window.getComputedStyle(node);
      if (['auto', 'scroll'].indexOf(style.overflowY) >= 0 && node.scrollHeight > node.clientHeight) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function median(values) {
    if (!values.length) return null;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function computeRowPitch(rows) {
    var centers = rows.map(function (r) { return (r.rectTop + r.rectBottom) / 2; }).sort(function (a, b) { return a - b; });
    var diffs = [];
    for (var _i11 = 1; _i11 < centers.length; _i11++) {
      var d = centers[_i11] - centers[_i11 - 1];
      if (d >= 20 && d <= 140) diffs.push(d);
    }
    return median(diffs);
  }

  async function waitForTaskCompleted(taskId, timeoutMs) {
    var start = Date.now();
    while (Date.now() - start < timeoutMs) {
      var rows = getTaskRows();
      var row = rows.find(function (r) { return String(r.taskId) === String(taskId); });
      if (row && row.completed === 1) return row;
      await sleep(200);
    }
    throw new Error('task ' + taskId + ' 等待完成超时');
  }

  function findFirstUncompletedRow(rows) {
    // 从上到下找第一个未完成的行
    for (var _i12 = 0; _i12 < rows.length; _i12++) {
      if (rows[_i12].completed === 0) return rows[_i12];
    }
    return null;
  }

  /**
   * 使用虚拟滚动的左面板在任务切换时行可能一瞬消失。
   * 本函数增加容错：当 rows 为空时自动重试一次。
   */
  async function waitForRows(retries, intervalMs) {
    for (var _r = 0; _r < retries; _r++) {
      var r = getTaskRows();
      if (r.length > 0) return r;
      await sleep(intervalMs);
    }
    return getTaskRows();
  }

  async function waitUntilReadyForFirstZeroNavigation(currentTaskId, timeoutMs) {
    var start = Date.now();
    var lastRows = [];
    while (Date.now() - start < timeoutMs) {
      var rows = getTaskRows();
      lastRows = rows;
      var current = rows.find(function (r) { return String(r.taskId) === String(currentTaskId); });
      var firstZero = findFirstUncompletedRow(rows);
      if (current && current.completed === 1) return { rows: rows, reason: 'current_completed' };
      if (firstZero && String(firstZero.taskId) !== String(currentTaskId)) return { rows: rows, reason: 'first_zero_moved' };
      await sleep(250);
    }
    return { rows: lastRows, reason: 'timeout_but_continue' };
  }

  async function clickFirstUncompletedTask(currentTaskId, waitMs) {
    if (!waitMs) waitMs = 18000;  // 默认18秒，给虚拟滚动更多时间

    // 额外等待：先确保有行出现（虚拟滚动过渡期可能为空）
    var rows = await waitForRows(5, 500);  // 最多等2.5秒有行
    if (!rows.length) {
      throw new Error('未扫描到左侧任务行（左面板可能未加载或已隐藏）');
    }

    var waitResult = await waitUntilReadyForFirstZeroNavigation(currentTaskId, waitMs);
    rows = waitResult.rows;

    // 如果超时后仍然没有行，再给一次机会
    if (!rows.length) {
      rows = await waitForRows(8, 500);  // 再等4秒
    }
    if (!rows.length) {
      throw new Error('未扫描到左侧任务行（虚拟滚动可能未渲染完成）');
    }

    var firstZero = findFirstUncompletedRow(rows);
    if (!firstZero) {
      var pitch = computeRowPitch(rows) || 50;
      var scroller = findScrollContainer(rows[rows.length - 1].row);
      scroller.scrollTop += pitch;
      await sleep(400);
      rows = getTaskRows();
      firstZero = findFirstUncompletedRow(rows);
    }
    if (!firstZero) {
      log('当前可见行全部已完成，尝试点击已完成行下方区域触发虚拟滚动加载更多行');
      var pitch = computeRowPitch(rows) || 50;
      var scroller = findScrollContainer(rows[rows.length - 1].row);
      scroller.scrollTop += pitch * 2;
      await sleep(500);
      rows = getTaskRows();
      firstZero = findFirstUncompletedRow(rows);
    }
    if (!firstZero) throw new Error('未找到状态为 0 的下一任务行');
    if (String(firstZero.taskId) === String(currentTaskId)) throw new Error('当前任务状态未更新');
    firstZero.row.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(150);
    humanClick(firstZero.row);
    await sleep(350);
    return { ok: true, reason: waitResult.reason, nextTaskId: firstZero.taskId, nextIndex: firstZero.index, nextTexts: firstZero.texts };
  }

  // ======================== 命令执行 ========================

  async function executeTemplateCommand(command) {
    var settings = command.settings || {};
    var execution = settings.execution || {};
    var remark = String(command.remark || '');
    var autoSubmit = command.autoSubmit === true;
    var autoNext = command.autoNext === true;
    var currentTaskId = getCurrentTaskId();

    if (!parsePageInfo().isLabelingPage) throw new Error('当前页面不是标注页');
    if (!currentTaskId) throw new Error('未能读取 task_id');
    if (!remark) throw new Error('备注模板为空');

    await ensureChoice('不符合', ['符合']);
    await sleep(execution.delay_after_choice_ms || 120);
    await ensureChoice('是', ['不是']);
    await sleep(execution.delay_after_choice_ms || 120);
    await fillRemark(remark);
    await sleep(execution.delay_after_remark_ms || 150);
    var addResult = await clickRemarkAdd();
    await sleep(execution.delay_after_add_ms || 250);

    if (!autoSubmit) return { ok: true, mode: 'filled_only', taskId: currentTaskId, addResult: addResult, message: '已选择不符合+是并填写备注' };

    await clickSubmit();
    await sleep(execution.delay_after_submit_ms || 800);

    if (!autoNext) return { ok: true, mode: 'submitted_only', taskId: currentTaskId, message: '已提交' };

    var nextInfo = await clickFirstUncompletedTask(currentTaskId, execution.wait_completed_timeout_ms);
    return { ok: true, mode: 'submitted_and_next', taskId: currentTaskId, nextTaskId: nextInfo.nextTaskId, nextInfo: nextInfo, message: 'task ' + currentTaskId + ' 已完成，进入 ' + (nextInfo.nextTaskId || '下一') };
  }

  async function handleCommand(command) {
    if (!command || !command.type) return;
    if (bridge.executing) return;
    showToast('执行：' + (command.remark || command.type), 'info');
    bridge.executing = true;
    bridge.lastCommandId = command.commandId;
    try {
      var result = null;
      if (command.type === 'execute_template') result = await executeTemplateCommand(command);
      else if (command.type === 'collect_status') result = { ok: true, page: parsePageInfo(), rows: getTaskRows().map(function (r) { return { taskId: r.taskId, completed: r.completed, texts: r.texts }; }) };
      else throw new Error('未知命令: ' + command.type);
      await apiPost('/bridge/result', { commandId: command.commandId, ok: true, result: result, page: parsePageInfo(), version: VERSION });
      showToast(result.message || '完成', 'success');
    } catch (err) {
      var msg = err && err.message || String(err);
      await apiPost('/bridge/result', { commandId: command.commandId, ok: false, error: msg, page: parsePageInfo(), version: VERSION });
      showToast('执行失败：' + msg, 'error');
      console.error('[LS DOM Bridge] fail', err);
    } finally { bridge.executing = false; }
  }

  async function pollCommands() {
    if (bridge.executing) return;
    try {
      var res = await apiGet('/bridge/command');
      if (res && res.command) await handleCommand(res.command);
    } catch (e) { log('poll fail', e); }
  }

  // ======================== 启动 ========================

  async function start() {
    try {
      var page = parsePageInfo();
      var regResult = await apiPost('/bridge/register', { clientId: bridge.clientId, url: page.url, title: page.title, taskId: page.taskId, version: VERSION });
      if (!regResult.ok) { showToast('注册失败：' + (regResult.error || 'server error'), 'error'); return; }

      showToast('LS DOM Bridge 已连接桌面工具', 'success');
      log('registered', regResult, page);

      bridge.heartbeatTimer = setInterval(async function () {
        try {
          var p = parsePageInfo();
          await apiPost('/bridge/heartbeat', { clientId: bridge.clientId, url: p.url, title: p.title, taskId: p.taskId, version: VERSION });
        } catch (e) { log('hb fail', e); }
      }, 2000);

      bridge.pollTimer = setInterval(pollCommands, 350);
    } catch (e) {
      showToast('连接失败：请确认桌面工具已启动', 'error');
      console.error('[LS DOM Bridge] start fail', e);
    }
  }

  start();
})();
