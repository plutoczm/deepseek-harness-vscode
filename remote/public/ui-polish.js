function initUiPolish() {
  const $ = (selector) => document.querySelector(selector);
  const hostInput = $('#host');
  const workspaceInput = $('#workspace');
  const filesPath = $('#files-path');
  const filesGo = $('#files-go');
  const filesMessage = $('#files-message');
  const remoteFileList = $('#remote-file-list');

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
      } catch (error) {
        window.dshToast?.('无法读取远程 Home', error.message, 'error');
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
}

if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', initUiPolish, { once: true });
else initUiPolish();
