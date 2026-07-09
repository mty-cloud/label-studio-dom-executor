/* ═══════════════════════════════════════════════════════
   LS 标注助手 — 主应用逻辑
   ═══════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────
  const state = {
    templates: [],
    selectedIndex: -1,
    bridgeConnected: false,
    currentTaskId: '',
    currentProjectId: '',
    lsReady: false,
    executing: false,
  };

  // ─── DOM refs ──────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const dom = {
    statusDot: $('#statusDot'),
    statusText: $('#statusText'),
    statusTask: $('#statusTask'),
    statusProject: $('#statusProject'),
    templateList: $('#templateListContainer'),
    quickContainer: $('#quickBtnContainer'),
    templateCount: $('#templateCount'),
    logBody: $('#logBody'),
    autoSubmit: $('#autoSubmit'),
    autoNext: $('#autoNext'),
    executeBtn: $('#executeBtn'),
    addBtn: $('#addBtn'),
    editBtn: $('#editBtn'),
    deleteBtn: $('#deleteBtn'),
    moveUpBtn: $('#moveUpBtn'),
    moveDownBtn: $('#moveDownBtn'),
    templateRefresh: $('#templateRefresh'),
    logClearBtn: $('#logClearBtn'),
    themeToggle: $('#themeToggle'),
    settingsBtn: $('#settingsBtn'),
    helpBtn: $('#helpBtn'),
    settingsModal: $('#settingsModal'),
    templateModal: $('#templateModal'),
    templateModalTitle: $('#templateModalTitle'),
    templateModalText: $('#templateModalText'),
    templateModalSave: $('#templateModalSave'),
    settingBridgePort: $('#settingBridgePort'),
    settingTimeout: $('#settingTimeout'),
    settingLsUrl: $('#settingLsUrl'),
    settingLsToken: $('#settingLsToken'),
    settingApiStatus: $('#settingApiStatus'),
    settingTestBtn: $('#settingTestBtn'),
    settingSaveBtn: $('#settingSaveBtn'),
  };

  // ─── Server URL ────────────────────────────────────────
  const SERVER = `http://${location.hostname}:${location.port}`;
  const POLL_INTERVAL = 1500; // ms

  // ─── Helpers ────────────────────────────────────────────

  function apiGet(path) {
    return fetch(SERVER + path, { cache: 'no-store' }).then((r) => r.json());
  }

  function apiPost(path, body) {
    return fetch(SERVER + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function now() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  // ─── Toast ──────────────────────────────────────────────

  function showToast(message, type) {
    type = type || 'info';
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ─── Log ───────────────────────────────────────────────

  function log(message, type) {
    type = type || 'info';
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    entry.innerHTML = `<span class="log-time">[${now()}]</span><span class="log-msg">${escapeHtml(message)}</span>`;
    dom.logBody.prepend(entry);

    // Keep max 200 log entries
    while (dom.logBody.children.length > 200) {
      dom.logBody.lastChild.remove();
    }
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  // ─── Status polling ─────────────────────────────────────

  async function pollStatus() {
    try {
      const data = await apiGet('/status');
      state.bridgeConnected = data.connected;
      state.currentTaskId = data.taskId || '';
      state.currentProjectId = extractProjectId(data.pageUrl || '');

      dom.statusDot.className = `status-indicator ${data.connected ? 'connected' : 'disconnected'}`;
      dom.statusText.textContent = data.connected
        ? `桥接状态：已连接 (${data.clientId ? data.clientId.slice(-8) : '?'})`
        : '桥接状态：未连接';
      dom.statusTask.textContent = `task: ${data.taskId || '-'}`;

      if (state.currentProjectId) {
        dom.statusProject.textContent = `project: ${state.currentProjectId}`;
        dom.statusProject.style.display = '';
      } else {
        dom.statusProject.style.display = 'none';
      }
    } catch (e) {
      dom.statusDot.className = 'status-indicator disconnected';
      dom.statusText.textContent = '桥接状态：服务未启动';
    }
  }

  function extractProjectId(url) {
    if (!url) return '';
    const m = url.match(/\/projects\/(\d+)/);
    return m ? m[1] : '';
  }

  // ─── Template management ────────────────────────────────

  async function loadTemplates() {
    try {
      const data = await apiGet('/api/settings');
      // Templates are stored server-side; we need an endpoint.
      // For now, read from a local fetch. We'll add a proper endpoint.
      // Fallback: templates are defined in config/templates.json
      // Let's serve them via a simple endpoint.
      const templatesRes = await fetch(SERVER + '/api/templates');
      if (templatesRes.ok) {
        const tData = await templatesRes.json();
        state.templates = tData.templates || [];
      } else {
        // Hardcoded fallback
        state.templates = [
          '说话内容有误',
          '镜头分割有误',
          '是否人物可见：是',
          '是否人物可见：否',
          '丢弃',
          '有不确定字段（人物不可见）',
          '有不确定字段（人物可见）',
          '镜头内有speaker说话未识别出',
          '性别判断错误（应为男）',
          '性别判断错误（应为女）',
        ];
      }
    } catch (e) {
      log('加载模板失败: ' + e.message, 'error');
      state.templates = [];
    }
    renderTemplateList();
    renderQuickButtons();
  }

  function renderTemplateList() {
    dom.templateList.innerHTML = '';
    if (state.templates.length === 0) {
      dom.templateList.innerHTML = '<div class="empty-state"><span class="empty-state-icon">📋</span><span>暂无模板，点击「+ 新增」添加</span></div>';
      return;
    }
    state.templates.forEach((text, idx) => {
      const item = document.createElement('div');
      item.className = `template-item${idx === state.selectedIndex ? ' selected' : ''}`;
      item.dataset.index = idx;
      item.innerHTML = `<span class="template-drag">⠿</span><span class="template-text">${escapeHtml(text)}</span>`;
      item.addEventListener('click', () => selectTemplate(idx));
      item.addEventListener('dblclick', () => {
        selectTemplate(idx);
        executeTemplate(text);
      });
      dom.templateList.appendChild(item);
    });
    dom.templateCount.textContent = `${state.templates.length} 个模板`;
  }

  function renderQuickButtons() {
    dom.quickContainer.innerHTML = '';
    if (state.templates.length === 0) {
      dom.quickContainer.innerHTML = '<div class="empty-state"><span class="empty-state-icon">⚡</span><span>暂无模板</span></div>';
      return;
    }
    state.templates.forEach((text) => {
      const btn = document.createElement('button');
      btn.className = 'quick-btn';
      btn.textContent = text;
      btn.addEventListener('click', () => executeTemplate(text));
      dom.quickContainer.appendChild(btn);
    });
  }

  function selectTemplate(idx) {
    state.selectedIndex = idx;
    renderTemplateList();
    // Scroll to selected
    const selected = dom.templateList.querySelector('.template-item.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  function getSelectedIndex() {
    return state.selectedIndex;
  }

  // ─── Template API calls ─────────────────────────────────

  async function addTemplate(text) {
    try {
      const res = await apiPost('/api/templates', { action: 'add', text });
      if (res.ok) {
        state.templates = res.templates || [];
        state.selectedIndex = state.templates.length - 1;
        renderTemplateList();
        renderQuickButtons();
        log(`已新增模板：${text}`, 'success');
      } else {
        showToast('新增失败: ' + (res.error || '未知错误'), 'error');
      }
    } catch (e) {
      showToast('新增失败: ' + e.message, 'error');
    }
  }

  async function updateTemplate(idx, text) {
    try {
      const res = await apiPost('/api/templates', { action: 'update', index: idx, text });
      if (res.ok) {
        state.templates = res.templates || [];
        renderTemplateList();
        renderQuickButtons();
        log(`已修改模板：${text}`, 'success');
      } else {
        showToast('修改失败', 'error');
      }
    } catch (e) {
      showToast('修改失败: ' + e.message, 'error');
    }
  }

  async function deleteTemplate(idx) {
    try {
      const res = await apiPost('/api/templates', { action: 'delete', index: idx });
      if (res.ok) {
        state.templates = res.templates || [];
        if (state.selectedIndex >= state.templates.length) {
          state.selectedIndex = state.templates.length - 1;
        }
        renderTemplateList();
        renderQuickButtons();
        log('已删除模板', 'success');
      } else {
        showToast('删除失败', 'error');
      }
    } catch (e) {
      showToast('删除失败: ' + e.message, 'error');
    }
  }

  async function moveUpTemplate(idx) {
    try {
      const res = await apiPost('/api/templates', { action: 'move_up', index: idx });
      if (res.ok) {
        state.templates = res.templates || [];
        state.selectedIndex = Math.max(0, idx - 1);
        renderTemplateList();
        renderQuickButtons();
      }
    } catch (e) {
      showToast('上移失败: ' + e.message, 'error');
    }
  }

  async function moveDownTemplate(idx) {
    try {
      const res = await apiPost('/api/templates', { action: 'move_down', index: idx });
      if (res.ok) {
        state.templates = res.templates || [];
        state.selectedIndex = Math.min(state.templates.length - 1, idx + 1);
        renderTemplateList();
        renderQuickButtons();
      }
    } catch (e) {
      showToast('下移失败: ' + e.message, 'error');
    }
  }

  // ─── Execution ──────────────────────────────────────────

  async function executeTemplate(remark) {
    if (state.executing) {
      showToast('正在执行中，请等待...', 'warn');
      return;
    }
    if (!state.bridgeConnected) {
      showToast('页面未连接，请先点击 LS连接器', 'error');
      log('执行取消：页面未连接。', 'error');
      return;
    }

    state.executing = true;
    dom.executeBtn.disabled = true;
    const qbtns = dom.quickContainer.querySelectorAll('.quick-btn');
    qbtns.forEach((b) => {
      if (b.textContent === remark) b.classList.add('executing');
    });

    const autoSubmit = dom.autoSubmit.checked;
    const autoNext = dom.autoNext.checked;

    log(`▶ 开始执行模板：${remark}`, 'info');
    log(`  模式：${autoSubmit ? '自动Submit' : '仅填充'} | ${autoNext ? '自动下一任务' : '不跳转'}`, 'info');

    try {
      const payload = {
        type: 'execute_template',
        remark,
        autoSubmit,
        autoNext,
        settings: {
          execution: {
            auto_submit: autoSubmit,
            auto_next: autoNext,
            delay_after_choice_ms: 120,
            delay_after_remark_ms: 150,
            delay_after_add_ms: 250,
            delay_after_submit_ms: 1500,
            wait_completed_timeout_ms: 18000,
          },
        },
      };

      // === Phase 1: Send execute_template command ===
      log('  ⏳ 发送表单操作命令到桥接...', 'info');
      const cmdRes = await apiPost('/bridge/send-command', payload);
      if (!cmdRes.ok) throw new Error(cmdRes.error || '发送命令失败');

      const commandId = cmdRes.commandId;
      const startTime = Date.now();
      const timeoutMs = 40000;
      let result = null;

      while (Date.now() - startTime < timeoutMs) {
        const pollRes = await apiGet(`/bridge/command-result?commandId=${commandId}`);
        if (pollRes.found && pollRes.result) {
          result = pollRes.result;
          break;
        }
        await sleep(300);
      }

      if (!result) throw new Error('执行超时（40秒）');

      if (!result.ok) throw new Error(result.error || '执行失败');

      const detail = result.result || {};
      state.currentTaskId = String(detail.nextTaskId || detail.taskId || state.currentTaskId);
      dom.statusTask.textContent = `task: ${state.currentTaskId}`;
      log(`✅ ${detail.message || '执行完成。'}`, 'success');
    } catch (e) {
      log(`❌ 执行失败：${e.message}`, 'error');
      showToast('执行失败: ' + e.message, 'error');
    } finally {
      state.executing = false;
      dom.executeBtn.disabled = false;
      qbtns.forEach((b) => b.classList.remove('executing'));
    }
  }

  // ─── Settings ───────────────────────────────────────────

  async function loadSettings() {
    try {
      const res = await apiGet('/api/settings');
      if (res.ok) {
        const s = res.settings;
        dom.settingBridgePort.value = s.bridge?.port || 17892;
        dom.settingTimeout.value = s.bridge?.command_timeout_ms || 40000;
        dom.settingLsUrl.value = s.label_studio?.api_url || '';

        if (s.label_studio?.api_token_configured) {
          dom.settingLsToken.placeholder = '已配置（输入新值覆盖）';
          dom.settingLsToken.value = '';
        }

        updateApiStatus(s.label_studio?.api_token_configured ? 'configured' : 'unknown');
      }
    } catch (e) {
      log('加载设置失败', 'error');
    }
  }

  function updateApiStatus(status) {
    const el = dom.settingApiStatus;
    if (status === 'configured') {
      el.innerHTML = '<span class="status-badge status-ok">✅ API 已配置</span>';
    } else if (status === 'ok') {
      el.innerHTML = '<span class="status-badge status-ok">✅ 连接成功</span>';
    } else if (status === 'fail') {
      el.innerHTML = '<span class="status-badge status-fail">❌ 连接失败</span>';
    } else {
      el.innerHTML = '<span class="status-badge status-unknown">未检测</span>';
    }
  }

  async function testApiConnection() {
    const url = dom.settingLsUrl.value.trim();
    const token = dom.settingLsToken.value.trim();

    if (!url) {
      showToast('请输入 LS 服务器地址', 'error');
      return;
    }

    // Save temporarily and test
    try {
      await apiPost('/api/settings', {
        label_studio: { api_url: url, api_token: token || undefined },
      });
    } catch (_) {}

    updateApiStatus('unknown');
    dom.settingApiStatus.innerHTML = '<span class="status-badge status-unknown">⏳ 测试中...</span>';

    try {
      const res = await apiGet('/api/ping');
      if (res.ok) {
        updateApiStatus('ok');
        state.lsReady = true;
        showToast('✅ LS API 连接成功！', 'success');
      } else {
        updateApiStatus('fail');
        showToast('❌ 连接失败: ' + (res.error || '未知错误'), 'error');
      }
    } catch (e) {
      updateApiStatus('fail');
      showToast('❌ 连接失败: ' + e.message, 'error');
    }
  }

  async function saveSettings() {
    const payload = {
      bridge: {
        port: parseInt(dom.settingBridgePort.value) || 17892,
        command_timeout_ms: parseInt(dom.settingTimeout.value) || 40000,
      },
      label_studio: {
        api_url: dom.settingLsUrl.value.trim(),
        api_token: dom.settingLsToken.value.trim() || undefined,
      },
    };

    try {
      const res = await apiPost('/api/settings', payload);
      if (res.ok) {
        showToast('✅ 设置已保存', 'success');
        dom.settingsModal.classList.remove('active');
      } else {
        showToast('保存失败', 'error');
      }
    } catch (e) {
      showToast('保存失败: ' + e.message, 'error');
    }
  }

  // ─── Modal helpers ──────────────────────────────────────

  function openSettings() {
    loadSettings();
    dom.settingsModal.classList.add('active');
  }

  function openTemplateModal(mode, index) {
    dom.templateModal.classList.add('active');
    if (mode === 'add') {
      dom.templateModalTitle.textContent = '新增模板';
      dom.templateModalText.value = '';
      dom.templateModalSave._mode = 'add';
      dom.templateModalSave._index = -1;
    } else if (mode === 'edit') {
      dom.templateModalTitle.textContent = '修改模板';
      dom.templateModalText.value = state.templates[index] || '';
      dom.templateModalSave._mode = 'edit';
      dom.templateModalSave._index = index;
    }
    dom.templateModalText.focus();
  }

  function closeAllModals() {
    $$('.modal-overlay').forEach((m) => m.classList.remove('active'));
  }

  // ─── Theme toggle ───────────────────────────────────────

  function toggleTheme() {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    dom.themeToggle.textContent = isDark ? '🌙' : '☀️';
    localStorage.setItem('ls-theme', isDark ? 'light' : 'dark');
  }

  function loadTheme() {
    const saved = localStorage.getItem('ls-theme');
    if (saved) {
      document.documentElement.setAttribute('data-theme', saved);
      dom.themeToggle.textContent = saved === 'dark' ? '☀️' : '🌙';
    }
  }

  // ─── Event bindings ─────────────────────────────────────

  function initEvents() {
    // Template CRUD
    dom.addBtn.addEventListener('click', () => openTemplateModal('add'));
    dom.templateModalSave.addEventListener('click', () => {
      const text = dom.templateModalText.value.trim();
      if (!text) { showToast('模板内容不能为空', 'error'); return; }
      const mode = dom.templateModalSave._mode;
      const index = dom.templateModalSave._index;
      dom.templateModal.classList.remove('active');
      if (mode === 'add') addTemplate(text);
      else if (mode === 'edit') updateTemplate(index, text);
    });

    dom.editBtn.addEventListener('click', () => {
      const idx = getSelectedIndex();
      if (idx < 0) { showToast('请先选择一个模板', 'error'); return; }
      openTemplateModal('edit', idx);
    });

    dom.deleteBtn.addEventListener('click', () => {
      const idx = getSelectedIndex();
      if (idx < 0) { showToast('请先选择一个模板', 'error'); return; }
      if (!confirm(`确认删除模板「${state.templates[idx]}」？`)) return;
      deleteTemplate(idx);
    });

    dom.moveUpBtn.addEventListener('click', () => {
      const idx = getSelectedIndex();
      if (idx <= 0) { showToast('已在最顶部', 'info'); return; }
      moveUpTemplate(idx);
    });

    dom.moveDownBtn.addEventListener('click', () => {
      const idx = getSelectedIndex();
      if (idx < 0 || idx >= state.templates.length - 1) { showToast('已在最底部', 'info'); return; }
      moveDownTemplate(idx);
    });

    dom.executeBtn.addEventListener('click', () => {
      const idx = getSelectedIndex();
      if (idx < 0) { showToast('请先选择一个模板', 'error'); return; }
      executeTemplate(state.templates[idx]);
    });

    dom.templateRefresh.addEventListener('click', loadTemplates);

    // Log
    dom.logClearBtn.addEventListener('click', () => {
      dom.logBody.innerHTML = '';
    });

    // Theme
    dom.themeToggle.addEventListener('click', toggleTheme);

    // Settings
    dom.settingsBtn.addEventListener('click', openSettings);
    dom.settingTestBtn.addEventListener('click', testApiConnection);
    dom.settingSaveBtn.addEventListener('click', saveSettings);

    // Help
    dom.helpBtn.addEventListener('click', () => {
      showToast('📖 在 LS 标注页点击书签栏「LS连接器」建立连接后使用', 'info');
    });

    // Close modals on overlay click / close buttons
    $$('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('active');
      });
    });
    $$('.modal-close').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.modal;
        if (id) document.getElementById(id).classList.remove('active');
      });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllModals();
    });
  }

  // ─── Init ───────────────────────────────────────────────

  async function init() {
    loadTheme();
    log('🚀 LS 标注助手启动中...', 'info');
    initEvents();
    await loadTemplates();
    await loadSettings();

    // Start polling
    pollStatus();
    setInterval(pollStatus, POLL_INTERVAL);

    log('✅ 就绪 — 在 LS 标注页点击 LS连接器后即可操作', 'success');
    showToast('🟢 就绪 — 连接 LS 标注页后使用', 'success');
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
