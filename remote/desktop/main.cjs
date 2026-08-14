const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_ID = 'io.github.plutoczm.deepseek-harness-remote';
const APP_NAME = 'DeepSeek Harness Remote';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

let mainWindow;
let remoteModule;
let quitting = false;

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
  return `http://127.0.0.1:${port}`;
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
    const launcherUrl = await startEmbeddedLauncher();
    createMainWindow(launcherUrl);
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
