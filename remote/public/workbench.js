const RECENTS_KEY = 'dsh.desktop.recentWorkspaces.v1';
const MAX_RECENTS = 9;
const $ = (selector) => document.querySelector(selector);

function readRecents() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    return Array.isArray(value) ? value.slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

function writeRecents(items) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(items.slice(0, MAX_RECENTS)));
}

function workspaceName(workspace) {
  const value = String(workspace || '').replace(/[\\/]+$/u, '');
  return value.split(/[\\/]/u).filter(Boolean).at(-1) || value || 'Workspace';
}

function ageText(timestamp) {
  const time = new Date(timestamp || 0).getTime();
  if (!Number.isFinite(time) || time <= 0) return '';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '昨天' : `${days} 天前`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function rememberWorkspace(detail = {}) {
  const workspace = String(detail.workspace || detail.instance?.workspace || '').trim();
  if (!workspace) return;
  const mode = detail.mode === 'ssh' || detail.instance?.mode === 'ssh' ? 'ssh' : 'local';
  const host = mode === 'ssh' ? String(detail.host || detail.instance?.host || '').trim() : 'Local';
  const key = `${mode}:${host}:${workspace}`;
  const next = [{
    key,
    name: workspaceName(workspace),
    mode,
    host,
    workspace,
    lastUsed: new Date().toISOString(),
  }, ...readRecents().filter((item) => item.key !== key)];
  writeRecents(next);
  renderRecents();
  updateWorkspaceContext(next[0]);
}

function updateWorkspaceContext(item) {
  const target = $('#titlebar-workspace');
  if (!target) return;
  if (!item?.workspace) {
    target.innerHTML = '<strong>未选择工作区</strong><span class="titlebar-workspace-path">从首页选择本机或 SSH 项目</span>';
    return;
  }
  const mode = item.mode === 'ssh' ? `SSH · ${item.host}` : 'LOCAL';
  target.innerHTML = `<strong>${escapeHtml(mode)}</strong><span class="titlebar-workspace-path">${escapeHtml(item.workspace)}</span>`;
}

async function useRecent(item, launchNow = false) {
  const app = window.__DSH_APP__;
  if (!app) return;
  await app.setMode(item.mode);
  const host = $('#host');
  const workspace = $('#workspace');
  if (item.mode === 'ssh' && host) host.value = item.host || '';
  if (workspace) {
    workspace.value = item.workspace;
    workspace.dataset.mode = item.mode;
  }
  app.setView('launch');
  updateWorkspaceContext(item);
  toast('工作区已就绪', `${item.mode === 'ssh' ? `${item.host} · ` : ''}${item.workspace}`, 'success');
  if (launchNow) await app.launch();
}

function renderRecents() {
  const container = $('#recent-workspaces');
  if (!container) return;
  const items = readRecents();
  if (!items.length) {
    container.innerHTML = '<div class="recent-empty">首次启动 Harness 或终端后，这里会出现最近工作区；以后可以一键继续。</div>';
    updateWorkspaceContext(null);
    return;
  }
  container.innerHTML = items.slice(0, 6).map((item, index) => `
    <button class="recent-card" type="button" data-recent-index="${index}">
      <span class="recent-card-top"><span class="recent-mode">${item.mode === 'ssh' ? 'SSH' : 'LOCAL'}</span><strong>${escapeHtml(item.name)}</strong></span>
      <span class="recent-path">${escapeHtml(item.workspace)}</span>
      <span class="recent-meta"><span>${item.mode === 'ssh' ? escapeHtml(item.host) : '本机'}</span><span>${escapeHtml(ageText(item.lastUsed))}</span></span>
    </button>`).join('');
  container.querySelectorAll('[data-recent-index]').forEach((button) => {
    button.addEventListener('click', (event) => useRecent(items[Number(button.dataset.recentIndex)], event.detail >= 2));
  });
  updateWorkspaceContext(items[0]);
}

export function toast(title, message = '', type = 'info', timeout = 3400) {
  const stack = $('#toast-stack');
  if (!stack) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '!' : '•';
  element.innerHTML = `<div class="toast-icon">${icon}</div><div class="toast-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div><button class="toast-close" type="button" aria-label="关闭">×</button>`;
  const close = () => {
    if (!element.isConnected) return;
    element.classList.add('leaving');
    setTimeout(() => element.remove(), 160);
  };
  element.querySelector('.toast-close').onclick = close;
  stack.appendChild(element);
  if (timeout > 0) setTimeout(close, timeout);
}
window.dshToast = toast;

function switchPanel(tab) {
  const panel = $('#bottom-panel');
  if (!panel) return;
  panel.classList.remove('collapsed');
  document.querySelectorAll('[data-panel-tab]').forEach((button) => button.classList.toggle('active', button.dataset.panelTab === tab));
  $('#terminal-panel-view')?.classList.toggle('hidden', tab !== 'terminal');
  $('#output-panel-view')?.classList.toggle('hidden', tab !== 'output');
  $('#panel-collapse').textContent = '⌄';
  if (tab === 'terminal') window.dispatchEvent(new CustomEvent('dsh:terminal-visible'));
}

function togglePanel(tab = 'terminal') {
  const panel = $('#bottom-panel');
  if (!panel) return;
  if (panel.classList.contains('collapsed')) switchPanel(tab);
  else panel.classList.add('collapsed');
  $('#panel-collapse').textContent = panel.classList.contains('collapsed') ? '⌃' : '⌄';
}

function setPanelMaximized() {
  const panel = $('#bottom-panel');
  if (!panel) return;
  const maximized = panel.classList.toggle('maximized');
  panel.style.height = maximized ? 'calc(100vh - var(--titlebar-height) - 10px)' : '';
  $('#panel-maximize').textContent = maximized ? '❐' : '□';
  panel.classList.remove('collapsed');
  window.dispatchEvent(new CustomEvent('dsh:terminal-visible'));
}

function paletteCommands() {
  const app = window.__DSH_APP__;
  const mode = app?.getMode?.() || 'local';
  return [
    { icon: '⌂', title: '打开首页', detail: '最近工作区与快速启动', keys: '', run: () => app?.setView('launch') },
    { icon: '◉', title: '打开会话中心', detail: '查看 Harness 实例与运行状态', keys: '', run: () => app?.setView('sessions') },
    { icon: '▣', title: '打开远程文件', detail: '浏览 SSH 服务器文件', keys: '', run: () => app?.setView('files') },
    { icon: '⚙', title: '打开设置', detail: '外观、运行环境与诊断', keys: '', run: () => app?.setView('settings') },
    { icon: '>_', title: `新建${mode === 'ssh' ? ' SSH' : '本机'}终端`, detail: '在当前工作区打开交互式 PTY', keys: 'Ctrl+Shift+`', run: () => window.dispatchEvent(new CustomEvent('dsh:new-terminal')) },
    { icon: '↗', title: '启动 Harness', detail: '使用当前运行位置和工作区启动', keys: '', run: () => app?.launch?.() },
    { icon: '▤', title: '显示 / 隐藏终端', detail: '切换底部 Terminal 面板', keys: 'Ctrl+`', run: () => togglePanel('terminal') },
    { icon: '↻', title: '刷新实例', detail: '重新读取 Harness 会话状态', keys: '', run: () => app?.refresh?.() },
  ];
}

let selectedCommand = 0;
function renderCommandResults(filter = '') {
  const results = $('#command-results');
  if (!results) return [];
  const needle = filter.trim().toLowerCase();
  const commands = paletteCommands().filter((command) => !needle || `${command.title} ${command.detail}`.toLowerCase().includes(needle));
  selectedCommand = Math.min(selectedCommand, Math.max(0, commands.length - 1));
  results.innerHTML = commands.map((command, index) => `
    <button class="command-row ${index === selectedCommand ? 'active' : ''}" type="button" data-command-index="${index}">
      <span class="command-row-icon">${escapeHtml(command.icon)}</span>
      <span class="command-row-copy"><strong>${escapeHtml(command.title)}</strong><span>${escapeHtml(command.detail)}</span></span>
      <span class="command-shortcut">${escapeHtml(command.keys)}</span>
    </button>`).join('') || '<div class="recent-empty">没有匹配命令</div>';
  results.querySelectorAll('[data-command-index]').forEach((button) => {
    button.onclick = () => runCommand(commands[Number(button.dataset.commandIndex)]);
  });
  return commands;
}

function openPalette() {
  const backdrop = $('#command-palette-backdrop');
  if (!backdrop) return;
  selectedCommand = 0;
  backdrop.classList.remove('hidden');
  const input = $('#command-input');
  input.value = '';
  renderCommandResults();
  requestAnimationFrame(() => input.focus());
}

function closePalette() {
  $('#command-palette-backdrop')?.classList.add('hidden');
}

function runCommand(command) {
  if (!command) return;
  closePalette();
  Promise.resolve(command.run()).catch((error) => toast('操作失败', error.message, 'error'));
}

async function runDiagnostics() {
  const button = $('#run-diagnostics');
  if (!button) return;
  button.disabled = true;
  button.textContent = '检查中…';
  try {
    const local = await fetch('/api/local/check').then((response) => response.json());
    $('#diag-node').textContent = local.node || 'not found';
    $('#diag-runtime').textContent = local.ready ? 'Ready ✓' : `需要 Node >= ${local.minNode}`;
    $('#diag-python').textContent = local.python || 'not found';
    const mode = window.__DSH_APP__?.getMode?.();
    const host = $('#host')?.value?.trim();
    if (mode === 'ssh' && host) {
      const remote = await fetch('/api/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host }) }).then((response) => response.json());
      $('#diag-ssh').textContent = remote.ready ? `${host} ✓` : `${host} · runtime issue`;
    } else {
      $('#diag-ssh').textContent = '未选择 SSH';
    }
    $('#diag-terminal').textContent = window.Terminal ? 'xterm.js Ready ✓' : 'xterm.js unavailable';
    toast('诊断完成', '本机运行时、SSH 上下文和终端组件已检查。', 'success');
  } catch (error) {
    toast('诊断失败', error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '运行诊断';
  }
}

function init() {
  renderRecents();
  $('#command-open')?.addEventListener('click', openPalette);
  $('#activity-brand')?.addEventListener('click', () => window.__DSH_APP__?.setView('launch'));
  $('#panel-collapse')?.addEventListener('click', () => togglePanel());
  $('#panel-maximize')?.addEventListener('click', setPanelMaximized);
  $('#panel-close')?.addEventListener('click', () => $('#bottom-panel')?.classList.add('collapsed'));
  $('#open-terminal')?.addEventListener('click', () => window.dispatchEvent(new CustomEvent('dsh:new-terminal')));
  $('#files-open-terminal')?.addEventListener('click', () => window.dispatchEvent(new CustomEvent('dsh:new-terminal', { detail: { mode: 'ssh', host: $('#host')?.value, cwd: $('#files-path')?.value || '/' } })));
  $('#run-diagnostics')?.addEventListener('click', runDiagnostics);
  document.querySelectorAll('[data-panel-tab]').forEach((button) => button.addEventListener('click', () => switchPanel(button.dataset.panelTab)));
  document.querySelectorAll('[data-settings-target]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-settings-target]').forEach((item) => item.classList.toggle('active', item === button));
    document.getElementById(button.dataset.settingsTarget)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  const backdrop = $('#command-palette-backdrop');
  backdrop?.addEventListener('mousedown', (event) => { if (event.target === backdrop) closePalette(); });
  const commandInput = $('#command-input');
  commandInput?.addEventListener('input', () => { selectedCommand = 0; renderCommandResults(commandInput.value); });
  commandInput?.addEventListener('keydown', (event) => {
    const commands = renderCommandResults(commandInput.value);
    if (event.key === 'ArrowDown') { event.preventDefault(); selectedCommand = Math.min(commands.length - 1, selectedCommand + 1); renderCommandResults(commandInput.value); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); selectedCommand = Math.max(0, selectedCommand - 1); renderCommandResults(commandInput.value); }
    else if (event.key === 'Enter') { event.preventDefault(); runCommand(commands[selectedCommand]); }
    else if (event.key === 'Escape') closePalette();
  });

  window.addEventListener('dsh:launched', (event) => {
    rememberWorkspace(event.detail);
    toast('Harness 已启动', `${event.detail?.mode === 'ssh' ? `${event.detail.host} · ` : ''}${event.detail?.workspace || ''}`, 'success');
  });
  window.addEventListener('dsh:terminal-created', (event) => {
    rememberWorkspace(event.detail);
    switchPanel('terminal');
  });
  window.addEventListener('dsh:show-output', () => switchPanel('output'));
  window.addEventListener('dsh:new-terminal', () => switchPanel('terminal'));

  document.addEventListener('keydown', (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openPalette();
      return;
    }
    if (modifier && event.key === '`') {
      event.preventDefault();
      if (event.shiftKey) window.dispatchEvent(new CustomEvent('dsh:new-terminal'));
      else togglePanel('terminal');
    }
  }, true);
}

init();
