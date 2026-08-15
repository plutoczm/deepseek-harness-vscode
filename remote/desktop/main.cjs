const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createAppearanceBridge } = require('./appearance.cjs');

const APP_ID = 'io.github.plutoczm.deepseek-harness-remote';
const APP_NAME = 'DeepSeek Harness Desktop';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const TERMINAL_INSTANCE_STATUSES = new Set(['stopped', 'error']);

let mainWindow;
let remoteModule;
let appearanceBridge;
let quitting = false;
let launcherUrl;
let launcherPort;
let instanceLifecycleUnsubscribe;
const usageSubscriptions = new Map();
const balanceSubscriptions = new Map();

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

function isHarnessContents(contents) {
  if (!contents || contents.isDestroyed()) return false;
  try {
    const url = new URL(contents.getURL());
    return LOOPBACK_HOSTS.has(url.hostname) && Number(url.port) !== launcherPort;
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
        #dhr-usage-widget{position:fixed;top:12px;right:16px;z-index:2147483646;min-width:250px;max-width:310px;padding:10px 12px;border:1px solid rgba(255,255,255,.10);border-radius:11px;background:rgba(22,23,25,.95);backdrop-filter:blur(16px);box-shadow:0 10px 30px rgba(0,0,0,.25);font:12px/1.4 Inter,Segoe UI,system-ui,sans-serif;color:#e8eaed;pointer-events:auto;user-select:none}
        #dhr-usage-widget .dhr-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
        #dhr-usage-widget .dhr-title{font-weight:650;color:#f5f6f7}
        #dhr-usage-widget .dhr-live{display:inline-flex;align-items:center;gap:5px;color:#9ca3af;font-size:10px}
        #dhr-usage-widget .dhr-live:before{content:'';width:6px;height:6px;border-radius:50%;background:#64748b}
        #dhr-usage-widget[data-state='ok'] .dhr-live:before{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.12)}
        #dhr-usage-widget[data-state='empty'] .dhr-live:before{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.10)}
        #dhr-usage-widget[data-state='error'] .dhr-live:before{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.10)}
        #dhr-usage-widget[data-state='offline'] .dhr-live:before{background:#64748b;box-shadow:none}
        #dhr-usage-widget .dhr-values{margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,.07)}
        #dhr-usage-widget .dhr-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px;min-height:24px}
        #dhr-usage-widget .dhr-label{color:#858a92;font-size:10.5px}
        #dhr-usage-widget .dhr-balance-value{color:#a7c3ff;font:700 15px/1.3 SFMono-Regular,Consolas,monospace}
        #dhr-usage-widget .dhr-cost-value{color:#d7dade;font:650 13px/1.3 SFMono-Regular,Consolas,monospace}
        #dhr-usage-widget .dhr-last{margin-top:5px;color:#737982;font-size:9.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      \`;
      document.head.appendChild(style);
    }
    let box = document.getElementById('dhr-usage-widget');
    if (!box) {
      box = document.createElement('div');
      box.id = 'dhr-usage-widget';
      box.dataset.state = 'waiting';
      box.innerHTML = '<div class="dhr-head"><span class="dhr-title">DeepSeek API</span><span class="dhr-live">获取余额</span></div><div class="dhr-values"><div class="dhr-row"><span class="dhr-label">API 余额</span><span class="dhr-balance-value">—</span></div><div class="dhr-row"><span class="dhr-label">当前会话消耗</span><span class="dhr-cost-value">¥0.000000</span></div></div><div class="dhr-last">余额查询不会调用模型，不消耗 Token</div>';
      document.body.appendChild(box);
    }

    const state = window.__DHR_API_STATE__ || { usage: null, balance: null };
    window.__DHR_API_STATE__ = state;

    const sessionMoney = (value) => {
      const n = Number(value || 0);
      if (n === 0) return '¥0.000000';
      if (n < 0.000001) return '< ¥0.000001';
      return '¥' + n.toFixed(n < 0.01 ? 6 : 4);
    };
    const balanceMoney = (value, currency) => {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
      const n = Number(value);
      const code = String(currency || 'CNY').toUpperCase();
      if (code === 'CNY') return '¥' + n.toFixed(n < 1 ? 4 : 2);
      return code + ' ' + n.toFixed(n < 1 ? 4 : 2);
    };
    const ageText = (value) => {
      if (!value) return null;
      const timestamp = new Date(value).getTime();
      if (!Number.isFinite(timestamp)) return null;
      const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
      if (seconds < 3) return '刚刚更新';
      if (seconds < 60) return seconds + ' 秒前更新';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + ' 分钟前更新';
      return '较早前更新';
    };
    const render = () => {
      const widget = document.getElementById('dhr-usage-widget');
      if (!widget) return;
      const live = widget.querySelector('.dhr-live');
      const balanceValue = widget.querySelector('.dhr-balance-value');
      const costValue = widget.querySelector('.dhr-cost-value');
      const note = widget.querySelector('.dhr-last');
      const usage = state.usage;
      const balance = state.balance;
      const active = balance?.active !== false && usage?.active !== false;

      if (!active) {
        widget.dataset.state = 'offline';
        live.textContent = '已断开';
      } else if (!balance?.received) {
        widget.dataset.state = 'waiting';
        live.textContent = '获取余额';
      } else if (!balance?.ok) {
        widget.dataset.state = 'error';
        live.textContent = '无法获取';
      } else if (balance?.available === false) {
        widget.dataset.state = 'empty';
        live.textContent = '余额不足';
      } else {
        widget.dataset.state = 'ok';
        live.textContent = '可用';
      }

      balanceValue.textContent = balanceMoney(balance?.total, balance?.currency);
      const session = usage?.session;
      costValue.textContent = session
        ? (session.pricingKnown ? sessionMoney(session.costCny) : sessionMoney(session.costCny) + ' + 未定价')
        : '¥0.000000';

      const age = ageText(balance?.fetchedAt);
      if (!active) {
        note.textContent = age ? '余额 ' + age + ' · Harness 已断开' : 'Harness 已断开';
      } else if (balance?.error) {
        note.textContent = balance.error;
      } else if (age) {
        note.textContent = '余额 ' + age + ' · 查询不消耗 Token';
      } else {
        note.textContent = '余额查询不会调用模型，不消耗 Token';
      }
      widget.title = balance?.error || '';
    };

    window.__DHR_UPDATE_USAGE__ = (payload) => {
      state.usage = payload || null;
      render();
    };
    window.__DHR_UPDATE_BALANCE__ = (payload) => {
      state.balance = payload || null;
      render();
    };

    if (!window.__DHR_API_CLOCK__) {
      window.__DHR_API_CLOCK__ = setInterval(render, 1000);
    }
    render();
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

async function pushBalanceSnapshot(contents, snapshot) {
  if (contents.isDestroyed()) return;
  await contents.executeJavaScript(
    `window.__DHR_UPDATE_BALANCE__?.(${JSON.stringify(snapshot || { received: false, active: true })})`,
    true,
  ).catch(() => undefined);
}

async function attachUsageOverlay(contents) {
  if (contents.isDestroyed()) return;
  let url;
  try { url = new URL(contents.getURL()); } catch { return; }
  if (!LOOPBACK_HOSTS.has(url.hostname) || Number(url.port) === launcherPort) return;

  await contents.executeJavaScript(usageWidgetScript(), true).catch(() => undefined);
  appearanceBridge?.apply(contents).catch(() => undefined);
  const instance = findInstanceForContents(contents);
  if (!instance) return;

  await Promise.all([
    pushUsageSnapshot(contents, remoteModule.manager.usage(instance.id)),
    pushBalanceSnapshot(contents, remoteModule.manager.balance(instance.id)),
  ]);

  const existingUsage = usageSubscriptions.get(contents.id);
  if (existingUsage?.instanceId !== instance.id) {
    existingUsage?.unsubscribe?.();
    const unsubscribe = remoteModule.manager.onUsage(instance.id, (snapshot) => {
      pushUsageSnapshot(contents, snapshot).catch(() => undefined);
    });
    usageSubscriptions.set(contents.id, { instanceId: instance.id, unsubscribe });
  }

  const existingBalance = balanceSubscriptions.get(contents.id);
  if (existingBalance?.instanceId !== instance.id) {
    existingBalance?.unsubscribe?.();
    const unsubscribe = remoteModule.manager.onBalance(instance.id, (snapshot) => {
      pushBalanceSnapshot(contents, snapshot).catch(() => undefined);
    });
    balanceSubscriptions.set(contents.id, { instanceId: instance.id, unsubscribe });
  }

  if (!contents.__dhrTelemetryCleanupBound) {
    contents.__dhrTelemetryCleanupBound = true;
    contents.once('destroyed', () => {
      const usage = usageSubscriptions.get(contents.id);
      usage?.unsubscribe?.();
      usageSubscriptions.delete(contents.id);
      const balance = balanceSubscriptions.get(contents.id);
      balance?.unsubscribe?.();
      balanceSubscriptions.delete(contents.id);
    });
  }
}

function closeHarnessWindowsForInstance(instance) {
  if (!instance?.id || !TERMINAL_INSTANCE_STATUSES.has(instance.status)) return;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window === mainWindow || window.isDestroyed()) continue;
    const matched = findInstanceForContents(window.webContents);
    if (matched?.id !== instance.id) continue;
    pushUsageSnapshot(window.webContents, remoteModule.manager.usage(instance.id)).catch(() => undefined);
    pushBalanceSnapshot(window.webContents, remoteModule.manager.balance(instance.id)).catch(() => undefined);
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
  process.env.DSH_REMOTE_SETTINGS_DIR = app.getPath('userData');
  if (!process.argv.includes('--no-open')) process.argv.push('--no-open');

  const entry = pathToFileURL(path.resolve(__dirname, '../src/server.mjs')).href;
  remoteModule = await import(entry);
  bindInstanceLifecycle();
  appearanceBridge = createAppearanceBridge({
    BrowserWindow,
    store: remoteModule.appearanceStore,
    isHarnessContents,
  });
  appearanceBridge.bind();
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
  appearanceBridge?.dispose();
  appearanceBridge = undefined;
  for (const subscription of usageSubscriptions.values()) subscription.unsubscribe?.();
  usageSubscriptions.clear();
  for (const subscription of balanceSubscriptions.values()) subscription.unsubscribe?.();
  balanceSubscriptions.clear();
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
    dialog.showErrorBox('DeepSeek Harness Desktop 启动失败', message);
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