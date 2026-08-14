import { mountRemotePdfViewer } from './pdf-viewer.js';

const hostInput = document.querySelector('#host');
const filePreview = document.querySelector('#file-preview');
const previewPath = document.querySelector('#preview-path');
const previewName = document.querySelector('#preview-name');
const remoteFileList = document.querySelector('#remote-file-list');

let activeViewer;
let activeKey = '';
let mountTimer;
let lastKnownSize = 0;

function selectedRowSize(path) {
  const row = [...(remoteFileList?.querySelectorAll('.remote-file-row') || [])]
    .find((item) => item.dataset.filePath === path);
  if (!row) return 0;
  const sizeText = row.querySelector('.remote-file-size')?.textContent?.trim() || '';
  const match = /([\d.]+)\s*(B|KB|MB|GB)/iu.exec(sizeText);
  if (!match) return 0;
  const multipliers = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  return Number(match[1]) * (multipliers[match[2].toUpperCase()] || 1);
}

async function unmount() {
  const viewer = activeViewer;
  activeViewer = undefined;
  activeKey = '';
  if (viewer) await viewer.destroy().catch(() => undefined);
}

async function maybeMountPdf() {
  if (!filePreview || !previewPath || !hostInput) return;
  const path = previewPath.textContent.trim();
  const host = hostInput.value.trim();
  const name = previewName?.textContent?.trim() || path.split('/').at(-1) || 'document.pdf';

  if (!host || !/\.pdf$/iu.test(path)) {
    if (activeViewer) await unmount();
    return;
  }
  if (name === '加载中…') return;

  const key = `${host}\n${path}`;
  if (activeKey === key && filePreview.querySelector('.pdf-viewer')) return;
  await unmount();
  activeKey = key;
  lastKnownSize = selectedRowSize(path);
  filePreview.innerHTML = '';
  activeViewer = mountRemotePdfViewer(filePreview, {
    host,
    path,
    name,
    size: lastKnownSize,
  });
}

function scheduleMount() {
  clearTimeout(mountTimer);
  mountTimer = setTimeout(() => maybeMountPdf().catch(() => undefined), 20);
}

if (filePreview && previewPath) {
  const observer = new MutationObserver(scheduleMount);
  observer.observe(filePreview, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  observer.observe(previewPath, { childList: true, subtree: true, characterData: true });
  if (previewName) observer.observe(previewName, { childList: true, subtree: true, characterData: true });
  hostInput?.addEventListener('change', scheduleMount);
  hostInput?.addEventListener('input', scheduleMount);
  scheduleMount();
}
