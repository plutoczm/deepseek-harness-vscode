const networkDetails = document.querySelector('.network-options');
const networkBody = networkDetails?.querySelector('.network-options-body');
const proxySummary = document.querySelector('#network-summary');
const hostInput = document.querySelector('#host');
const workspaceInput = document.querySelector('#workspace');
const nativeFetch = window.fetch.bind(window);

let lastNetworkDiagnostics = null;
let networkCheckRunning = false;

const versionLabel = document.querySelector('.titlebar-brand span');
if (versionLabel) versionLabel.textContent = versionLabel.textContent.replace(/0\.8\.[01]/u, '0.9.0');

function selectedNetworkMode() {
  return document.querySelector('input[name="network-mode"]:checked')?.value || 'auto';
}

function setSummary(mode = selectedNetworkMode(), diagnostics = lastNetworkDiagnostics) {
  if (!proxySummary) return;
  const labels = {
    auto: '自动 · GitHub 直连优先',
    direct: '远程服务器直连',
    'local-proxy': '本机代理 127.0.0.1:7890',
  };
  let text = labels[mode] || labels.auto;
  if (mode === 'auto' && diagnostics?.recommendation === 'local-proxy') text = '自动 · 将使用 Windows 7890';
  if (mode === 'auto' && diagnostics?.recommendation === 'direct') text = '自动 · GitHub 直连正常';
  proxySummary.textContent = text;
  proxySummary.classList.toggle('proxy-enabled', mode === 'local-proxy' || diagnostics?.recommendation === 'local-proxy');
}

function statusMarkup(ok, goodText, badText) {
  return `<span class="network-check-state ${ok ? 'good' : 'bad'}"><span class="network-check-dot"></span>${ok ? goodText : badText}</span>`;
}

function readinessLabel(readiness) {
  const status = readiness?.status || 'not-checked';
  const labels = {
    ready: 'Ready ✓',
    'likely-ready': 'Likely ready ✓',
    'auth-warning': '认证风险 ⚠',
    'credential-warning': '凭据风险 ⚠',
    'auth-error': '认证失败 ✕',
    'credential-error': '凭据异常 ✕',
    'network-error': '网络异常 ✕',
    'remote-error': '远端异常 ✕',
    'no-write-permission': '无 Push 权限 ✕',
    'not-repository': '非 Git 仓库',
    'no-origin': '未配置 origin',
    'not-checked': '未检查',
    'diagnostic-error': '诊断失败',
  };
  return labels[status] || status;
}

function renderNetworkDiagnostics(data) {
  lastNetworkDiagnostics = data;
  const direct = document.querySelector('#network-direct-status');
  const proxy = document.querySelector('#network-proxy-status');
  if (direct) {
    const latency = data?.direct?.latencyMs ? ` · ${data.direct.latencyMs} ms` : '';
    direct.innerHTML = statusMarkup(Boolean(data?.direct?.ok), `GitHub 直连可用${latency}`, `GitHub 直连失败${data?.direct?.error ? ` · ${data.direct.error}` : ''}`);
  }
  if (proxy) {
    proxy.innerHTML = statusMarkup(Boolean(data?.localProxy?.ok), 'Windows 127.0.0.1:7890 可用', 'Windows 127.0.0.1:7890 不可用');
  }
  setSummary(selectedNetworkMode(), data);

  const github = data?.github || {};
  const networkDiag = document.querySelector('#diag-github-network');
  const dnsDiag = document.querySelector('#diag-github-dns');
  const authDiag = document.querySelector('#diag-github-auth');
  const credentialDiag = document.querySelector('#diag-git-credential');
  const proxyDiag = document.querySelector('#diag-local-proxy');
  const originDiag = document.querySelector('#diag-git-origin');
  const gitDiag = document.querySelector('#diag-git-version');
  const ghDiag = document.querySelector('#diag-gh-version');
  const readDiag = document.querySelector('#diag-git-read');
  const pushPermissionDiag = document.querySelector('#diag-github-push-permission');
  const readinessDiag = document.querySelector('#diag-push-readiness');

  if (networkDiag) networkDiag.textContent = data?.direct?.ok ? `Direct ✓${data.direct.latencyMs ? ` · ${data.direct.latencyMs}ms` : ''}` : (data?.localProxy?.ok ? 'Direct ✕ · 7890 fallback ✓' : 'GitHub unavailable ✕');
  if (proxyDiag) proxyDiag.textContent = data?.localProxy?.ok ? '127.0.0.1:7890 ✓' : '127.0.0.1:7890 unavailable';
  if (dnsDiag && !github.skipped) dnsDiag.textContent = github.dns?.ok ? `${github.dns.address || 'resolved'} ✓` : 'DNS resolve failed ✕';
  if (gitDiag && !github.skipped) gitDiag.textContent = github.gitVersion || (github.gitAvailable ? 'git available' : 'git 未安装');
  if (ghDiag && !github.skipped) ghDiag.textContent = github.ghVersion || (github.ghAvailable ? 'gh available' : 'gh 未安装');
  if (authDiag && !github.skipped) authDiag.textContent = github.authenticated ? `${github.login || 'github.com'} ✓` : (github.ghAvailable ? 'gh 未登录' : 'gh 未安装');
  if (originDiag && !github.skipped) originDiag.textContent = github.isRepository ? `${github.remoteProtocol || '?'} · ${github.origin || 'origin 未配置'}` : '当前工作区不是 Git 仓库';
  if (readDiag && !github.skipped) readDiag.textContent = github.lsRemote?.ok ? 'git ls-remote ✓' : `失败 · ${github.lsRemote?.classification || 'unknown'}`;
  if (pushPermissionDiag && !github.skipped) {
    pushPermissionDiag.textContent = github.pushPermission?.checked
      ? (github.pushPermission.allowed ? 'GitHub API · 允许 ✓' : 'GitHub API · 无权限 ✕')
      : '未确认';
  }
  if (readinessDiag && !github.skipped) {
    readinessDiag.textContent = readinessLabel(github.pushReadiness);
    readinessDiag.title = github.pushReadiness?.reason || '';
  }
  if (credentialDiag && !github.skipped) {
    if (!github.isRepository) credentialDiag.textContent = '—';
    else if (github.brokenCredentialHelper) credentialDiag.textContent = '异常 helper ✕';
    else if (github.remoteProtocol === 'https' && github.credentialHelpers?.some((item) => item.includes('gh auth git-credential'))) credentialDiag.textContent = 'gh credential helper ✓';
    else if (github.remoteProtocol === 'https') credentialDiag.textContent = 'HTTPS · 未检测到 gh helper';
    else credentialDiag.textContent = `${github.remoteProtocol || 'other'} · 不需要 HTTPS helper`;
  }

  const repair = document.querySelector('#repair-github-credential');
  if (repair && !github.skipped) repair.disabled = !github.ghAvailable || !github.authenticated || !github.isRepository || github.remoteProtocol !== 'https';
  const copy = document.querySelector('#copy-network-report');
  if (copy) copy.disabled = !lastNetworkDiagnostics;
}

function diagnosticReport(data = lastNetworkDiagnostics) {
  const github = data?.github || {};
  const lines = [
    'DeepSeek Harness Desktop Network Doctor',
    `Generated: ${new Date().toISOString()}`,
    `SSH host: ${hostInput?.value?.trim() || '(none)'}`,
    `Workspace: ${workspaceInput?.value?.trim() || '(none)'}`,
    `Network policy: ${selectedNetworkMode()}`,
    `Recommended route: ${data?.recommendation || 'unknown'}`,
    `GitHub HTTPS direct: ${data?.direct?.ok ? `OK${data.direct.latencyMs ? ` (${data.direct.latencyMs} ms)` : ''}` : `FAIL (${data?.direct?.error || 'unknown'})`}`,
    `Windows proxy 127.0.0.1:7890: ${data?.localProxy?.ok ? 'OK' : 'unavailable'}`,
  ];
  if (!github.skipped) {
    lines.push(
      `GitHub DNS: ${github.dns?.ok ? `OK (${github.dns.address || 'resolved'})` : 'FAIL'}`,
      `Git: ${github.gitVersion || (github.gitAvailable ? 'available' : 'not installed')}`,
      `GitHub CLI: ${github.ghVersion || (github.ghAvailable ? 'available' : 'not installed')}`,
      `GitHub auth: ${github.authenticated ? `OK (${github.login || 'authenticated'})` : 'not authenticated'}`,
      `Repository: ${github.isRepository ? 'yes' : 'no'}`,
      `Origin: ${github.origin || '(none)'}`,
      `Remote protocol: ${github.remoteProtocol || '(none)'}`,
      `GitHub repository slug: ${github.repositorySlug || '(unknown)'}`,
      `Credential helper: ${github.brokenCredentialHelper ? 'BROKEN' : (github.credentialHelpers?.some((item) => item.includes('gh auth git-credential')) ? 'gh helper detected' : 'no gh helper detected')}`,
      `git ls-remote: ${github.lsRemote?.ok ? 'OK' : `FAIL (${github.lsRemote?.classification || 'unknown'})`}`,
      `GitHub API push permission: ${github.pushPermission?.checked ? (github.pushPermission.allowed ? 'ALLOWED' : 'DENIED') : 'not confirmed'}`,
      `Push readiness: ${github.pushReadiness?.status || 'unknown'}`,
      `Push readiness note: ${github.pushReadiness?.reason || 'n/a'}`,
      'Write operation performed: no (Network Doctor remains read-only)',
    );
  }
  return lines.join('\n');
}

async function copyDiagnosticReport() {
  if (!lastNetworkDiagnostics) {
    window.dshToast?.('暂无诊断报告', '请先运行 GitHub 网络检查。', 'info');
    return;
  }
  try {
    await navigator.clipboard.writeText(diagnosticReport());
    window.dshToast?.('诊断报告已复制', '报告不包含 GitHub Token、SSH 私钥或 DeepSeek API Key。', 'success');
  } catch (error) {
    window.dshToast?.('复制失败', error.message, 'error');
  }
}

async function checkNetwork({ quiet = false } = {}) {
  const host = hostInput?.value?.trim() || '';
  const workspace = workspaceInput?.value?.trim() || '';
  if (!host) {
    if (!quiet) window.dshToast?.('GitHub 网络检查需要 SSH 服务器', '先在首页切换到 SSH 并选择服务器。', 'info');
    return null;
  }
  if (networkCheckRunning) return lastNetworkDiagnostics;
  networkCheckRunning = true;
  const button = document.querySelector('#check-github-network');
  if (button && !quiet) { button.disabled = true; button.textContent = '检查中…'; }
  try {
    const response = await nativeFetch('/api/network/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host, workspace: quiet ? '' : workspace }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    renderNetworkDiagnostics(data);
    if (!quiet) {
      const route = data.recommendation === 'direct'
        ? '服务器直连 GitHub 正常。'
        : data.recommendation === 'local-proxy'
          ? '服务器直连异常，Windows 7890 可作为备用线路。'
          : '服务器直连和 Windows 7890 都不可用。';
      window.dshToast?.('Network Doctor 完成', `${route}${data.github?.pushReadiness ? ` Push: ${readinessLabel(data.github.pushReadiness)}` : ''}`, data.recommendation === 'direct' ? 'success' : 'info');
    }
    return data;
  } catch (error) {
    if (!quiet) window.dshToast?.('GitHub 网络检查失败', error.message, 'error');
    return null;
  } finally {
    networkCheckRunning = false;
    if (button && !quiet) { button.disabled = false; button.textContent = '检查 GitHub'; }
  }
}

async function repairCredential() {
  const host = hostInput?.value?.trim() || '';
  const workspace = workspaceInput?.value?.trim() || '';
  if (!host || !workspace) {
    window.dshToast?.('无法修复 GitHub 凭据', '需要先选择 SSH 服务器和 Git 工作区。', 'error');
    return;
  }
  if (!window.confirm('将在远程服务器上运行 gh auth setup-git。若当前仓库存在已知的损坏 gh credential helper，会先移除该损坏项。继续吗？')) return;
  const button = document.querySelector('#repair-github-credential');
  if (button) { button.disabled = true; button.textContent = '修复中…'; }
  try {
    const response = await nativeFetch('/api/github/repair-credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host, workspace }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    window.dshToast?.('GitHub 凭据已修复', `${data.github?.login || 'github.com'} · HTTPS credential helper 已重新配置。`, 'success');
    await checkNetwork({ quiet: false });
  } catch (error) {
    window.dshToast?.('GitHub 凭据修复失败', error.message, 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = '修复 GitHub 凭据'; }
  }
}

function installNetworkUi() {
  if (networkBody) {
    networkBody.innerHTML = `
      <div class="network-policy-list" role="radiogroup" aria-label="GitHub 网络策略">
        <label class="network-policy-option recommended">
          <input type="radio" name="network-mode" value="auto" checked>
          <span><strong>自动（推荐）</strong><small>先用远程服务器直连 GitHub；失败时才尝试 Windows 127.0.0.1:7890。</small></span>
          <em>AUTO</em>
        </label>
        <label class="network-policy-option">
          <input type="radio" name="network-mode" value="direct">
          <span><strong>始终服务器直连</strong><small>完全不使用 Windows VPN / 代理。</small></span>
        </label>
        <label class="network-policy-option">
          <input type="radio" name="network-mode" value="local-proxy">
          <span><strong>始终使用本机 7890</strong><small>通过 SSH reverse tunnel 将 Git / curl / wget 等工具流量转到 Windows 代理。</small></span>
        </label>
      </div>
      <div class="network-live-status">
        <div id="network-direct-status">${statusMarkup(false, '', 'GitHub 直连 · 未检查')}</div>
        <div id="network-proxy-status">${statusMarkup(false, '', 'Windows 7890 · 未检查')}</div>
        <button id="check-github-network" class="network-check-button" type="button">检查 GitHub</button>
      </div>
      <p class="proxy-route-note">代理只注入新 SSH Harness 实例的 Bash / Git / curl / wget 工具环境；<strong>DeepSeek 模型请求仍保持远程服务器直连</strong>。</p>
    `;
    document.querySelectorAll('input[name="network-mode"]').forEach((input) => input.addEventListener('change', () => setSummary()));
    document.querySelector('#check-github-network')?.addEventListener('click', () => checkNetwork());
    setSummary('auto');
  }

  const runtimeCard = document.querySelector('#settings-runtime');
  const grid = runtimeCard?.querySelector('.diagnostic-grid');
  if (grid && !document.querySelector('#diag-github-network')) {
    grid.insertAdjacentHTML('beforeend', `
      <div class="diagnostic-item"><span>GitHub 网络</span><strong id="diag-github-network">未检查</strong></div>
      <div class="diagnostic-item"><span>GitHub DNS</span><strong id="diag-github-dns">未检查</strong></div>
      <div class="diagnostic-item"><span>Windows 7890</span><strong id="diag-local-proxy">未检查</strong></div>
      <div class="diagnostic-item"><span>Git</span><strong id="diag-git-version">未检查</strong></div>
      <div class="diagnostic-item"><span>GitHub CLI</span><strong id="diag-gh-version">未检查</strong></div>
      <div class="diagnostic-item"><span>GitHub 认证</span><strong id="diag-github-auth">未检查</strong></div>
      <div class="diagnostic-item"><span>Git remote</span><strong id="diag-git-origin">未检查</strong></div>
      <div class="diagnostic-item"><span>Git credential</span><strong id="diag-git-credential">未检查</strong></div>
      <div class="diagnostic-item"><span>Remote read</span><strong id="diag-git-read">未检查</strong></div>
      <div class="diagnostic-item"><span>GitHub Push 权限</span><strong id="diag-github-push-permission">未检查</strong></div>
      <div class="diagnostic-item"><span>Push readiness</span><strong id="diag-push-readiness">未检查</strong></div>
    `);
    const actions = document.createElement('div');
    actions.className = 'github-diagnostic-actions';
    actions.innerHTML = '<button id="github-diagnostics" class="button secondary" type="button">运行 Network Doctor</button><button id="copy-network-report" class="button secondary" type="button" disabled>复制诊断报告</button><button id="repair-github-credential" class="button secondary" type="button" disabled>修复 GitHub 凭据</button><span>诊断只读；修复操作只在你点击按钮并确认后执行。</span>';
    runtimeCard.appendChild(actions);
    document.querySelector('#github-diagnostics')?.addEventListener('click', () => checkNetwork());
    document.querySelector('#copy-network-report')?.addEventListener('click', copyDiagnosticReport);
    document.querySelector('#repair-github-credential')?.addEventListener('click', repairCredential);
  }
}

installNetworkUi();

window.fetch = async (input, init = {}) => {
  let pathname = '';
  try {
    pathname = new URL(typeof input === 'string' ? input : input.url, window.location.href).pathname;
  } catch {
    pathname = '';
  }

  if (pathname === '/api/launch' && String(init.method || 'GET').toUpperCase() === 'POST' && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body);
      if (body.mode === 'ssh') {
        const requestedMode = selectedNetworkMode();
        let effectiveMode = requestedMode;
        if (requestedMode === 'auto') {
          const diagnostics = await checkNetwork({ quiet: true });
          effectiveMode = diagnostics?.recommendation === 'local-proxy' ? 'local-proxy' : 'direct';
          if (diagnostics?.recommendation === 'local-proxy') {
            window.dshToast?.('GitHub 自动切换备用网络', '服务器直连异常，新 Harness 实例将使用 Windows 127.0.0.1:7890。', 'info');
          }
        }
        body.networkMode = effectiveMode;
        body.enableLocalProxy = effectiveMode === 'local-proxy';
      } else {
        body.networkMode = 'direct';
        body.enableLocalProxy = false;
      }
      init = { ...init, body: JSON.stringify(body) };
    } catch {
      // Leave malformed/non-JSON launch requests untouched; the normal API error path will handle them.
    }
  }

  return nativeFetch(input, init);
};
