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
const filesPath = $('#files-path');
const filesHostLabel = $('#files-host-label');
const filesMessage = $('#files-message');
const remoteFileList = $('#remote-file-list');
const filePreview = $('#file-preview');
const previewName = $('#preview-name');
const previewPath = $('#preview-path');
const copyFilePathButton = $('#copy-file-path');
let selectedLog = '';
let lastLogText = '';
let currentFilesDirectory = '/';
let currentFilesParent = '/';
let selectedFilePath = '';

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

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value;
  let index = -1;
  do {
    scaled /= 1024;
    index += 1;
  } while (scaled >= 1024 && index < units.length - 1);
  return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date).replaceAll('/', '-');
}

function fileTypeLabel(type) {
  return ({ directory: '目录', file: '文件', symlink: '链接', other: '其他' })[type] || type;
}

function setView(name) {
  document.querySelectorAll('.view-tab').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  $('#launch-view').classList.toggle('hidden', name !== 'launch');
  $('#files-view').classList.toggle('hidden', name !== 'files');
  if (name === 'files') {
    filesHostLabel.textContent = host.value.trim() || '未选择服务器';
    if (host.value.trim()) loadRemoteFiles(filesPath.value || currentFilesDirectory || '/').catch(() => undefined);
  }
}

async function loadHosts() {
  const data = await api('/api/hosts');
  $('#ssh-config').textContent = data.configPath ? `SSH config · ${data.configPath}` : '可直接输入 SSH alias';
  $('#hosts').innerHTML = data.hosts.map((item) => `<option value="${esc(item)}"></option>`).join('');
  if (!host.value && data.hosts[0]) host.value = data.hosts[0];
  filesHostLabel.textContent = host.value || '未选择服务器';
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

function renderRemoteEntries(data) {
  if (!data.entries.length) {
    remoteFileList.className = 'remote-file-list empty-file-list';
    remoteFileList.innerHTML = '<div class="file-empty"><span>◇</span><strong>目录为空</strong><small>这里没有可显示的文件或子目录。</small></div>';
    return;
  }
  remoteFileList.className = 'remote-file-list';
  remoteFileList.innerHTML = data.entries.map((entry) => {
    const directory = entry.type === 'directory';
    const iconClass = directory ? 'directory' : entry.type === 'symlink' ? 'symlink' : 'file';
    return `<button class="remote-file-row" data-file-path="${esc(entry.path)}" data-file-type="${esc(entry.type)}" title="${esc(entry.path)}">
      <span class="remote-file-name"><span class="file-icon ${iconClass}" aria-hidden="true"></span><span class="file-name-copy"><strong>${esc(entry.name)}</strong><small>${esc(fileTypeLabel(entry.type))}</small></span></span>
      <span class="remote-file-size">${directory ? '—' : esc(formatBytes(entry.size))}</span>
      <span class="remote-file-date">${esc(formatDate(entry.mtime))}</span>
    </button>`;
  }).join('');
  remoteFileList.querySelectorAll('[data-file-path]').forEach((row) => {
    row.onclick = () => {
      if (row.dataset.fileType === 'directory') loadRemoteFiles(row.dataset.filePath);
      else previewRemoteFile(row.dataset.filePath);
    };
  });
}

async function loadRemoteFiles(path = filesPath.value || '/') {
  const selectedHost = host.value.trim();
  if (!selectedHost) {
    filesMessage.textContent = '请先在 Harness 页选择 SSH 服务器。';
    filesMessage.className = 'files-message bad';
    return;
  }
  filesHostLabel.textContent = selectedHost;
  filesMessage.textContent = `正在读取 ${path} …`;
  filesMessage.className = 'files-message';
  try {
    const data = await api(`/api/files?host=${encodeURIComponent(selectedHost)}&path=${encodeURIComponent(path || '/')}`);
    currentFilesDirectory = data.current;
    currentFilesParent = data.parent;
    filesPath.value = data.current;
    filesMessage.textContent = `${data.entries.length} 个项目 · ${data.current}`;
    filesMessage.className = 'files-message';
    renderRemoteEntries(data);
  } catch (error) {
    filesMessage.textContent = error.message;
    filesMessage.className = 'files-message bad';
    remoteFileList.className = 'remote-file-list empty-file-list';
    remoteFileList.innerHTML = `<div class="file-empty error"><span>!</span><strong>无法读取目录</strong><small>${esc(error.message)}</small></div>`;
  }
}

function renderPreview(data) {
  selectedFilePath = data.path;
  previewName.textContent = data.name;
  previewPath.textContent = data.path;
  copyFilePathButton.disabled = false;

  if (data.kind === 'image') {
    filePreview.className = 'file-preview image-preview';
    filePreview.innerHTML = `<img src="data:${esc(data.mime)};base64,${data.base64}" alt="${esc(data.name)}"><div class="preview-meta">${esc(formatBytes(data.size))}</div>`;
    return;
  }

  if (data.kind === 'text') {
    const notice = data.truncated ? `<div class="preview-notice">文件较大，仅显示前 ${esc(formatBytes(data.previewLimit))}。</div>` : '';
    filePreview.className = 'file-preview text-preview';
    filePreview.innerHTML = `${notice}<pre class="preview-code"></pre>`;
    filePreview.querySelector('.preview-code').textContent = data.content || '';
    return;
  }

  filePreview.className = 'file-preview empty-preview';
  filePreview.innerHTML = `<div class="preview-empty-icon">◫</div><strong>二进制文件</strong><span>${esc(formatBytes(data.size))} · 当前仅显示文件信息，不直接解析内容。</span>`;
}

async function previewRemoteFile(path) {
  const selectedHost = host.value.trim();
  previewName.textContent = '加载中…';
  previewPath.textContent = path;
  filePreview.className = 'file-preview empty-preview';
  filePreview.innerHTML = '<div class="preview-spinner"></div><span>正在通过 SSH 读取文件…</span>';
  copyFilePathButton.disabled = true;
  try {
    renderPreview(await api(`/api/file?host=${encodeURIComponent(selectedHost)}&path=${encodeURIComponent(path)}`));
  } catch (error) {
    selectedFilePath = path;
    previewName.textContent = path.split('/').at(-1) || path;
    previewPath.textContent = path;
    copyFilePathButton.disabled = false;
    filePreview.className = 'file-preview empty-preview';
    filePreview.innerHTML = `<div class="preview-empty-icon error">!</div><strong>无法预览</strong><span>${esc(error.message)}</span>`;
  }
}

function useFilesDirectoryAsWorkspace() {
  workspace.value = currentFilesDirectory || filesPath.value || '/';
  launchStatus.textContent = `已选择工作区 · ${workspace.value}`;
  launchStatus.className = 'launch-status good';
  setView('launch');
  workspace.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function copyFilePath() {
  if (!selectedFilePath) return;
  await navigator.clipboard.writeText(selectedFilePath);
  const original = copyFilePathButton.textContent;
  copyFilePathButton.textContent = '已复制';
  setTimeout(() => { copyFilePathButton.textContent = original; }, 1200);
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

document.querySelectorAll('.view-tab').forEach((button) => { button.onclick = () => setView(button.dataset.view); });
$('#check').onclick = check;
$('#browse').onclick = () => browse();
$('#launch').onclick = launch;
$('#refresh').onclick = refresh;
$('#files-go').onclick = () => loadRemoteFiles(filesPath.value || '/');
$('#files-up').onclick = () => loadRemoteFiles(currentFilesParent || '/');
$('#files-refresh').onclick = () => loadRemoteFiles(currentFilesDirectory || filesPath.value || '/');
$('#files-use-workspace').onclick = useFilesDirectoryAsWorkspace;
filesPath.addEventListener('keydown', (event) => { if (event.key === 'Enter') loadRemoteFiles(filesPath.value || '/'); });
copyFilePathButton.onclick = copyFilePath;
copyLogsButton.onclick = copyLogs;
host.addEventListener('change', () => {
  checkBox.classList.add('hidden');
  filesHostLabel.textContent = host.value.trim() || '未选择服务器';
  selectedFilePath = '';
});
loadHosts().catch((error) => { $('#ssh-config').textContent = error.message; });
refresh();
setInterval(refresh, 4000);
