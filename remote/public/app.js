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
const filesTab = $('#files-tab');
const localRuntimeNote = $('#local-runtime-note');
const wallpaperEnabled = $('#wallpaper-enabled');
const wallpaperUrl = $('#wallpaper-url');
const wallpaperOpacity = $('#wallpaper-opacity');
const wallpaperBlur = $('#wallpaper-blur');
const wallpaperOpacityValue = $('#wallpaper-opacity-value');
const wallpaperBlurValue = $('#wallpaper-blur-value');
const wallpaperPreview = $('#wallpaper-preview');
let runMode = 'local';
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
  if (name === 'files' && runMode !== 'ssh') {
    window.dshToast?.('远程文件需要 SSH 模式', '先在首页切换到 SSH 并选择服务器。', 'info');
    name = 'launch';
  }
  document.querySelectorAll('.view-tab').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  const views = ['launch', 'sessions', 'files', 'settings'];
  for (const view of views) document.getElementById(`${view}-view`)?.classList.toggle('hidden', view !== name);
  if (name === 'files') {
    filesHostLabel.textContent = host.value.trim() || '未选择服务器';
    if (host.value.trim()) loadRemoteFiles(filesPath.value || currentFilesDirectory || '/').catch(() => undefined);
  } else if (name === 'sessions') {
    refresh().catch(() => undefined);
  } else if (name === 'settings') {
    loadAppearance();
  }
}

async function loadHosts() {
  const data = await api('/api/hosts');
  $('#ssh-config').textContent = data.configPath ? `SSH config · ${data.configPath}` : '可直接输入 SSH alias';
  $('#hosts').innerHTML = data.hosts.map((item) => `<option value="${esc(item)}"></option>`).join('');
  if (!host.value && data.hosts[0]) host.value = data.hosts[0];
  filesHostLabel.textContent = host.value || '未选择服务器';
}

function renderCheck(data, local = false) {
  const rows = [
    ['Host', local ? 'Local' : (data.hostname || host.value)],
    ['OS / arch', `${data.os || '?'} / ${data.arch || '?'}`],
    ['Node', data.node || 'not found'],
    ['Python', data.python || 'not found'],
    ['Conda', data.conda || 'not found'],
    ['Harness runtime', data.ready ? 'ready' : `Node >= ${data.minNode || '22.19'} required`],
  ];
  const markup = `
    <div class="runtime-grid">
      ${rows.map(([label, value]) => `<div class="runtime-row"><span class="runtime-label">${esc(label)}</span><span class="runtime-value ${label === 'Harness runtime' ? (data.ready ? 'good' : 'bad') : ''}" title="${esc(value)}">${esc(value)}</span></div>`).join('')}
    </div>
    ${local || data.ready ? '' : '<div class="runtime-action"><button id="install-runtime" class="button secondary">安装私有 Node 22（无需 sudo）</button></div>'}
  `;
  if (local) {
    localRuntimeNote.innerHTML = markup;
    localRuntimeNote.classList.toggle('bad', !data.ready);
  } else {
    checkBox.innerHTML = markup;
    checkBox.classList.remove('hidden');
    $('#install-runtime')?.addEventListener('click', installRuntime);
  }
}

async function checkLocal() {
  try {
    const data = await api('/api/local/check');
    renderCheck(data, true);
    return data;
  } catch (error) {
    localRuntimeNote.textContent = error.message;
    localRuntimeNote.classList.add('bad');
    return undefined;
  }
}

async function check() {
  const button = $('#check');
  busy(button, true, '检查中…');
  try {
    const data = await api('/api/check', { method: 'POST', body: JSON.stringify({ host: host.value }) });
    renderCheck(data);
    window.dshToast?.('SSH 检查完成', `${host.value} · ${data.ready ? 'Harness runtime ready' : '需要处理运行环境'}`, data.ready ? 'success' : 'info');
  } catch (error) {
    checkBox.innerHTML = `<div class="instance-error">${esc(error.message)}</div>`;
    checkBox.classList.remove('hidden');
    window.dshToast?.('SSH 检查失败', error.message, 'error');
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
    window.dshToast?.('Node 22 已安装', `${host.value} · ${data.version}`, 'success');
  } catch (error) {
    launchStatus.textContent = error.message;
    launchStatus.className = 'launch-status bad';
    window.dshToast?.('运行时安装失败', error.message, 'error');
  } finally {
    busy(button, false);
  }
}

async function setMode(mode) {
  runMode = mode === 'ssh' ? 'ssh' : 'local';
  document.querySelectorAll('[data-target]').forEach((button) => button.classList.toggle('active', button.dataset.target === runMode));
  document.querySelectorAll('.remote-only').forEach((element) => element.classList.toggle('hidden-by-mode', runMode !== 'ssh'));
  filesTab.classList.toggle('files-tab-disabled', runMode !== 'ssh');
  $('#workspace-label').textContent = runMode === 'ssh' ? '远程工作区' : '本机工作区';
  $('#workspace-note').textContent = runMode === 'ssh' ? 'Harness 与集成终端都以服务器上的这个目录作为上下文' : 'Harness 与集成终端都以本机这个目录作为上下文';
  $('#mode-note').textContent = runMode === 'ssh'
    ? 'SSH 模式通过系统 SSH 配置连接服务器；Harness、远程文件和终端共用同一个服务器上下文。'
    : '本机模式直接使用本机 Node/npm 启动官方 DeepSeek Harness，不经过 SSH。';
  $('#launch').querySelector('span').textContent = runMode === 'ssh' ? '连接并打开 Harness' : '打开本机 Harness';
  launchStatus.textContent = runMode === 'ssh' ? '准备好后启动远程 Harness。' : '准备好后启动本机 Harness。';
  browser.classList.add('hidden');
  if (runMode === 'local') {
    setView('launch');
    const runtime = await checkLocal();
    if (!workspace.value || workspace.dataset.mode === 'ssh') {
      try {
        const data = await api('/api/local/directories');
        workspace.value = data.current;
        workspace.dataset.mode = 'local';
      } catch { /* leave editable */ }
    }
    if (runtime && !runtime.ready) launchStatus.textContent = `本机需要 Node.js >= ${runtime.minNode} 且 npm/npx 可用。`;
  } else {
    if (workspace.dataset.mode === 'local') workspace.value = '';
    workspace.dataset.mode = 'ssh';
  }
}

async function browse(pathValue = workspace.value) {
  const button = $('#browse');
  busy(button, true, '加载…');
  try {
    const endpoint = runMode === 'local'
      ? `/api/local/directories?path=${encodeURIComponent(pathValue || '')}`
      : `/api/directories?host=${encodeURIComponent(host.value)}&path=${encodeURIComponent(pathValue || '/')}`;
    const data = await api(endpoint);
    workspace.value = data.current;
    workspace.dataset.mode = runMode;
    const parent = data.parent || (data.current === '/' ? '/' : data.current.replace(/\/+[^/]+\/?$/, '') || '/');
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
  busy(button, true, runMode === 'ssh' ? '正在连接…' : '正在启动…');
  launchStatus.textContent = runMode === 'ssh'
    ? '正在解析远程环境、部署插件并启动 Harness…'
    : '正在检查本机 Node/npm、部署遥测插件并启动 Harness…';
  launchStatus.className = 'launch-status';
  try {
    const data = await api('/api/launch', {
      method: 'POST',
      body: JSON.stringify({
        mode: runMode,
        host: runMode === 'ssh' ? host.value : undefined,
        workspace: workspace.value,
        installRuntime: true,
      }),
    });
    launchStatus.textContent = `Harness 已启动 · ${data.url}`;
    launchStatus.className = 'launch-status good';
    window.dispatchEvent(new CustomEvent('dsh:launched', { detail: {
      mode: runMode,
      host: runMode === 'ssh' ? host.value : 'Local',
      workspace: workspace.value,
      instance: data,
    } }));
    await refresh();
    window.open(data.url, '_blank', 'noopener');
  } catch (error) {
    launchStatus.textContent = error.message;
    launchStatus.className = 'launch-status bad';
    window.dshToast?.('Harness 启动失败', error.message, 'error', 5200);
    await refresh();
  } finally {
    busy(button, false);
  }
}

function renderAppearance(settings) {
  wallpaperEnabled.checked = settings.enabled !== false;
  wallpaperUrl.value = settings.imageUrl || '';
  wallpaperOpacity.value = String(settings.opacity ?? 82);
  wallpaperBlur.value = String(settings.blur ?? 16);
  wallpaperOpacityValue.textContent = `${wallpaperOpacity.value}%`;
  wallpaperBlurValue.textContent = `${wallpaperBlur.value}px`;
  wallpaperPreview.style.backgroundImage = wallpaperEnabled.checked && wallpaperUrl.value ? `url("${wallpaperUrl.value.replaceAll('"', '%22')}")` : 'none';
  wallpaperPreview.style.opacity = String(Math.max(0.5, Number(wallpaperOpacity.value) / 100));
  wallpaperPreview.style.filter = Number(wallpaperBlur.value) > 0 ? `blur(${Math.min(4, Number(wallpaperBlur.value) / 5)}px)` : 'none';
}

async function loadAppearance() {
  try { renderAppearance(await api('/api/appearance')); } catch { /* keep defaults */ }
}

async function saveAppearance(reset = false) {
  const button = reset ? $('#reset-wallpaper') : $('#save-wallpaper');
  busy(button, true, '应用中…');
  try {
    const settings = await api('/api/appearance', {
      method: 'POST',
      body: JSON.stringify(reset ? { reset: true } : {
        enabled: wallpaperEnabled.checked,
        imageUrl: wallpaperUrl.value,
        opacity: Number(wallpaperOpacity.value),
        blur: Number(wallpaperBlur.value),
      }),
    });
    renderAppearance(settings);
    launchStatus.textContent = 'Harness 背景已更新，已打开的 Local / SSH 窗口也会同步。';
    launchStatus.className = 'launch-status good';
    window.dshToast?.('Harness 背景已更新', 'Local 与 SSH 窗口将同步使用新的外观设置。', 'success');
  } catch (error) {
    launchStatus.textContent = error.message;
    launchStatus.className = 'launch-status bad';
    window.dshToast?.('背景设置失败', error.message, 'error');
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
    row.oncontextmenu = (event) => {
      if (row.dataset.fileType !== 'directory') return;
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('dsh:new-terminal', { detail: { mode: 'ssh', host: host.value.trim(), cwd: row.dataset.filePath } }));
    };
  });
}

async function loadRemoteFiles(pathValue = filesPath.value || '/') {
  const selectedHost = host.value.trim();
  if (!selectedHost) {
    filesMessage.textContent = '请先在首页选择 SSH 服务器。';
    filesMessage.className = 'files-message bad';
    return;
  }
  filesHostLabel.textContent = selectedHost;
  filesMessage.textContent = `正在读取 ${pathValue} …`;
  filesMessage.className = 'files-message';
  try {
    const data = await api(`/api/files?host=${encodeURIComponent(selectedHost)}&path=${encodeURIComponent(pathValue || '/')}`);
    currentFilesDirectory = data.current;
    currentFilesParent = data.parent;
    filesPath.value = data.current;
    filesMessage.textContent = `${data.entries.length} 个项目 · ${data.current} · 右键目录可直接在终端打开`;
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

async function previewRemoteFile(pathValue) {
  const selectedHost = host.value.trim();
  previewName.textContent = '加载中…';
  previewPath.textContent = pathValue;
  filePreview.className = 'file-preview empty-preview';
  filePreview.innerHTML = '<div class="preview-spinner"></div><span>正在通过 SSH 读取文件…</span>';
  copyFilePathButton.disabled = true;
  try {
    renderPreview(await api(`/api/file?host=${encodeURIComponent(selectedHost)}&path=${encodeURIComponent(pathValue)}`));
  } catch (error) {
    selectedFilePath = pathValue;
    previewName.textContent = pathValue.split('/').at(-1) || pathValue;
    previewPath.textContent = pathValue;
    copyFilePathButton.disabled = false;
    filePreview.className = 'file-preview empty-preview';
    filePreview.innerHTML = `<div class="preview-empty-icon error">!</div><strong>无法预览</strong><span>${esc(error.message)}</span>`;
  }
}

async function useFilesDirectoryAsWorkspace() {
  await setMode('ssh');
  workspace.value = currentFilesDirectory || filesPath.value || '/';
  workspace.dataset.mode = 'ssh';
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
  const stopButton = !['stopped', 'error'].includes(instance.status) ? `<button class="instance-action" data-stop="${esc(instance.id)}">停止</button>` : '';
  const terminalButton = !['stopped', 'error'].includes(instance.status) ? `<button class="instance-action terminal-action" data-terminal-instance="${esc(instance.id)}">&gt;_ 打开终端</button>` : '';
  const mode = instance.mode === 'local' ? 'LOCAL' : 'SSH';
  return `
    <div class="instance">
      <div class="instance-top">
        <div class="instance-host"><span class="status-dot ${esc(instance.status)}"></span><strong>${esc(instance.host)}</strong><span class="instance-mode">${mode}</span></div>
        <span class="pill ${esc(instance.status)}">${esc(statusLabel(instance.status))}</span>
      </div>
      <div class="instance-path">${esc(instance.workspace)}</div>
      <div class="instance-meta">Node ${esc(instance.nodeVersion || '?')} · ${esc(instance.nodeSource || '?')}</div>
      ${instance.error ? `<div class="instance-error">${esc(instance.error)}</div>` : ''}
      <div class="instance-actions">${terminalUrl}${terminalButton}<button class="instance-action" data-log="${esc(instance.id)}">查看输出</button>${stopButton}</div>
    </div>
  `;
}

function emptyInstances() {
  return '<div class="empty-icon">◇</div><strong>暂无实例</strong><span>从首页启动 Harness 后会显示在这里。</span>';
}

async function refresh() {
  const data = await api('/api/instances');
  const empty = !data.instances.length;
  instances.classList.toggle('empty-state', empty);
  instances.innerHTML = empty ? emptyInstances() : data.instances.map(card).join('');
  instances.querySelectorAll('[data-log]').forEach((button) => { button.onclick = () => showLogs(button.dataset.log); });
  instances.querySelectorAll('[data-stop]').forEach((button) => { button.onclick = () => stop(button.dataset.stop); });
  instances.querySelectorAll('[data-terminal-instance]').forEach((button) => {
    button.onclick = () => {
      const instance = data.instances.find((item) => item.id === button.dataset.terminalInstance);
      if (!instance) return;
      window.dispatchEvent(new CustomEvent('dsh:new-terminal', { detail: {
        mode: instance.mode,
        host: instance.host,
        cwd: instance.workspace,
        workspace: instance.workspace,
      } }));
    };
  });
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
    if (select) window.dispatchEvent(new CustomEvent('dsh:show-output'));
  } catch {
    if (select) selectedLog = '';
  }
}

async function stop(id) {
  await api(`/api/instances/${encodeURIComponent(id)}`, { method: 'DELETE' });
  window.dshToast?.('Harness 已停止', '实例已结束。', 'info');
  await refresh();
}

async function copyLogs() {
  if (!lastLogText) return;
  await navigator.clipboard.writeText(lastLogText);
  const original = copyLogsButton.textContent;
  copyLogsButton.textContent = '已复制';
  setTimeout(() => { copyLogsButton.textContent = original; }, 1200);
}

window.__DSH_APP__ = {
  setMode,
  setView,
  refresh,
  launch,
  getMode: () => runMode,
};

document.querySelectorAll('.view-tab').forEach((button) => { button.onclick = () => setView(button.dataset.view); });
document.querySelectorAll('[data-target]').forEach((button) => { button.onclick = () => setMode(button.dataset.target); });
$('#check').onclick = check;
$('#browse').onclick = () => browse();
$('#launch').onclick = launch;
$('#refresh').onclick = refresh;
$('#files-go').onclick = () => loadRemoteFiles(filesPath.value || '/');
$('#files-up').onclick = () => loadRemoteFiles(currentFilesParent || '/');
$('#files-refresh').onclick = () => loadRemoteFiles(currentFilesDirectory || filesPath.value || '/');
$('#files-use-workspace').onclick = useFilesDirectoryAsWorkspace;
$('#save-wallpaper').onclick = () => saveAppearance(false);
$('#reset-wallpaper').onclick = () => saveAppearance(true);
filesPath.addEventListener('keydown', (event) => { if (event.key === 'Enter') loadRemoteFiles(filesPath.value || '/'); });
copyFilePathButton.onclick = copyFilePath;
copyLogsButton.onclick = copyLogs;
host.addEventListener('change', () => {
  checkBox.classList.add('hidden');
  filesHostLabel.textContent = host.value.trim() || '未选择服务器';
  selectedFilePath = '';
});
for (const control of [wallpaperEnabled, wallpaperUrl, wallpaperOpacity, wallpaperBlur]) {
  control.addEventListener('input', () => renderAppearance({
    enabled: wallpaperEnabled.checked,
    imageUrl: wallpaperUrl.value,
    opacity: Number(wallpaperOpacity.value),
    blur: Number(wallpaperBlur.value),
  }));
}
loadHosts().catch((error) => { $('#ssh-config').textContent = error.message; });
loadAppearance();
setMode('local');
refresh();
setInterval(refresh, 4000);
