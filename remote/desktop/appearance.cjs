function cssEscapeUrl(value) {
  return String(value || '').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '');
}

function wallpaperScript(settings, dataUrl) {
  const enabled = settings?.enabled !== false && Boolean(dataUrl);
  const image = cssEscapeUrl(dataUrl);
  const opacity = Math.max(50, Math.min(100, Number(settings?.opacity ?? 82)));
  const blur = Math.max(0, Math.min(32, Number(settings?.blur ?? 16)));
  const details = Math.min(100, opacity + 3);
  return `(() => {
    const id = 'dhr-wallpaper-style';
    let style = document.getElementById(id);
    if (!${enabled ? 'true' : 'false'}) {
      style?.remove();
      document.documentElement.removeAttribute('data-dhr-wallpaper');
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      document.head.appendChild(style);
    }
    document.documentElement.setAttribute('data-dhr-wallpaper', '1');
    style.textContent = \`
html,body{background-image:url("${image}")!important;background-size:cover!important;background-position:center!important;background-repeat:no-repeat!important;background-attachment:fixed!important;background-color:#111317!important}
.pI_x6G_frame{background-color:transparent!important;position:relative!important;isolation:isolate!important}
.pI_x6G_frame::before{content:"";position:absolute;inset:-2%;z-index:-1;pointer-events:none;background-image:url("${image}")!important;background-size:cover!important;background-position:center!important;background-repeat:no-repeat!important;filter:blur(${blur}px) saturate(1.18)!important;transform:scale(1.03)}
.pI_x6G_sidebarCol,.hHd-Xa_root{background-color:color-mix(in srgb,var(--dsw-specific-sidebar-fill) ${opacity}%,transparent)!important;backdrop-filter:blur(14px)}
.hHd-Xa_newSession{background-color:color-mix(in srgb,var(--dsw-alias-button-elevated-fill) ${opacity}%,transparent)!important;border-color:color-mix(in srgb,var(--dsw-alias-border-l2) 65%,transparent)!important}
.wSkVaW_root{background-color:color-mix(in srgb,var(--dsw-alias-bg-base) ${opacity}%,transparent)!important;backdrop-filter:blur(10px)}
.wSkVaW_root[data-phase="active"] .wSkVaW_composerSeat{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-base) 0%,transparent) 0px,color-mix(in srgb,var(--dsw-alias-bg-base) ${opacity}%,transparent) 36px)!important}
.ydkMvW_root{background-color:color-mix(in srgb,var(--dsw-alias-bg-base) ${details}%,transparent)!important;backdrop-filter:blur(12px)}
@supports not (background:color-mix(in srgb,red 50%,blue)){.pI_x6G_sidebarCol,.hHd-Xa_root{background-color:rgba(25,27,31,.9)!important}.wSkVaW_root,.ydkMvW_root{background-color:rgba(20,22,26,.9)!important}}
\`;
  })();`;
}

function createAppearanceBridge({ BrowserWindow, store, isHarnessContents }) {
  let unsubscribe;
  let generation = 0;

  async function apply(contents) {
    if (!contents || contents.isDestroyed() || !isHarnessContents(contents)) return;
    const current = ++generation;
    const [settings, dataUrl] = await Promise.all([store.get(), store.wallpaperDataUrl()]);
    if (contents.isDestroyed() || current < generation - 8) return;
    await contents.executeJavaScript(wallpaperScript(settings, dataUrl), true).catch(() => undefined);
  }

  async function refreshAll() {
    const windows = BrowserWindow.getAllWindows();
    await Promise.all(windows.map((window) => apply(window.webContents)));
  }

  function bind() {
    unsubscribe?.();
    const handler = () => { refreshAll().catch(() => undefined); };
    store.on('change', handler);
    unsubscribe = () => store.off('change', handler);
  }

  function dispose() {
    unsubscribe?.();
    unsubscribe = undefined;
  }

  return { apply, bind, dispose, refreshAll };
}

module.exports = { createAppearanceBridge };
