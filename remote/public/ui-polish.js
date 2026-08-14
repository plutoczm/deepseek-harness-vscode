function initUiPolish() {
  const $ = (selector) => document.querySelector(selector);
  const brandMark = $('.brand-mark');
  const hostInput = $('#host');
  const workspaceInput = $('#workspace');
  const filesPath = $('#files-path');
  const filesGo = $('#files-go');
  const remoteFileList = $('#remote-file-list');
  const instances = $('#instances');
  const logPanel = $('.log-panel');
  const logTools = $('.log-tools');

  if (brandMark) {
    brandMark.textContent = '';
    brandMark.classList.add('brand-mark-whale');
    const image = document.createElement('img');
    image.src = '/whale-mark.svg';
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    brandMark.append(image);
    brandMark.title = 'DeepSeek Harness Remote · community launcher';
  }

  const localChip = $('.local-chip');
  if (localChip && !$('#header-remote-chip')) {
    const chip = document.createElement('div');
    chip.id = 'header-remote-chip';
    chip.className = 'local-chip remote-host-chip';
    chip.innerHTML = '<span class="remote-host-dot"></span><span class="remote-host-text">SSH · 未选择</span>';
    localChip.insertAdjacentElement('afterend', chip);

    const syncHostChip = () => {
      const value = hostInput?.value.trim();
      chip.querySelector('.remote-host-text').textContent = value ? `SSH · ${value}` : 'SSH · 未选择';
      chip.classList.toggle('connected', Boolean(value));
    };
    syncHostChip();
    hostInput?.addEventListener('input', syncHostChip);
    hostInput?.addEventListener('change', syncHostChip);
  }

  document.querySelectorAll('.view-tab').forEach((tab) => {
    if (tab.querySelector('.view-tab-icon')) return;
    const icon = document.createElement('span');
    icon.className = 'view-tab-icon';
    icon.textContent = tab.dataset.view === 'files' ? '⌁' : '⌘';
    tab.prepend(icon);
  });

  const envCopy = $('.env-copy');
  if (envCopy) {
    const title = envCopy.querySelector('strong');
    const detail = envCopy.querySelector('span');
    if (title) title.textContent = '每个 Harness 会话固定环境白名单 + 默认环境';
    if (detail) detail.innerHTML = '首次执行 Bash 时选择允许使用的 Conda / venv 集合和默认环境；Python 命令会在白名单内自动路由，使用 <code>/env</code> 管理。';
    const badge = $('.env-badge');
    if (badge) badge.textContent = 'MULTI ENV';
  }

  if (logPanel && logTools && !$('#toggle-logs')) {
    const button = document.createElement('button');
    button.id = 'toggle-logs';
    button.className = 'icon-button text-button log-toggle';
    button.type = 'button';

    const setCollapsed = (collapsed) => {
      logPanel.classList.toggle('is-collapsed', collapsed);
      button.textContent = collapsed ? '展开日志' : '收起日志';
      button.setAttribute('aria-expanded', String(!collapsed));
    };

    setCollapsed(true);
    button.addEventListener('click', () => setCollapsed(!logPanel.classList.contains('is-collapsed')));
    logTools.append(button);

    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-log]')) setCollapsed(false);
    }, true);
  }

  const instancesTitle = $('.instances-panel .section-title.compact');
  if (instancesTitle && instances && !$('#instance-count')) {
    const refreshButton = instancesTitle.querySelector('#refresh');
    const counter = document.createElement('span');
    counter.id = 'instance-count';
    counter.className = 'section-counter';
    counter.textContent = '0';
    refreshButton?.insertAdjacentElement('beforebegin', counter);

    const syncInstances = () => {
      const cards = [...instances.querySelectorAll('.instance')];
      counter.textContent = String(cards.length);
      counter.title = `${cards.length} 个 Harness 实例`;
      counter.classList.toggle('active', cards.length > 0);
      for (const card of cards) {
        const pill = card.querySelector('.pill');
        const terminal = pill?.classList.contains('error') || pill?.classList.contains('stopped');
        if (terminal) card.querySelector('.instance-action.open')?.remove();
      }
    };
    syncInstances();
    new MutationObserver(syncInstances).observe(instances, { childList: true, subtree: true });
  }

  const filesMessage = $('#files-message');
  if (filesMessage && remoteFileList && !$('#file-quickbar')) {
    const quickbar = document.createElement('div');
    quickbar.id = 'file-quickbar';
    quickbar.className = 'file-quickbar';
    quickbar.innerHTML = `
      <div class="quick-paths" aria-label="快捷路径">
        <button type="button" class="quick-path-button" data-quick-path="root">/ 根目录</button>
        <button type="button" class="quick-path-button" data-quick-path="home">Home</button>
        <button type="button" class="quick-path-button" data-quick-path="workspace">当前工作区</button>
      </div>
      <div class="directory-filter-shell">
        <span class="directory-filter-icon" aria-hidden="true">⌕</span>
        <input id="directory-filter" type="search" autocomplete="off" spellcheck="false" placeholder="筛选当前目录…" aria-label="筛选当前目录">
        <span id="directory-filter-count" class="directory-filter-count"></span>
      </div>`;
    filesMessage.insertAdjacentElement('beforebegin', quickbar);

    const filterInput = $('#directory-filter');
    const filterCount = $('#directory-filter-count');
    let selectedPath = '';

    const navigate = (value) => {
      if (!value || !filesPath || !filesGo) return;
      filesPath.value = value;
      filesGo.click();
    };

    quickbar.querySelector('[data-quick-path="root"]').addEventListener('click', () => navigate('/'));
    quickbar.querySelector('[data-quick-path="workspace"]').addEventListener('click', () => navigate(workspaceInput?.value.trim() || '/'));
    quickbar.querySelector('[data-quick-path="home"]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const selectedHost = hostInput?.value.trim();
      if (!selectedHost) return;
      const original = button.textContent;
      button.disabled = true;
      button.textContent = '读取中…';
      try {
        const response = await fetch('/api/check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host: selectedHost }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        navigate(data.home || '/');
      } catch {
        // The regular file page error surface remains the canonical error UI.
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    });

    const applyFilter = () => {
      const query = filterInput.value.trim().toLocaleLowerCase();
      const rows = [...remoteFileList.querySelectorAll('.remote-file-row')];
      let visible = 0;
      for (const row of rows) {
        const text = `${row.textContent} ${row.dataset.filePath || ''}`.toLocaleLowerCase();
        const match = !query || text.includes(query);
        row.hidden = !match;
        if (match) visible += 1;
        row.classList.toggle('selected', Boolean(selectedPath && row.dataset.filePath === selectedPath));
      }
      filterCount.textContent = query && rows.length ? `${visible}/${rows.length}` : '';
    };

    filterInput.addEventListener('input', applyFilter);
    remoteFileList.addEventListener('click', (event) => {
      const row = event.target.closest('.remote-file-row');
      if (!row) return;
      selectedPath = row.dataset.filePath || '';
      applyFilter();
    });
    new MutationObserver(applyFilter).observe(remoteFileList, { childList: true, subtree: true });
  }

  const footer = $('.footer-note');
  if (footer && !footer.querySelector('.footer-disclaimer')) {
    const disclaimer = document.createElement('span');
    disclaimer.className = 'footer-disclaimer';
    disclaimer.textContent = 'Community remote launcher · not affiliated with or endorsed by DeepSeek.';
    footer.append(disclaimer);
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initUiPolish, { once: true });
} else {
  initUiPolish();
}
