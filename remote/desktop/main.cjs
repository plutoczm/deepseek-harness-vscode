const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_ID = 'io.github.plutoczm.deepseek-harness-remote';
const APP_NAME = 'DeepSeek Harness Remote';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const TERMINAL_INSTANCE_STATUSES = new Set(['stopped', 'error']);

let mainWindow;
let remoteModule;
let quitting = false;
let launcherUrl;
let launcherPort;
let instanceLifecycleUnsubscribe;
const usageSubscriptions = new Map();

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
app.enableSandbox();

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
}

function secureWebPreferences() {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
  };
}

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function isSafeExternalUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function usageWidgetScript() {
  return `(() => {
    if (!document.getElementById('dhr-usage-style')) {
      const style = document.createElement('style');
      style.id = 'dhr-usage-style';
      style.textContent = \`
        #dhr-usage-widget{position:fixed;top:12px;right:16px;z-index:2147483646;min-width:250px;max-width:330px;padding:10px 12px;border:1px solid rgba(255,255,255,.10);border-radius:11px;background:rgba(22,23,25,.95);backdrop-filter:blur(16px);box-shadow:0 10px 30px rgba(0,0,0,.25);font:12px/1.4 Inter,Segoe UI,system-ui,sans-serif;color:#e8eaed;pointer-events:auto;user-select:none}
        #dhr-usage-widget .dhr-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
        #dhr-usage-widget .dhr-title{font-weight:650;color:#f5f6f7}
        #dhr-usage-widget .dhr-live{display:inline-flex;align-items:center;gap:5px;color:#8b9098;font-size:10px}
        #dhr-usage-widget .dhr-live:before{content:'';width:6px;height:6px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.12)}
        #dhr-usage-widget[data-waiting='1'] .dhr-live:before{background:#64748b;box-shadow:none}
        #dhr-usage-widget .dhr-cost{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,.07)}
        #dhr-usage-widget .dhr-cost-label{color:#858a92;font-size:10.5px}
        #dhr-usage-widget .dhr-cost-value{color:#8fb4ff;font:700 15px/1.3 SFMono-Regular,Consolas,monospace}
        #dhr-usage-widget .dhr-metrics{display:flex;flex-wrap:wrap;gap:4px 9px;margin-top:6px;color:#9ba0a8;font:10.5px/1.45 SFMono-Regular,Consolas,monospace}
        #dhr-usage-widget .dhr-metrics b{color:#d7dade;font-weight:600}
        #dhr-usage-widget .dhr-last{margin-top:5px;color:#737982;font-size:9.5px}
        #dhr-usage-widget .dhr-model{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      \`;
      document.head.appendChild(style);
    }
    let box = document.getElementById('dhr-usage-widget');
    if (!box) {
      box = document.createElement('div');
      box.id = 'dhr-usage-widget';
      box.dataset.waiting = '1';
      box.innerHTML = '<div class="dhr-head"><span class="dhr-title">DeepSeek API</span><span class="dhr-live">等待 usage</span></div><div class="dhr-cost"><span class="dhr-cost-label">当前会话消耗</span><span class="dhr-cost-value">¥0.000000</span></div><div class="dhr-metrics"><span>Input <b>—</b></span><span>Output <b>—</b></span><span>Cache <b>—</b></span></div><div class="dhr-last">跟随 Harness usage 事件即时更新 · 不轮询余额接口</div>';
      document.body.appendChild(box);
    }
    const compact = (value) => {
      const n = Number(value || 0);
      if (n < 1000) return String(Math.round(n));
      if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\\.0$/,'') + 'K';
      return (n / 1000000).toFixed(n < 10000000 ? 2 : 1).replace(/\\.0$/,'') + 'M';
    };
    const money = (value) => {
      const n = Number(value || 0);
      if (n === 0) return '¥0.000000';
      if (n < 0.000001) return '< ¥0.000001';
      return '¥' + n.toFixed(n < 0.01 ? 6 : 4);
    };
    window.__DHR_UPDATE_USAGE__ = (payload) => {
      const widget = document.getElementById('dhr-usage-widget');
      if (!widget) return;
      const live = widget.querySelector('.dhr-live');
      const cost = widget.querySelector('.dhr-cost-value');
      const metrics = widget.querySelectorAll('.dhr-metrics b');
      const note = widget.querySelector('.dhr-last');
      const session = payload?.session;
      if (!payload?.available || !session) {
        widget.dataset.waiting = '1';
        live.textContent = payload?.active === false ? '已断开' : '等待 usage';
        cost.textContent = '¥0.000000';
        metrics[0].textContent = '—';
        metrics[1].textContent = '—';
        metrics[2].textContent = '—';
        note.textContent = payload?.active === false ? 'SSH 已结束 · Harness 会话同步停止' : '模型返回 usage 后立即更新 · 不调用 /user/balance';
        return;
      }
      widget.dataset.waiting = payload?.active === false ? '1' : '0';
      live.textContent = payload?.active === false ? '已断开' : '实时事件';
      cost.textContent = session.pricingKnown ? money(session.costCny) : money(session.costCny) + ' + 未定价';
      metrics[0].textContent = compact(session.inputTokens);
      metrics[1].textContent = compact(session.outputTokens);
      metrics[2].textContent = session.cacheHitPercent == null ? '—' : Math.round(session.cacheHitPercent) + '%';
      const last = session.last || {};
      const lastCost = last.pricingKnown ? money(last.costCny) : '未定价';
      const model = session.model || 'unknown model';
      note.textContent = payload?.active === false
        ? 'SSH 已结束 · Harness 会话同步停止'
        : model + ' · 本次 ' + lastCost + ' · ' + (session.requests || 0) + ' 次 usage';
    };
  })();`;
}

function findInstanceForContents(contents) {
  if (!remoteModule?.manager || contents.isDestroyed()) return undefined;
  let port;
  try {
    port = Number(new URL(contents.getURL()).port);
  } catch {
    return undefined;
  }
  if (!port || port === launcherPort) return undefined;
  return remoteModule.manager.list().find((instance) => Number(instance.localPort) === port);
}

async function pushUsageSnapshot(contents, snapshot) {
  if (contents.isDestroyed()) return;
  await contents.executeJavaScript(
    `window.__DHR_UPDATE_USAGE__?.(${JSON.stringify(snapshot || { available: false, mode: 'event-driven' })})`,
    true,
  ).catch(() => undefined);
}

async function attachUsageOverlay(contents) {
  if (contents.isDestroyed()) return;
  let url;
  try { url = new URL(contents.getURL()); } catch { return; }
  if (!LOOPBACK_HOSTS.has(url.hostname) || Number(url.port) === launcherPort) return;

  await contents.executeJavaScript(usageWidgetScript(), true).catch(() => undefined);
  const instance = findInstanceForContents(contents);
  if (!instance) return;

  await pushUsageSnapshot(contents, remoteModule.manager.usage(instance.id));

  const existing = usageSubscriptions.get(contents.id);
  if (existing?.instanceId === instance.id) return;
  existing?.unsubscribe?.();

  const unsubscribe = remoteModule.manager.onUsage(instance.id, (snapshot) => {
    pushUsageSnapshot(contents, snapshot).catch(() => undefined);
  });
  usageSubscriptions.set(contents.id, { instanceId: instance.id, unsubscribe });

  contents.once('destroyed', () => {
    const current = usageSubscriptions.get(contents.id);
    current?.unsubscribe?.();
    usageSubscriptions.delete(contents.id);
  });
}

function closeHarnessWindowsForInstance(instance) {
  if (!instance?.id || !TERMINAL_INSTANCE_STATUSES.has(instance.status)) return;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window === mainWindow || window.isDestroyed()) continue;
    const matched = findInstanceForContents(window.webContents);
    if (matched?.id !== instance.id) continue;
    pushUsageSnapshot(window.webContents, remoteModule.manager.usage(instance.id)).catch(() => undefined);
    setTimeout(() => {
      if (!window.isDestroyed()) window.close();
    }, 120);
  }
}

function bindInstanceLifecycle() {
  instanceLifecycleUnsubscribe?.();
  instanceLifecycleUnsubscribe = remoteModule?.manager?.onInstanceStatus?.(null, (instance) => {
    closeHarnessWindowsForInstance(instance);
  });
}

function configureWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isLoopbackUrl(url)) {
      return {
        action: 'allow',
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          width: 1500,
          height: 960,
          minWidth: 980,
          minHeight: 680,
          backgroundColor: '#151517',
          title: 'DeepSeek Harness',
          autoHideMenuBar: true,
          webPreferences: secureWebPreferences(),
        },
      };
    }

    if (isSafeExternalUrl(url)) {
      setImmediate(() => shell.openExternal(url).catch(() => undefined));
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isLoopbackUrl(url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url).catch(() => undefined);
  });

  contents.on('did-finish-load', () => attachUsageOverlay(contents).catch(() => undefined));
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolve();
        else retry();
      });
      request.once('timeout', () => request.destroy());
      request.once('error', retry);
    };

    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Local launcher did not become ready on port ${port}.`));
      } else {
        setTimeout(attempt, 150);
      }
    };

    attempt();
  });
}

async function startEmbeddedLauncher() {
  const port = await findFreePort();
  process.env.DSH_REMOTE_PORT = String(port);
  if (!process.argv.includes('--no-open')) process.argv.push('--no-open');

  const entry = pathToFileURL(path.resolve(__dirname, '../src/server.mjs')).href;
  remoteModule = await import(entry);
  bindInstanceLifecycle();
  await waitForHealth(port);
  launcherPort = port;
  launcherUrl = `http://127.0.0.1:${port}`;
  return launcherUrl;
}

function createMainWindow(url) {
  const window = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1040,
    minHeight: 720,
    show: false,
    backgroundColor: '#151517',
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences(),
  });

  mainWindow = window;
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  window.loadURL(url);
}

async function stopEmbeddedLauncher() {
  instanceLifecycleUnsubscribe?.();
  instanceLifecycleUnsubscribe = undefined;
  for (const subscription of usageSubscriptions.values()) subscription.unsubscribe?.();
  usageSubscriptions.clear();
  await remoteModule?.manager?.stopAll?.().catch(() => undefined);
  const server = remoteModule?.server;
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

app.on('web-contents-created', (_event, contents) => configureWebContents(contents));

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    const url = await startEmbeddedLauncher();
    createMainWindow(url);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    dialog.showErrorBox('DeepSeek Harness Remote 启动失败', message);
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  stopEmbeddedLauncher()
    .catch(() => undefined)
    .finally(() => app.quit());
});
