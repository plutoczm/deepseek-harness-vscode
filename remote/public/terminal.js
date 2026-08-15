const $ = (selector) => document.querySelector(selector);
const terminals = new Map();
let activeId = '';
let splitIds = [];
let profiles = [];
let fontSize = 13;

const XtermTerminal = window.Terminal;
const FitAddonCtor = window.FitAddon?.FitAddon;
const SearchAddonCtor = window.SearchAddon?.SearchAddon;
const WebLinksAddonCtor = window.WebLinksAddon?.WebLinksAddon;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function currentContext(detail = {}) {
  if (detail?.mode) {
    return {
      mode: detail.mode === 'ssh' ? 'ssh' : 'local',
      host: detail.host || '',
      cwd: detail.cwd || detail.workspace || '',
      profile: detail.profile,
    };
  }
  const mode = window.__DSH_APP__?.getMode?.() === 'ssh' ? 'ssh' : 'local';
  return {
    mode,
    host: mode === 'ssh' ? ($('#host')?.value?.trim() || '') : 'Local',
    cwd: $('#workspace')?.value?.trim() || '',
    profile: detail.profile,
  };
}

function contextLabel(meta) {
  if (!meta) return '未选择终端';
  if (meta.mode === 'ssh') return `SSH · ${meta.host} · ${meta.cwd || '~'}`;
  return `LOCAL · ${meta.cwd || '~'}`;
}

function terminalTheme() {
  return {
    background: '#0f1012',
    foreground: '#c8cdd3',
    cursor: '#a7c3ff',
    cursorAccent: '#0f1012',
    selectionBackground: '#315b9c88',
    black: '#1b1d20',
    red: '#ef6b73',
    green: '#62c98a',
    yellow: '#d7b86a',
    blue: '#78a7ff',
    magenta: '#b493e6',
    cyan: '#65c4cb',
    white: '#d6d9dd',
    brightBlack: '#6f757d',
    brightRed: '#ff858c',
    brightGreen: '#7cdc9e',
    brightYellow: '#e8cb80',
    brightBlue: '#9bbdff',
    brightMagenta: '#c9acf1',
    brightCyan: '#84d5da',
    brightWhite: '#f4f5f6',
  };
}

function createTerminalUi(meta) {
  if (!XtermTerminal || !FitAddonCtor) throw new Error('xterm.js 终端组件未加载。');
  const pane = document.createElement('div');
  pane.className = 'terminal-pane hidden-pane';
  pane.dataset.terminalId = meta.id;
  const host = document.createElement('div');
  host.className = 'terminal-host';
  pane.appendChild(host);
  $('#terminal-panes').appendChild(pane);

  const terminal = new XtermTerminal({
    cursorBlink: true,
    cursorStyle: 'block',
    allowTransparency: false,
    convertEol: false,
    fontFamily: '"Cascadia Mono","SFMono-Regular",Consolas,"Liberation Mono",monospace',
    fontSize,
    lineHeight: 1.2,
    letterSpacing: 0,
    scrollback: 10000,
    smoothScrollDuration: 100,
    theme: terminalTheme(),
    windowsMode: false,
  });
  const fitAddon = new FitAddonCtor();
  terminal.loadAddon(fitAddon);
  const searchAddon = SearchAddonCtor ? new SearchAddonCtor() : null;
  if (searchAddon) terminal.loadAddon(searchAddon);
  if (WebLinksAddonCtor) {
    terminal.loadAddon(new WebLinksAddonCtor((event, uri) => {
      event?.preventDefault?.();
      window.open(uri, '_blank', 'noopener');
    }));
  }
  terminal.open(host);

  const client = { meta, pane, host, terminal, fitAddon, searchAddon, socket: null, resizeObserver: null };
  terminals.set(meta.id, client);

  terminal.onData((data) => {
    const socket = client.socket;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
  });
  terminal.onResize(({ cols, rows }) => {
    const socket = client.socket;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }));
  });
  terminal.onTitleChange((title) => {
    if (!title?.trim()) return;
    client.meta.title = title.trim();
    renderTabs();
  });
  host.addEventListener('contextmenu', async (event) => {
    event.preventDefault();
    try {
      const text = await navigator.clipboard.readText();
      if (text) terminal.paste(text);
    } catch {
      // Clipboard permission can be unavailable outside Electron; leave the native shortcut path intact.
    }
  });

  client.resizeObserver = new ResizeObserver(() => fitClient(client));
  client.resizeObserver.observe(pane);
  connectSocket(client);
  renderTabs();
  return client;
}

function connectSocket(client) {
  const meta = client.meta;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/ws/terminal?id=${encodeURIComponent(meta.id)}&token=${encodeURIComponent(meta.token || '')}`;
  const socket = new WebSocket(url);
  client.socket = socket;
  socket.addEventListener('open', () => {
    client.meta.status = 'running';
    renderTabs();
    fitClient(client);
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'snapshot') {
      client.meta = { ...client.meta, ...message.terminal };
      if (message.buffer) client.terminal.write(message.buffer);
      renderTabs();
      fitClient(client);
    } else if (message.type === 'data' && typeof message.data === 'string') {
      client.terminal.write(message.data);
    } else if (message.type === 'exit') {
      client.meta = { ...client.meta, ...message.terminal, status: 'exited' };
      client.terminal.write(`\r\n\x1b[90m[process exited with code ${message.exitCode ?? '?'}]\x1b[0m\r\n`);
      renderTabs();
    }
  });
  socket.addEventListener('close', (event) => {
    if (client.meta.status === 'running' && event.code !== 1000) {
      client.meta.status = 'disconnected';
      client.terminal.write('\r\n\x1b[33m[terminal connection closed]\x1b[0m\r\n');
      renderTabs();
    }
  });
  socket.addEventListener('error', () => {
    window.dshToast?.('终端连接失败', contextLabel(client.meta), 'error');
  });
}

function fitClient(client) {
  if (!client || client.pane.classList.contains('hidden-pane') || !client.pane.isConnected) return;
  requestAnimationFrame(() => {
    try {
      client.fitAddon.fit();
      client.terminal.focus();
    } catch {
      // Panel can be transitioning between collapsed/maximized states.
    }
  });
}

function fitVisible() {
  for (const client of terminals.values()) fitClient(client);
}

function renderTabs() {
  const list = $('#terminal-tabs-list');
  if (!list) return;
  const values = [...terminals.values()];
  list.innerHTML = values.map((client) => {
    const meta = client.meta;
    const title = meta.title || (meta.mode === 'ssh' ? `SSH · ${meta.host}` : 'Terminal');
    const shortMeta = meta.mode === 'ssh' ? meta.host : (meta.profile || 'local');
    return `<button class="terminal-tab-item ${meta.status || ''} ${meta.id === activeId ? 'active' : ''}" type="button" data-terminal-tab="${escapeHtml(meta.id)}">
      <span class="terminal-tab-dot"></span>
      <span class="terminal-tab-copy"><span class="terminal-tab-title">${escapeHtml(title)}</span><span class="terminal-tab-meta">${escapeHtml(shortMeta)}</span></span>
      <span class="terminal-tab-close" data-terminal-close="${escapeHtml(meta.id)}" title="关闭终端">×</span>
    </button>`;
  }).join('');
  list.querySelectorAll('[data-terminal-tab]').forEach((button) => {
    button.addEventListener('click', (event) => {
      if (event.target.closest('[data-terminal-close]')) return;
      showSingle(button.dataset.terminalTab);
    });
  });
  list.querySelectorAll('[data-terminal-close]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTerminal(button.dataset.terminalClose);
    });
  });
  $('#terminal-empty')?.classList.toggle('hidden', values.length > 0);
  updateContext();
}

function updateContext() {
  const client = terminals.get(activeId);
  const element = $('#terminal-context');
  if (!element) return;
  if (!client) {
    element.innerHTML = '<span>未选择终端</span>';
    return;
  }
  const meta = client.meta;
  const modeClass = meta.mode === 'ssh' ? 'ssh' : 'local';
  const mode = meta.mode === 'ssh' ? `SSH · ${meta.host}` : 'LOCAL';
  element.innerHTML = `<strong class="${modeClass}">${escapeHtml(mode)}</strong><span>${escapeHtml(meta.cwd || '~')}</span>`;
  $('#terminal-sidebar-foot').textContent = meta.mode === 'ssh'
    ? `SSH via ~/.ssh/config · ${meta.host}`
    : `${meta.profile || 'default'} · Local PTY`;
}

function showSingle(id) {
  if (!terminals.has(id)) return;
  activeId = id;
  splitIds = [];
  $('#terminal-panes').classList.remove('split');
  for (const [terminalId, client] of terminals) client.pane.classList.toggle('hidden-pane', terminalId !== id);
  renderTabs();
  fitClient(terminals.get(id));
}

function showSplit(firstId, secondId) {
  if (!terminals.has(firstId) || !terminals.has(secondId)) return;
  activeId = secondId;
  splitIds = [firstId, secondId];
  $('#terminal-panes').classList.add('split');
  for (const [terminalId, client] of terminals) client.pane.classList.toggle('hidden-pane', !splitIds.includes(terminalId));
  renderTabs();
  fitVisible();
}

async function createTerminal(detail = {}) {
  const context = currentContext(detail);
  if (context.mode === 'ssh' && !context.host) {
    window.dshToast?.('无法创建 SSH 终端', '请先在首页选择 SSH 服务器。', 'error');
    window.__DSH_APP__?.setView?.('launch');
    return null;
  }
  const response = await api('/api/terminals', {
    method: 'POST',
    body: JSON.stringify({
      mode: context.mode,
      host: context.host,
      cwd: context.cwd,
      profile: context.profile,
      cols: 120,
      rows: 30,
    }),
  });
  const client = createTerminalUi(response);
  showSingle(response.id);
  window.dispatchEvent(new CustomEvent('dsh:terminal-created', {
    detail: {
      mode: response.mode,
      host: response.host,
      workspace: response.cwd,
      cwd: response.cwd,
      terminal: response,
    },
  }));
  window.dshToast?.('终端已创建', contextLabel(response), 'success');
  return client;
}

async function closeTerminal(id) {
  const client = terminals.get(id);
  if (!client) return;
  client.resizeObserver?.disconnect();
  try { client.socket?.close(1000, 'Closed by user'); } catch { /* ignore */ }
  try { client.terminal.dispose(); } catch { /* ignore */ }
  client.pane.remove();
  terminals.delete(id);
  splitIds = splitIds.filter((terminalId) => terminalId !== id);
  await api(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);

  if (activeId === id) activeId = [...terminals.keys()].at(-1) || '';
  if (splitIds.length === 2) showSplit(splitIds[0], splitIds[1]);
  else if (activeId) showSingle(activeId);
  else {
    $('#terminal-panes').classList.remove('split');
    renderTabs();
  }
}

async function splitTerminal() {
  const source = terminals.get(activeId);
  if (!source) {
    await createTerminal();
    return;
  }
  const created = await createTerminal({
    mode: source.meta.mode,
    host: source.meta.host,
    cwd: source.meta.cwd,
    profile: source.meta.profile,
  });
  if (created) showSplit(source.meta.id, created.meta.id);
}

function showSearch() {
  const client = terminals.get(activeId);
  if (!client?.searchAddon) return;
  const box = $('#terminal-search');
  const input = $('#terminal-search-input');
  box.classList.remove('hidden');
  input.focus();
  input.select();
}

function hideSearch() {
  $('#terminal-search')?.classList.add('hidden');
  terminals.get(activeId)?.terminal.focus();
}

function search(next = true) {
  const client = terminals.get(activeId);
  const query = $('#terminal-search-input')?.value || '';
  if (!client?.searchAddon || !query) return;
  if (next) client.searchAddon.findNext(query, { incremental: true, caseSensitive: false });
  else client.searchAddon.findPrevious(query, { incremental: true, caseSensitive: false });
}

function applyFontSize(delta) {
  fontSize = Math.max(10, Math.min(22, fontSize + delta));
  for (const client of terminals.values()) client.terminal.options.fontSize = fontSize;
  fitVisible();
  window.dshToast?.('终端字体', `${fontSize}px`, 'info', 1200);
}

async function loadProfiles() {
  try {
    const data = await api('/api/terminal/profiles');
    profiles = data.profiles || [];
  } catch {
    profiles = [];
  }
}

function renderProfileMenu() {
  const menu = $('#terminal-profile-menu');
  if (!menu) return;
  const mode = window.__DSH_APP__?.getMode?.() === 'ssh' ? 'ssh' : 'local';
  if (mode === 'ssh') {
    menu.innerHTML = '<button type="button" data-profile="ssh"><span>SSH Shell</span><small>当前服务器</small></button>';
  } else {
    menu.innerHTML = (profiles.length ? profiles : [{ id: 'powershell', label: 'Windows PowerShell', recommended: true }]).map((profile) => `
      <button type="button" data-profile="${escapeHtml(profile.id)}"><span>${escapeHtml(profile.label)}</span><small>${profile.recommended ? '推荐' : ''}</small></button>`).join('');
  }
  menu.querySelectorAll('[data-profile]').forEach((button) => {
    button.onclick = () => {
      menu.classList.add('hidden');
      createTerminal({ profile: button.dataset.profile === 'ssh' ? undefined : button.dataset.profile }).catch((error) => window.dshToast?.('终端启动失败', error.message, 'error'));
    };
  });
}

async function restoreTerminals() {
  try {
    const data = await api('/api/terminals');
    for (const meta of data.terminals || []) {
      if (!meta.token || meta.status === 'exited') continue;
      createTerminalUi(meta);
      activeId = meta.id;
    }
    if (activeId) showSingle(activeId);
    else renderTabs();
  } catch {
    renderTabs();
  }
}

function init() {
  if (!XtermTerminal || !FitAddonCtor) {
    $('#terminal-empty')?.querySelector('span')?.replaceChildren(document.createTextNode('xterm.js 资源未加载；请重新安装 Desktop 依赖。'));
    return;
  }
  loadProfiles();
  restoreTerminals();

  window.addEventListener('dsh:new-terminal', (event) => {
    createTerminal(event.detail || {}).catch((error) => window.dshToast?.('终端启动失败', error.message, 'error'));
  });
  window.addEventListener('dsh:terminal-visible', fitVisible);
  window.addEventListener('resize', fitVisible);

  $('#terminal-create')?.addEventListener('click', (event) => {
    event.stopPropagation();
    renderProfileMenu();
    $('#terminal-profile-menu')?.classList.toggle('hidden');
  });
  $('#terminal-new')?.addEventListener('click', () => createTerminal().catch((error) => window.dshToast?.('终端启动失败', error.message, 'error')));
  $('#terminal-split')?.addEventListener('click', () => splitTerminal().catch((error) => window.dshToast?.('分割终端失败', error.message, 'error')));
  $('#terminal-kill')?.addEventListener('click', () => activeId && closeTerminal(activeId));
  $('#terminal-font-minus')?.addEventListener('click', () => applyFontSize(-1));
  $('#terminal-font-plus')?.addEventListener('click', () => applyFontSize(1));
  $('#terminal-search-open')?.addEventListener('click', showSearch);
  $('#terminal-search-close')?.addEventListener('click', hideSearch);
  $('#terminal-search-next')?.addEventListener('click', () => search(true));
  $('#terminal-search-prev')?.addEventListener('click', () => search(false));
  $('#terminal-search-input')?.addEventListener('input', () => search(true));
  $('#terminal-search-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); search(!event.shiftKey); }
    else if (event.key === 'Escape') hideSearch();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#terminal-profile-menu') && !event.target.closest('#terminal-create')) $('#terminal-profile-menu')?.classList.add('hidden');
  });
  document.addEventListener('keydown', (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 'f' && !$('#bottom-panel')?.classList.contains('collapsed') && $('#terminal-panel-view') && !$('#terminal-panel-view').classList.contains('hidden')) {
      event.preventDefault();
      event.stopPropagation();
      showSearch();
    }
  }, true);
}

init();
