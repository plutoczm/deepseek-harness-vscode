const proxyToggle = document.querySelector('#use-local-proxy');
const proxySummary = document.querySelector('#network-summary');

if (proxyToggle) {
  proxyToggle.checked = false;
  const updateSummary = () => {
    if (!proxySummary) return;
    proxySummary.textContent = proxyToggle.checked
      ? '本机代理 127.0.0.1:7890 · 仅当前新实例'
      : '远程服务器直连 · 推荐';
    proxySummary.classList.toggle('proxy-enabled', proxyToggle.checked);
  };
  proxyToggle.addEventListener('change', updateSummary);
  updateSummary();
}

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  let pathname = '';
  try {
    pathname = new URL(typeof input === 'string' ? input : input.url, window.location.href).pathname;
  } catch {
    pathname = '';
  }

  if (pathname === '/api/launch' && String(init.method || 'GET').toUpperCase() === 'POST' && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body);
      body.enableLocalProxy = Boolean(proxyToggle?.checked);
      init = { ...init, body: JSON.stringify(body) };
    } catch {
      // Leave malformed/non-JSON launch requests untouched; the normal API error path will handle them.
    }
  }

  return nativeFetch(input, init);
};
