const $ = (selector) => document.querySelector(selector);
const host = $('#host');
const workspace = $('#workspace');
const checkBox = $('#check-result');
const browser = $('#browser');
const instances = $('#instances');
const logs = $('#log-view');
const logTitle = $('#log-title');
const launchStatus = $('#launch-status');
const copyLogsButton = $('#copy-logs');
let selectedLog = '';
let lastLogText = '';

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function busy(button, state, text) {
  if (!button.dataset.label) button.dataset.label = button.textContent.trim();
  button.disabled = state;
  button.textContent = state ? text : button.dataset.label;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function statusLabel(status) {
  return ({ preparing: '准备中', starting: '启动中', running: '运行中', stopping: '停止中', stopped: '已停止', error: '错误' })[status] || status;
}

async function loadHosts() {
  const data = await api('/api/hosts');
  $('#ssh-config').textContent = data.configPath ? `SSH config · ${data.configPath}` : '可直接输入 SSH alias';
  $('#hosts').innerHTML = data.hosts.map((item) => `<option value="${esc(item)}"></option>`).join('');
  if (!host.value && data.hosts[0]) host.value = data.hosts[0];
}

function renderCheck(data) {
  const rows = [
    ['Host', data.hostname || host.value],
    ['OS / arch', `${data.os || '?'} / ${data.arch || '?'}`],
    ['Node', data.node || 'not found'],
    ['Python', data.python || 'not found'],
    ['Conda', data.conda || 'not found'],
    ['Harness runtime', data.ready ? 'ready' : 'Node >= 22.19 required'],
  ];
  checkBox.innerHTML = `
    <div class="runtime-grid">
      ${rows.map(([label, value]) => `<div class="runtime-row"><span class="runtime-label">${esc(label)}</span><span class="runtime-value ${label === 'Harness runtime' ? (data.ready ? 'good' : 'bad') : ''}" title="${esc(value)}">${esc(value)}</span></div>`).join('')}
    </div>
    ${data.ready ? '' : '<div class="runtime-action"><button id="install-runtime" class="button secondary">安装私有 Node 22（无需 sudo）</button></div>'}
  `;
  checkBox.classList.remove('hidden');
  $('#install-runtime')?.addEventListener('click', installRuntime);
}

async function check() {
  const button = $('#check');
  busy(button, true, '检查中…');
  try {
    renderCheck(await api('/api/check', { method: 'POST', body: JSON.stringify({ host: host.value }) }));
  } catch (error) {
    checkBox.innerHTML = `<div class="instance-error">${esc(error.message)}</div>`;
    checkBox.classList.remove('hidden');
  } finally {
    busy(button, false);
  }
}

async function installRuntime() {
  const button = $('#install-runtime');
  busy(button, true, '安装中…');
  try {
    const data = await api('/api/runtime/install', { method: 'POST', body: JSON.stringify({ host: host.value }) });
    renderCheck(data.check);
  } catch (error) {
    launchStatus.textContent = error.message;
    launchStatus.className = 'launch-status bad';
  } finally {
    busy(button, false);
  }
}

async function browse(path = workspace.value || '/') {
  const button = $('#browse');
  busy(button, true, '加载…');
  try {
    const data = await api(`/api/directories?host=${encodeURIComponent(host.value)}&path=${encodeURIComponent(path)}`);
    workspace.value = data.current;
    const parent = data.current === '/' ? '/' : data.current.replace(/\/+[^/]+\/?$/, '') || '/';
    browser.innerHTML = `
      <div class="browser-path" title="${esc(data.current)}">${esc(data.current)}</div>
      <button class="browser-item parent" data-path="${esc(parent)}"><span aria-hidden="true">↰</span><span>上一级</span></button>
      ${data.directories.map((item) => `<button class="browser-item" data-path="${esc(item.path)}"><span class="browser-folder" aria-hidden="true"></span><span>${esc(item.name)}</span></button>`).join('')}
    `;
    browser.classList.remove('hidden');
    browser.querySelectorAll('[data-path]').forEach((item) => { item.onclick = () => browse(item.dataset.path); });
  } catch (error) {
    browser.innerHTML = `<div class="instance-error">${esc(error.message)}</div>`;
    browser.classList.remove('hidden');
  } finally {
    busy(button, false);
  }
}

async function launch() {
  const button = $('#launch');
  busy(button, true, '正在连接…');
  launchStatus.textContent = '正在解析远程环境、部署会话环境插件并启动 Harness…';
  launchStatus.className = 'launch-status';
  try {
    const data = await api('/api/launch', {
      method: 'POST',
      body: JSON.stringify({ host: host.value, workspace: workspace.value, installRuntime: true }),
    });
    launchStatus.textContent = `Harness 已启动 · ${data.url}`;
    launchStatus.className = 'launch-status good';
    await refresh();
    window.open(data.url, '_blank', 'noopener');
  } catch (error) {
    launchStatus.textContent = error.message;
    launchStatus.className = 'launch-status bad';
    await refresh();
  } finally {
    busy(button, false);
  }
}

function card(instance) {
  const terminalUrl = instance.url ? `<a class="instance-action open" href="${esc(instance.url)}" target="_blank" rel="noopener">打开 Harness</a>` : '';
  const stop = !['stopped', 'error'].includes(instance.status) ? `<button class="instance-action" data-stop="${esc(instance.id)}">停止</button>` : '';
  return `
    <div class="instance">
      <div class="instance-top">
        <div class="instance-host"><span class="status-dot ${esc(instance.status)}"></span><strong>${esc(instance.host)}</strong></div>
        <span class="pill ${esc(instance.status)}">${esc(statusLabel(instance.status))}</span>
      </div>
      <div class="instance-path">${esc(instance.workspace)}</div>
      <div class="instance-meta">Node ${esc(instance.nodeVersion || '?')} · ${esc(instance.nodeSource || '?')}</div>
      ${instance.error ? `<div class="instance-error">${esc(instance.error)}</div>` : ''}
      <div class="instance-actions">${terminalUrl}<button class="instance-action" data-log="${esc(instance.id)}">查看日志</button>${stop}</div>
    </div>
  `;
}

function emptyInstances() {
  return '<div class="empty-icon">◇</div><strong>暂无实例</strong><span>启动 Harness 后会显示在这里。</span>';
}

async function refresh() {
  const data = await api('/api/instances');
  const empty = !data.instances.length;
  instances.classList.toggle('empty-state', empty);
  instances.innerHTML = empty ? emptyInstances() : data.instances.map(card).join('');
  instances.querySelectorAll('[data-log]').forEach((button) => { button.onclick = () => showLogs(button.dataset.log); });
  instances.querySelectorAll('[data-stop]').forEach((button) => { button.onclick = () => stop(button.dataset.stop); });
  if (selectedLog) await showLogs(selectedLog, false);
}

async function showLogs(id, select = true) {
  try {
    const data = await api(`/api/instances/${encodeURIComponent(id)}/logs`);
    if (select) selectedLog = id;
    logTitle.textContent = `${data.instance.host} · ${data.instance.workspace}`;
    lastLogText = data.logs || '';
    logs.textContent = lastLogText || '(no logs yet)';
    copyLogsButton.disabled = !lastLogText;
    logs.scrollTop = logs.scrollHeight;
  } catch {
    if (select) selectedLog = '';
  }
}

async function stop(id) {
  await api(`/api/instances/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await refresh();
}

async function copyLogs() {
  if (!lastLogText) return;
  await navigator.clipboard.writeText(lastLogText);
  const original = copyLogsButton.textContent;
  copyLogsButton.textContent = '已复制';
  setTimeout(() => { copyLogsButton.textContent = original; }, 1200);
}

$('#check').onclick = check;
$('#browse').onclick = () => browse();
$('#launch').onclick = launch;
$('#refresh').onclick = refresh;
copyLogsButton.onclick = copyLogs;
host.addEventListener('change', () => checkBox.classList.add('hidden'));
loadHosts().catch((error) => { $('#ssh-config').textContent = error.message; });
refresh();
setInterval(refresh, 4000);
