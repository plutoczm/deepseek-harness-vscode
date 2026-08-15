window.__ModuleLoader__.load({ id: "dsh-openssh-vpn", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const TAG = '[dsh-openssh-vpn]';
const API = '/dsh-openssh-vpn/api';
const HEADER = { 'X-DSH-OpenSSH-VPN': '1' };
let React = null;
try { React = require('react'); } catch (e) { React = null; }
let harnessSessions = null;
let harnessWorkspaces = null;

let panelOpen = false;
const panelListeners = new Set();
const panelStore = {
  get: function () { return panelOpen; },
  open: function () { panelOpen = true; panelListeners.forEach(function (fn) { fn(); }); },
  close: function () { panelOpen = false; panelListeners.forEach(function (fn) { fn(); }); },
  subscribe: function (fn) { panelListeners.add(fn); return function () { panelListeners.delete(fn); }; },
};

async function api(path, options) {
  const opts = options || {};
  const headers = Object.assign({}, HEADER, opts.headers || {});
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await window.fetch(API + path, Object.assign({}, opts, { headers: headers }));
  const raw = await response.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
  if (!response.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || raw || ('HTTP ' + response.status));
  }
  return data;
}

function stateLabel(value) {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}
function statusTone(route) {
  if (route === 'proxy' || route === 'direct') return 'ok';
  if (route === 'checking') return 'warn';
  return 'bad';
}
function routeTitle(status) {
  if (!status) return '未检查';
  if (status.route === 'direct') return '服务器直连';
  if (status.route === 'proxy') return status.source === 'existing-config-forward' ? '复用已有代理隧道' : 'Harness 托管代理隧道';
  if (status.route === 'checking') return '正在检查';
  return '不可用';
}
function usePanelOpen() {
  const pair = React.useState(panelStore.get());
  React.useEffect(function () { return panelStore.subscribe(function () { pair[1](panelStore.get()); }); }, []);
  return pair[0];
}
function StatusPill(props) {
  return React.createElement('span', { className: 'dov-pill dov-' + (props.tone || 'muted') }, props.children);
}
function Field(props) {
  return React.createElement('div', { className: 'dov-field' },
    React.createElement('div', { className: 'dov-field-label' }, props.label),
    React.createElement('div', { className: 'dov-field-value', title: stateLabel(props.value) }, stateLabel(props.value)));
}
function HostRow(props) {
  const host = props.host || {};
  return React.createElement('button', {
    className: 'dov-host' + (props.selected ? ' dov-host-selected' : ''), onClick: props.onClick,
  },
    React.createElement('div', { className: 'dov-host-top' },
      React.createElement('span', { className: 'dov-host-name' }, host.alias || 'unknown'),
      host.error ? React.createElement(StatusPill, { tone: 'bad' }, '错误') : null),
    React.createElement('div', { className: 'dov-host-sub' }, host.error
      ? host.error
      : ((host.user ? host.user + '@' : '') + (host.hostname || '') + ':' + (host.port || 22))));
}

function SshPanel(props) {
  const variant = props.variant || 'overlay';
  const open = usePanelOpen();
  const visible = variant === 'tab' || open;
  const aliasesState = React.useState([]), aliases = aliasesState[0], setAliases = aliasesState[1];
  const aliasState = React.useState(''), alias = aliasState[0], setAlias = aliasState[1];
  const statusState = React.useState(null), status = statusState[0], setStatus = statusState[1];
  const loadingState = React.useState(false), loading = loadingState[0], setLoading = loadingState[1];
  const errorState = React.useState(''), error = errorState[0], setError = errorState[1];
  const modeState = React.useState('auto'), mode = modeState[0], setMode = modeState[1];
  const commandState = React.useState('pwd'), command = commandState[0], setCommand = commandState[1];
  const runningState = React.useState(false), running = runningState[0], setRunning = runningState[1];
  const resultState = React.useState(null), result = resultState[0], setResult = resultState[1];
  const remotePathState = React.useState('/mnt/ext-disk/czm2025/Projects/face_privacy_tkde');
  const remotePath = remotePathState[0], setRemotePath = remotePathState[1];
  const openingState = React.useState(false), openingWorkspace = openingState[0], setOpeningWorkspace = openingState[1];
  const workspaceState = React.useState([]), remoteWorkspaces = workspaceState[0], setRemoteWorkspaces = workspaceState[1];
  const workspaceNoteState = React.useState(''), workspaceNote = workspaceNoteState[0], setWorkspaceNote = workspaceNoteState[1];

  const loadAliases = React.useCallback(async function () {
    setLoading(true); setError('');
    try {
      const data = await api('/aliases');
      const list = Array.isArray(data.aliases) ? data.aliases : [];
      setAliases(list); setMode(data.mode || 'auto');
      if (!alias && list.length) {
        const preferred = list.find(function (item) { return item.alias === 'gdwyy70'; }) || list[0];
        setAlias(preferred.alias);
      } else if (alias && !list.some(function (item) { return item.alias === alias; }) && list.length) setAlias(list[0].alias);
    } catch (e) { setError(String((e && e.message) || e)); }
    finally { setLoading(false); }
  }, [alias]);

  const loadWorkspaces = React.useCallback(async function () {
    try {
      const data = await api('/workspaces');
      setRemoteWorkspaces(Array.isArray(data.workspaces) ? data.workspaces : []);
    } catch (e) { /* workspace capability is supplementary; status remains usable */ }
  }, []);

  const refreshStatus = React.useCallback(async function (force) {
    if (!alias) return;
    setLoading(true); setError('');
    try {
      const data = await api('/status?alias=' + encodeURIComponent(alias) + '&refresh=' + (force === false ? '0' : '1'));
      setStatus(data.status || null);
      if (data.status && data.status.mode) setMode(data.status.mode);
    } catch (e) { setError(String((e && e.message) || e)); }
    finally { setLoading(false); }
  }, [alias]);

  React.useEffect(function () {
    if (!visible) return;
    loadAliases(); loadWorkspaces();
  }, [visible]);
  React.useEffect(function () {
    if (!visible || !alias) return;
    refreshStatus(true);
    const timer = window.setInterval(function () { refreshStatus(false); }, 30000);
    return function () { window.clearInterval(timer); };
  }, [visible, alias]);
  React.useEffect(function () {
    if (alias === 'gdwyy70') setRemotePath('/mnt/ext-disk/czm2025/Projects/face_privacy_tkde');
  }, [alias]);

  async function changeMode(nextMode) {
    if (!alias) return;
    setLoading(true); setError(''); setMode(nextMode);
    try {
      const data = await api('/mode', { method: 'POST', body: JSON.stringify({ alias: alias, mode: nextMode }) });
      if (data.status) setStatus(data.status);
    } catch (e) { setError(String((e && e.message) || e)); }
    finally { setLoading(false); }
  }

  async function runCommand(value) {
    const cmd = String(value === undefined ? command : value).trim();
    if (!alias || !cmd || running) return;
    if (value !== undefined) setCommand(cmd);
    setRunning(true); setError(''); setResult(null);
    try {
      const data = await api('/exec', { method: 'POST', body: JSON.stringify({ alias: alias, command: cmd, timeoutMs: 120000 }) });
      setResult(data.result || null);
      if (data.result && data.result.success) refreshStatus(false);
    } catch (e) { setError(String((e && e.message) || e)); }
    finally { setRunning(false); }
  }

  async function openWorkspace() {
    const path = String(remotePath || '').trim();
    if (!alias || !path || openingWorkspace) return;
    setOpeningWorkspace(true); setWorkspaceNote(''); setError('');
    try {
      const data = await api('/workspace/open', {
        method: 'POST', body: JSON.stringify({ alias: alias, remotePath: path }),
      });
      setWorkspaceNote('已添加到 Harness 工作区：' + data.title);
      await loadWorkspaces();
      try {
        if (harnessWorkspaces && typeof harnessWorkspaces.refresh === 'function') await harnessWorkspaces.refresh();
        if (harnessSessions && typeof harnessSessions.refresh === 'function') await harnessSessions.refresh();
        if (harnessSessions && typeof harnessSessions.open === 'function' && data.sessionId) harnessSessions.open(data.sessionId);
      } catch (refreshError) {
        console.warn(TAG, 'workspace created but client refresh failed', refreshError);
      }
    } catch (e) { setError(String((e && e.message) || e)); }
    finally { setOpeningWorkspace(false); }
  }

  if (!visible) return null;
  const resolved = status && status.resolved ? status.resolved : {};
  const remoteForward = resolved && resolved.vpnRemoteForward ? resolved.vpnRemoteForward : null;
  const currentHost = aliases.find(function (item) { return item.alias === alias; });
  const currentRemote = remoteWorkspaces.filter(function (item) { return item.alias === alias; });

  const hostList = React.createElement('div', { className: 'dov-host-list' },
    React.createElement('div', { className: 'dov-section-head' },
      React.createElement('span', null, '主机'),
      React.createElement('button', { className: 'dov-icon-btn', onClick: loadAliases, title: '重新读取 ~/.ssh/config' }, '↻')),
    aliases.length ? aliases.map(function (host) {
      return React.createElement(HostRow, { key: host.alias, host: host, selected: host.alias === alias,
        onClick: function () { setAlias(host.alias); setResult(null); setWorkspaceNote(''); } });
    }) : React.createElement('div', { className: 'dov-empty' }, loading ? '正在读取 SSH 配置…' : '没有找到 SSH Host 别名'));

  const statusCard = React.createElement('div', { className: 'dov-card' },
    React.createElement('div', { className: 'dov-card-head' },
      React.createElement('div', null,
        React.createElement('div', { className: 'dov-card-title' }, alias || 'SSH'),
        React.createElement('div', { className: 'dov-card-sub' }, currentHost && !currentHost.error
          ? ((currentHost.user ? currentHost.user + '@' : '') + currentHost.hostname + ':' + currentHost.port)
          : '使用系统 OpenSSH 与 ~/.ssh/config')),
      React.createElement('div', { className: 'dov-actions' },
        React.createElement(StatusPill, { tone: statusTone(status && status.route) }, routeTitle(status)),
        React.createElement('button', { className: 'dov-btn', disabled: loading || !alias, onClick: function () { refreshStatus(true); } }, loading ? '检查中…' : '刷新'))),
    error ? React.createElement('div', { className: 'dov-error' }, '⚠ ' + error) : null,
    React.createElement('div', { className: 'dov-mode-row' },
      React.createElement('span', { className: 'dov-mode-label' }, '网络模式'),
      ['auto','direct','proxy'].map(function (item) {
        return React.createElement('button', { key:item, className:'dov-mode-btn'+(mode===item?' dov-mode-active':''), disabled:loading,
          onClick:function(){ changeMode(item); } }, item.toUpperCase());
      })),
    React.createElement('div', { className: 'dov-grid' },
      React.createElement(Field, { label:'route', value:status && status.route }),
      React.createElement(Field, { label:'source', value:status && status.source }),
      React.createElement(Field, { label:'SSH', value:status ? (status.sshOk===true?'正常':status.sshOk===false?'失败':'—') : '—' }),
      React.createElement(Field, { label:'本地代理', value:status ? (status.localProxy + (status.localProxyOk===true?' · 正常':status.localProxyOk===false?' · 失败':'')) : '—' }),
      React.createElement(Field, { label:'远端代理端口', value:status && status.remotePort }),
      React.createElement(Field, { label:'配置 RemoteForward', value:remoteForward ? (remoteForward.listenHost+':'+remoteForward.listenPort+' → '+remoteForward.targetHost+':'+remoteForward.targetPort) : '—' }),
      React.createElement(Field, { label:'托管隧道', value:status && status.managedTunnelAlive===true ? ('PID '+stateLabel(status.managedTunnelPid)) : '—' }),
      React.createElement(Field, { label:'IdentityFile', value:resolved && Array.isArray(resolved.identityFiles) ? resolved.identityFiles.join(', ') : '—' })),
    status && status.error ? React.createElement('div', { className:'dov-error dov-status-error' }, status.error) : null);

  const workspaceCard = React.createElement('div', { className:'dov-card dov-workspace-card' },
    React.createElement('div', { className:'dov-card-head' },
      React.createElement('div', null,
        React.createElement('div', { className:'dov-card-title' }, '远程工作区'),
        React.createElement('div', { className:'dov-card-sub' }, '把 SSH 远端目录作为 Harness 官方 Workspace 打开；文件与命令仍在远端执行')),
      React.createElement(StatusPill, { tone:'ok' }, 'Remote Workspace')),
    React.createElement('div', { className:'dov-workspace-row' },
      React.createElement('input', { className:'dov-path', value:remotePath, spellCheck:false,
        placeholder:'/mnt/.../project', onChange:function(e){ setRemotePath(String((e.target&&e.target.value)||'')); } }),
      React.createElement('button', { className:'dov-run dov-workspace-open', disabled:openingWorkspace || !alias || !String(remotePath).trim(), onClick:openWorkspace },
        openingWorkspace ? '正在打开…' : '＋ 添加到 Harness 工作区')),
    workspaceNote ? React.createElement('div', { className:'dov-success' }, '✓ ' + workspaceNote + '；左侧工作区已刷新并打开对应远程会话。') : null,
    currentRemote.length ? React.createElement('div', { className:'dov-workspace-list' },
      currentRemote.map(function(item){ return React.createElement('button', { key:item.anchor, className:'dov-workspace-item', onClick:function(){ setRemotePath(item.remotePath); } },
        React.createElement('span', { className:'dov-workspace-name' }, item.title),
        React.createElement('span', { className:'dov-workspace-path' }, item.remotePath),
        item.workspaceId ? React.createElement(StatusPill, { tone:'ok' }, '已登记') : React.createElement(StatusPill, { tone:'warn' }, '待登记'));
      })) : null);

  const quick = [['PWD','pwd'],['目录','ls -la'],['Git 状态','git status --short --branch'],['系统','uname -a']];
  const terminal = React.createElement('div', { className:'dov-card dov-terminal-card' },
    React.createElement('div', { className:'dov-card-head' },
      React.createElement('div', null, React.createElement('div',{className:'dov-card-title'},'命令终端'), React.createElement('div',{className:'dov-card-sub'},'通过系统 ssh.exe 执行；Ctrl+Enter 运行')),
      React.createElement('div',{className:'dov-quick'},quick.map(function(item){ return React.createElement('button',{key:item[0],className:'dov-mini',disabled:running||!alias,onClick:function(){runCommand(item[1]);}},item[0]); }))),
    React.createElement('textarea',{className:'dov-command',value:command,spellCheck:false,placeholder:'例如：cd /mnt/.../project && git status',onChange:function(e){setCommand(String((e.target&&e.target.value)||''));},onKeyDown:function(e){if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();runCommand();}}}),
    React.createElement('div',{className:'dov-run-row'},React.createElement('button',{className:'dov-run',disabled:running||!alias||!command.trim(),onClick:function(){runCommand();}},running?'执行中…':'▶ 运行'),result?React.createElement('span',{className:'dov-result-meta'},'exit '+stateLabel(result.exitCode)+' · '+stateLabel(result.durationMs)+' ms'):null),
    result ? React.createElement('div',{className:'dov-output-wrap'},
      result.stdout?React.createElement('div',null,React.createElement('div',{className:'dov-output-label'},'STDOUT'),React.createElement('pre',{className:'dov-output'},result.stdout)):null,
      result.stderr?React.createElement('div',null,React.createElement('div',{className:'dov-output-label dov-stderr-label'},'STDERR'),React.createElement('pre',{className:'dov-output dov-stderr'},result.stderr)):null,
      !result.stdout&&!result.stderr?React.createElement('div',{className:'dov-empty'},'命令没有输出'):null) : null);

  return React.createElement('div',{className:'dov-root'+(variant==='overlay'?' dov-overlay':' dov-tab')},
    React.createElement('div',{className:'dov-header'},React.createElement('div',{className:'dov-title-wrap'},React.createElement('span',{className:'dov-terminal-icon'},'>_'),React.createElement('div',null,React.createElement('div',{className:'dov-title'},'SSH'),React.createElement('div',{className:'dov-subtitle'},'Native OpenSSH · Windows VPN · Remote Workspace'))),variant==='overlay'?React.createElement('button',{className:'dov-close',onClick:panelStore.close,title:'关闭'},'✕'):null),
    React.createElement('div',{className:'dov-layout'},React.createElement('aside',{className:'dov-sidebar'},hostList),React.createElement('main',{className:'dov-main'},statusCard,workspaceCard,terminal)));
}

const CSS = `
.dov-root{display:flex;flex-direction:column;min-height:0;color:inherit;font-size:13px;line-height:1.45;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}.dov-overlay{position:fixed;top:22px;right:22px;bottom:22px;width:min(1080px,calc(100vw - 44px));z-index:1100;background:#fff;border:1px solid rgba(100,110,130,.24);border-radius:16px;box-shadow:0 18px 60px rgba(15,23,42,.24);overflow:hidden;color:#172033}.dov-tab{height:100%;min-height:620px;background:transparent}@media(prefers-color-scheme:dark){.dov-overlay{background:#14171d;color:#e6e9ef;border-color:rgba(180,190,210,.18)}.dov-card,.dov-sidebar{background:rgba(255,255,255,.025)!important}.dov-command,.dov-output,.dov-path{background:#0f1116!important}}
.dov-header{height:66px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid rgba(120,130,150,.2);flex:0 0 auto}.dov-title-wrap{display:flex;align-items:center;gap:11px}.dov-terminal-icon{display:inline-flex;width:34px;height:34px;border-radius:9px;align-items:center;justify-content:center;background:rgba(48,108,224,.12);color:#2f6fe4;font-family:ui-monospace,Consolas,monospace;font-weight:800}.dov-title{font-size:16px;font-weight:720}.dov-subtitle{font-size:11px;opacity:.62;margin-top:1px}.dov-close{border:0;background:transparent;color:inherit;opacity:.65;cursor:pointer;font-size:16px;padding:7px 10px;border-radius:8px}.dov-close:hover{opacity:1;background:rgba(127,127,127,.12)}
.dov-layout{display:grid;grid-template-columns:224px minmax(0,1fr);flex:1 1 auto;min-height:0}.dov-sidebar{border-right:1px solid rgba(120,130,150,.18);padding:12px;background:rgba(120,130,150,.035);overflow-y:auto}.dov-main{padding:14px;display:flex;flex-direction:column;gap:12px;overflow-y:auto;min-width:0}.dov-section-head{display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;opacity:.68;padding:3px 5px 9px}.dov-icon-btn{border:0;background:transparent;color:inherit;cursor:pointer;font-size:17px;opacity:.65}.dov-host-list{display:flex;flex-direction:column;gap:5px}.dov-host{width:100%;text-align:left;border:1px solid transparent;background:transparent;color:inherit;border-radius:9px;padding:9px 10px;cursor:pointer}.dov-host:hover{background:rgba(48,108,224,.07)}.dov-host-selected{background:rgba(48,108,224,.11)!important;border-color:rgba(48,108,224,.25)}.dov-host-top{display:flex;justify-content:space-between;gap:6px;align-items:center}.dov-host-name{font-weight:700;overflow:hidden;text-overflow:ellipsis}.dov-host-sub{font-size:10.5px;opacity:.58;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
.dov-card{border:1px solid rgba(120,130,150,.2);border-radius:12px;padding:14px;background:rgba(120,130,150,.025)}.dov-card-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.dov-card-title{font-size:14px;font-weight:720}.dov-card-sub{font-size:11px;opacity:.58;margin-top:2px}.dov-actions,.dov-quick{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.dov-btn,.dov-mini,.dov-mode-btn{border:1px solid rgba(120,130,150,.32);background:transparent;color:inherit;border-radius:8px;cursor:pointer}.dov-btn{padding:6px 11px;font-size:12px}.dov-mini{padding:4px 8px;font-size:10.5px}.dov-btn:hover,.dov-mini:hover,.dov-mode-btn:hover{background:rgba(48,108,224,.08);border-color:rgba(48,108,224,.42)}button:disabled{opacity:.5;cursor:default}.dov-pill{display:inline-flex;align-items:center;padding:4px 9px;border-radius:999px;font-size:10.5px;font-weight:700}.dov-ok{background:rgba(32,156,90,.13);color:#209c5a}.dov-warn{background:rgba(214,148,27,.14);color:#c08319}.dov-bad{background:rgba(214,67,67,.13);color:#cc4141}.dov-muted{background:rgba(127,127,127,.12);opacity:.8}
.dov-mode-row{display:flex;gap:7px;align-items:center;margin-top:13px;padding-top:11px;border-top:1px solid rgba(120,130,150,.14)}.dov-mode-label{font-size:11px;opacity:.62;margin-right:3px}.dov-mode-btn{padding:4px 9px;font-size:10.5px}.dov-mode-active{background:rgba(48,108,224,.13);border-color:rgba(48,108,224,.48);color:#2f6fe4;font-weight:750}.dov-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-top:12px}.dov-field{padding:9px 10px;border-radius:9px;background:rgba(120,130,150,.07);min-width:0}.dov-field-label{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;opacity:.5}.dov-field-value{font-size:11.5px;font-weight:600;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dov-error{margin-top:10px;padding:8px 10px;border-radius:8px;background:rgba(214,67,67,.1);color:#c93d3d;font-size:11px;word-break:break-word}.dov-status-error{font-family:ui-monospace,Consolas,monospace}.dov-success{margin-top:9px;padding:8px 10px;border-radius:8px;background:rgba(32,156,90,.1);color:#208b52;font-size:11px}
.dov-workspace-row{display:flex;gap:8px;margin-top:12px}.dov-path{flex:1 1 auto;min-width:0;border:1px solid rgba(120,130,150,.28);border-radius:9px;background:rgba(20,25,35,.035);color:inherit;padding:8px 10px;font:11.5px ui-monospace,Consolas,monospace;outline:none}.dov-path:focus{border-color:rgba(48,108,224,.55);box-shadow:0 0 0 2px rgba(48,108,224,.08)}.dov-workspace-open{white-space:nowrap}.dov-workspace-list{display:flex;flex-direction:column;gap:6px;margin-top:10px}.dov-workspace-item{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;text-align:left;border:1px solid rgba(120,130,150,.18);border-radius:8px;background:transparent;color:inherit;padding:7px 9px;cursor:pointer}.dov-workspace-item:hover{background:rgba(48,108,224,.06)}.dov-workspace-name{font-size:11px;font-weight:700}.dov-workspace-path{font:10.5px ui-monospace,Consolas,monospace;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dov-command{width:100%;box-sizing:border-box;min-height:88px;resize:vertical;margin-top:12px;padding:11px 12px;border:1px solid rgba(120,130,150,.28);border-radius:9px;background:rgba(20,25,35,.035);color:inherit;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;outline:none}.dov-command:focus{border-color:rgba(48,108,224,.55);box-shadow:0 0 0 2px rgba(48,108,224,.08)}.dov-run-row{display:flex;align-items:center;gap:12px;margin-top:9px}.dov-run{border:0;border-radius:8px;background:#2f6fe4;color:white;padding:7px 16px;font-size:12px;font-weight:700;cursor:pointer}.dov-run:hover{background:#285fc5}.dov-result-meta{font-size:10.5px;opacity:.6}.dov-output-wrap{display:flex;flex-direction:column;gap:8px;margin-top:12px}.dov-output-label{font-size:9.5px;font-weight:800;letter-spacing:.07em;opacity:.52}.dov-output{margin:4px 0 0;max-height:280px;overflow:auto;padding:11px 12px;border-radius:9px;background:#11151c;color:#dce4ef;font:11.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word}.dov-stderr-label{color:#c93d3d;opacity:.8}.dov-stderr{color:#ffb8b8}.dov-empty{padding:12px;font-size:11px;opacity:.55;text-align:center}.dov-sidebar-entry .dov-sidebar-label{margin-left:8px}.dov-sidebar-entry .dov-sidebar-icon{font-family:ui-monospace,Consolas,monospace;font-size:12px;font-weight:800}.dov-sidebar-entry-taken{position:relative}.dov-sidebar-entry-taken::after{content:'';position:absolute;right:8px;width:5px;height:5px;border-radius:50%;background:#2f6fe4}@media(max-width:820px){.dov-overlay{top:10px;right:10px;bottom:10px;width:calc(100vw - 20px)}.dov-layout{grid-template-columns:170px minmax(0,1fr)}.dov-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dov-workspace-row{flex-direction:column}}
`;

let sidebarObserver = null, sidebarTimer = 0;
const takeoverBindings = new Map();
function injectStyles(){if(typeof document==='undefined'||document.querySelector('style[data-plugin-css="dsh-openssh-vpn"]'))return;const style=document.createElement('style');style.dataset.pluginCss='dsh-openssh-vpn';style.textContent=CSS;document.head.appendChild(style);}
function normalizedText(node){return String(node&&node.textContent||'').replace(/\s+/g,' ').trim();}
function findExistingSshEntry(){if(typeof document==='undefined')return null;const nodes=document.querySelectorAll('button,a,[role="button"]');for(let i=0;i<nodes.length;i++){const node=nodes[i];if(node.classList&&node.classList.contains('dov-sidebar-entry'))continue;if(normalizedText(node)!=='SSH')continue;const rect=node.getBoundingClientRect();if(rect.width>0&&rect.height>0&&rect.left<Math.min(380,window.innerWidth*.35))return node;}return null;}
function findNewSessionButton(){if(typeof document==='undefined')return null;const nodes=document.querySelectorAll('button[class*="newSession"]');for(let i=0;i<nodes.length;i++){if(String(nodes[i].className).indexOf('newSessionLabel')===-1)return nodes[i];}return null;}
function takeoverEntry(node){if(!node||takeoverBindings.has(node))return;const handler=function(event){event.preventDefault();event.stopPropagation();if(typeof event.stopImmediatePropagation==='function')event.stopImmediatePropagation();panelStore.open();};node.addEventListener('click',handler,true);if(node.classList)node.classList.add('dov-sidebar-entry-taken');takeoverBindings.set(node,handler);}
function createSidebarEntry(){const target=findNewSessionButton();if(!target||!target.parentElement)return null;const prior=target.parentElement.querySelector('.dov-sidebar-entry');if(prior)return prior;const button=target.cloneNode(true);button.className=String(target.className)+' dov-sidebar-entry';button.setAttribute('aria-label','SSH');button.innerHTML='';const icon=document.createElement('span');icon.className='dov-sidebar-icon';icon.textContent='>_';button.appendChild(icon);const label=document.createElement('span');label.className='dov-sidebar-label';label.textContent='SSH';button.appendChild(label);button.addEventListener('click',function(event){event.preventDefault();event.stopPropagation();panelStore.open();});const workshop=target.parentElement.querySelector('.dsws-sidebar-entry');if(workshop)workshop.insertAdjacentElement('afterend',button);else target.insertAdjacentElement('afterend',button);return button;}
function installSidebar(){if(typeof document==='undefined')return;const existing=findExistingSshEntry();if(existing)takeoverEntry(existing);else createSidebarEntry();}
function watchSidebar(){if(typeof MutationObserver==='undefined'||sidebarObserver)return;sidebarObserver=new MutationObserver(function(){window.clearTimeout(sidebarTimer);sidebarTimer=window.setTimeout(installSidebar,120);});sidebarObserver.observe(document.body,{childList:true,subtree:true});}
function cleanupSidebar(){if(sidebarObserver){sidebarObserver.disconnect();sidebarObserver=null;}window.clearTimeout(sidebarTimer);takeoverBindings.forEach(function(handler,node){try{node.removeEventListener('click',handler,true);}catch(e){}try{node.classList.remove('dov-sidebar-entry-taken');}catch(e){}});takeoverBindings.clear();const own=document.querySelector('.dov-sidebar-entry');if(own)own.remove();}

function apply(ctx) {
  console.log(TAG, 'client apply');
  if (!React) { console.error(TAG, 'React unavailable; SSH Web UI disabled'); return; }
  harnessSessions = ctx.get('sessions') || null;
  harnessWorkspaces = ctx.get('workspaces') || null;
  const slots = ctx.get('slots');
  if (slots) {
    slots.inject('shell.overlay', function () { return slots.register({ name:'shell.overlay',id:'dsh-openssh-vpn-overlay',order:45,label:'SSH' }, function(){return React.createElement(SshPanel,{variant:'overlay'});}); });
    slots.inject('settings.plugins.tab', function () { return slots.register({ name:'settings.plugins.tab',id:'dsh-openssh-vpn-tab',order:25,label:'SSH' }, function(){return React.createElement(SshPanel,{variant:'tab'});}); });
  }
  if (typeof document !== 'undefined') {
    injectStyles(); installSidebar(); watchSidebar();
    ctx.effect(function(){return function(){cleanupSidebar();harnessSessions=null;harnessWorkspaces=null;const style=document.querySelector('style[data-plugin-css="dsh-openssh-vpn"]');if(style)style.remove();};},'dsh-openssh-vpn: cleanup Web UI');
  }
}
module.exports = { apply };
return module.exports;
} });
