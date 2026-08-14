const browser = document.querySelector('#browser');
const browseButton = document.querySelector('#browse');
const workspaceInput = document.querySelector('#workspace');
const hostInput = document.querySelector('#host');

if (browser && browseButton && workspaceInput) {
  const picker = browser.closest('.field-group');
  const originalBrowseHandler = browseButton.onclick;

  picker?.classList.add('workspace-picker');
  browser.setAttribute('role', 'dialog');
  browser.setAttribute('aria-label', '选择远程工作区');
  browseButton.setAttribute('aria-controls', 'browser');
  browseButton.setAttribute('aria-haspopup', 'dialog');
  browseButton.setAttribute('aria-expanded', 'false');

  function isOpen() {
    return !browser.classList.contains('hidden');
  }

  function setOpen(open) {
    browser.classList.toggle('hidden', !open);
    browseButton.setAttribute('aria-expanded', String(open));
    picker?.classList.toggle('workspace-picker-open', open);
  }

  function closePicker({ focus = false } = {}) {
    if (!isOpen()) return;
    setOpen(false);
    if (focus) browseButton.focus();
  }

  function addPopoverControls() {
    let header = browser.querySelector('.browser-path');
    if (!header) {
      header = document.createElement('div');
      header.className = 'browser-path';
      header.textContent = workspaceInput.value || '远程目录';
      browser.prepend(header);
    }
    if (header.querySelector('.browser-popover-actions')) return;

    const currentPath = header.textContent || workspaceInput.value || '远程目录';
    header.textContent = '';
    header.classList.add('browser-popover-header');

    const pathText = document.createElement('span');
    pathText.className = 'browser-path-text';
    pathText.textContent = currentPath;
    pathText.title = currentPath;

    const actions = document.createElement('span');
    actions.className = 'browser-popover-actions';

    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'browser-popover-button select';
    selectButton.textContent = '选择此目录';
    selectButton.title = '将当前目录作为 Harness 工作区并收起';
    selectButton.addEventListener('click', (event) => {
      event.stopPropagation();
      closePicker({ focus: true });
    });

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'browser-popover-button close';
    closeButton.textContent = '收起';
    closeButton.setAttribute('aria-label', '收起远程目录列表');
    closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      closePicker({ focus: true });
    });

    actions.append(selectButton, closeButton);
    header.append(pathText, actions);
  }

  async function openPicker(event) {
    event?.stopPropagation();
    if (isOpen()) return;
    try {
      await originalBrowseHandler?.call(browseButton, event);
    } finally {
      if (!browser.classList.contains('hidden')) {
        addPopoverControls();
        setOpen(true);
      }
    }
  }

  browseButton.onclick = async (event) => {
    event.stopPropagation();
    if (isOpen()) {
      closePicker({ focus: true });
      return;
    }
    await openPicker(event);
  };

  workspaceInput.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!isOpen()) openPicker(event).catch(() => undefined);
  });

  const observer = new MutationObserver(() => {
    if (!browser.classList.contains('hidden')) {
      addPopoverControls();
      browseButton.setAttribute('aria-expanded', 'true');
      picker?.classList.add('workspace-picker-open');
    }
  });
  observer.observe(browser, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

  document.addEventListener('pointerdown', (event) => {
    if (isOpen() && picker && !picker.contains(event.target)) closePicker();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      closePicker({ focus: true });
    }
  });

  hostInput?.addEventListener('change', () => closePicker());

  document.querySelectorAll('.view-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.dataset.view !== 'launch') closePicker();
    });
  });
}
