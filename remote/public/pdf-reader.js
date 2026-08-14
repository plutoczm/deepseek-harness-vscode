import { mountRemotePdfViewer } from './pdf-viewer.js';

const params = new URLSearchParams(location.search);
const host = params.get('host') || '';
const path = params.get('path') || '';
const name = params.get('name') || path.split('/').at(-1) || 'document.pdf';
const size = Number(params.get('size')) || 0;
const root = document.querySelector('#pdf-reader');

document.title = `${name} · DeepSeek Harness Remote`;

if (!host || !path || !/\.pdf$/iu.test(path)) {
  root.innerHTML = '<div class="pdf-error"><span>!</span><strong>缺少 PDF 参数</strong><small>请从“远程文件”页面打开 PDF。</small></div>';
} else {
  mountRemotePdfViewer(root, { host, path, name, size, standalone: true });
}
