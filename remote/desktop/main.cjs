const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_ID = 'io.github.plutoczm.deepseek-harness-remote';
const APP_NAME = 'DeepSeek Harness Remote';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const BILLING_REFRESH_MS = 10000;

let mainWindow;
let remoteModule;
let quitting = false;
let launcherUrl;
let launcherPort;
const billingTimers = new Map();

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

function getJson(url, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        try {
          const data = raw ? JSON.parse(raw) : {};
          if (response.statusCode >= 200 && response.statusCode < 300) resolve(data);
          else reject(new Error(data.error || `HTTP ${response.statusCode}`));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('timeout', () => request.destroy(new Error('request timeout')));
    request.once('error', reject);
  });
}

function billingWidgetScript() {
  return `(() => {
    if (document.getElementById('dhr-billing-widget')) return;
    const style = document.createElement('style');
    style.id = 'dhr-billing-style';
    style.textContent = \`
      #dhr-billing-widget{position:fixed;top:12px;right:16px;z-index:2147483646;min-width:218px;max-width:310px;padding:10px 12px;border:1px solid rgba(255,255,255,.11);border-radius:12px;background:rgba(22,23,25,.94);backdrop-filter:blur(16px);box-shadow:0 10px 30px rgba(0,0,0,.28);font:12px/1.4 Inter,Segoe UI,system-ui,sans-serif;color:#e8eaed;pointer-events:auto;user-select:none}
      #dhr-billing-widget .dhr-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
      #dhr-billing-widget .dhr-title{font-weight:650;color:#f5f6f7}
      #dhr-billing-widget .dhr-live{display:inline-flex;align-items:center;gap:5px;color:#8b9098;font-size:10px}
      #dhr-billing-widget .dhr-live:before{content:'';width:6px;height:6px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.12)}
      #dhr-billing-widget .dhr-values{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin-top:8px;padding-top:7px;border-top:1px solid rgba(255,255,255,.07)}
      #dhr-billing-widget .dhr-label{color:#858a92;font-size:10.5px}
      #dhr-billing-widget .dhr-value{text-align:right;color:#d5d8dc;font:600 11px/1.45 SFMono-Regular,Consolas,monospace}
      #dhr-billing-widget .dhr-spend{color:#8fb4ff}
      #dhr-billing-widget .dhr-note{margin-top:6px;color:#666c75;font-size:9.5px;white-space:normal}
      #dhr-billing-widget[data-error='1'] .dhr-live:before{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.12)}
    \`;
    document.head.appendChild(style);
    const box = document.createElement('div');
    box.id = 'dhr-billing-widget';
    box.innerHTML = '<div class="dhr-row"><span class="dhr-title">DeepSeek API</span><span class="dhr-live">实时</span></div><div class="dhr-values"><span class="dhr-label">余额</span><span class="dhr-value">检测中…</span><span class="dhr-label">本实例消耗</span><span class="dhr-value dhr-spend">—</span></div><div class="dhr-note">每 10 秒刷新；实例消耗按账户余额下降计算。</div>';
    document.body.appendChild(box);
    window.__DHR_UPDATE_BILLING__ = (payload) => {
      const widget = document.getElementById('dhr-billing-widget');
      if (!widget) return;
      const values = widget.querySelectorAll('.dhr-value');
      const live = widget.querySelector('.dhr-live');
      const note = widget.querySelector('.dhr-note');
      if (!payload || !payload.available) {
        widget.dataset.error = '1';
        values[0].textContent = '不可用';
        values[1].textContent = '—';
        live.textContent = '未启用';
        note.textContent = payload?.error || '远程登录 Shell 未检测到 DEEPSEEK_API_KEY。';
        return;
      }
      widget.dataset.error = '0';
      live.textContent = payload.isAvailable === false ? '余额不足' : '实时';
      const format = (item, field) => {
        const symbol = item.currency === 'CNY' ? '¥' : item.currency === 'USD' ? '$' : item.currency + ' ';
        return symbol + Number(item[field] || 0).toFixed(4);
      };
      values[0].textContent = (payload.balances || []).map((item) => format(item, 'total')).join(' · ') || '—';
      values[1].textContent = (payload.delta || []).map((item) => {
        const symbol = item.currency === 'CNY' ? '¥' : item.currency === 'USD' ? '$' : item.currency + ' ';
        return '≈ ' + symbol + Number(item.amount || 0).toFixed(4);
      }).join(' · ') || '≈ 0.0000';
      note.textContent = '余额来自 DeepSeek /user/balance；同一 API Key 的其他并发调用也会计入该差值。';
    };
  })();`;
}

async function findInstanceForContents(contents) {
  if (!launcherUrl || contents.isDestroyed()) return undefined;
  let port;
  try {
    port = Number(new URL(contents.getURL()).port);
  } catch {
    return undefined;
  }
  if (!port || port === launcherPort) return undefined;
  const data = await getJson(`${launcherUrl}/api/instances`);
  return data.instances?.find((instance) => Number(instance.localPort) === port);
}

async function updateBillingOverlay(contents) {
  if (contents.isDestroyed()) return;
  try {
    const instance = await findInstanceForContents(contents);
    if (!instance) return;
    const balance = await getJson(`${launcherUrl}/api/instances/${encodeURIComponent(instance.id)}/balance`, 15000);
    if (!contents.isDestroyed()) {
      await contents.executeJavaScript(`window.__DHR_UPDATE_BILLING__?.(${JSON.stringify(balance)})`, true).catch(() => undefined);
    }
  } catch (error) {
    if (!contents.isDestroyed()) {
      const payload = { available: false, error: error instanceof Error ? error.message : String(error) };
      await contents.executeJavaScript(`window.__DHR_UPDATE_BILLING__?.(${JSON.stringify(payload)})`, true).catch(() => undefined);
    }
  }
}

function attachBillingOverlay(contents) {
  if (contents.isDestroyed() || billingTimers.has(contents.id)) return;
  let url;
  try { url = new URL(contents.getURL()); } catch { return; }
  if (!LOOPBACK_HOSTS.has(url.hostname) || Number(url.port) === launcherPort) return;
  contents.executeJavaScript(billingWidgetScript(), true).catch(() => undefined);
  updateBillingOverlay(contents).catch(() => undefined);
  const timer = setInterval(() => updateBillingOverlay(contents).catch(() => undefined), BILLING_REFRESH_MS);
  timer.unref?.();
  billingTimers.set(contents.id, timer);
  contents.once('destroyed', () => {
    clearInterval(timer);
    billingTimers.delete(contents.id);
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

  contents.on('did-finish-load', () => attachBillingOverlay(contents));
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
  for (const timer of billingTimers.values()) clearInterval(timer);
  billingTimers.clear();
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
