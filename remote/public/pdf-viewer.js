let pdfJsPromise;

async function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import('/vendor/pdfjs/build/pdf.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';
      return pdfjs;
    });
  }
  return pdfJsPromise;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function compactBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let scaled = value;
  let index = -1;
  do {
    scaled /= 1024;
    index += 1;
  } while (scaled >= 1024 && index < units.length - 1);
  return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

function normalizeSearch(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase();
}

function countOccurrences(text, query) {
  if (!query) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= text.length - query.length) {
    const index = text.indexOf(query, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(1, query.length);
  }
  return count;
}

export function remotePdfUrl(host, path, { download = false, cacheBust } = {}) {
  const params = new URLSearchParams({ host, path });
  if (download) params.set('download', '1');
  if (cacheBust) params.set('v', String(cacheBust));
  return `/api/pdf?${params.toString()}`;
}

export class RemotePdfViewer {
  constructor(container, options) {
    this.container = container;
    this.options = { standalone: false, size: 0, ...options };
    this.pdf = null;
    this.loadingTask = null;
    this.pageCache = new Map();
    this.pageViews = new Map();
    this.thumbViews = new Map();
    this.renderTasks = new Map();
    this.thumbRenderTasks = new Map();
    this.textCache = new Map();
    this.searchResults = [];
    this.searchIndex = -1;
    this.searchGeneration = 0;
    this.currentPage = 1;
    this.totalPages = 0;
    this.zoomMode = 'fit-width';
    this.manualScale = 1;
    this.destroyed = false;
    this.scrollFrame = 0;
    this.storageKey = `dhr:pdf:${this.options.host}:${this.options.path}`;
    this.restoreState();
    this.buildUi();
    this.bindEvents();
    this.load().catch((error) => this.showError(error));
  }

  restoreState() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey) || '{}');
      if (Number.isFinite(saved.page) && saved.page > 0) this.currentPage = Math.floor(saved.page);
      if (saved.zoomMode === 'manual' || saved.zoomMode === 'fit-width') this.zoomMode = saved.zoomMode;
      if (Number.isFinite(saved.scale)) this.manualScale = clamp(saved.scale, 0.4, 4);
    } catch {
      // Corrupt local state should never block a document from opening.
    }
  }

  saveState() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({
        page: this.currentPage,
        zoomMode: this.zoomMode,
        scale: this.manualScale,
      }));
    } catch {
      // Storage can be disabled without affecting the reader.
    }
  }

  buildUi() {
    const name = this.options.name || this.options.path.split('/').at(-1) || 'document.pdf';
    const downloadUrl = remotePdfUrl(this.options.host, this.options.path, { download: true });
    this.container.className = this.options.standalone ? 'pdf-reader-host standalone' : 'file-preview pdf-preview';
    this.container.innerHTML = `
      <div class="pdf-viewer" data-standalone="${this.options.standalone ? '1' : '0'}">
        <div class="pdf-toolbar">
          <div class="pdf-toolbar-group page-tools">
            <button type="button" class="pdf-tool icon-only" data-pdf-action="toggle-thumbs" title="缩略图" aria-label="缩略图">☷</button>
            <button type="button" class="pdf-tool icon-only" data-pdf-action="prev-page" title="上一页" aria-label="上一页">‹</button>
            <input class="pdf-page-input" data-pdf-page-input inputmode="numeric" value="1" aria-label="当前页">
            <span class="pdf-page-total">/ <span data-pdf-total>—</span></span>
            <button type="button" class="pdf-tool icon-only" data-pdf-action="next-page" title="下一页" aria-label="下一页">›</button>
          </div>
          <div class="pdf-toolbar-group zoom-tools">
            <button type="button" class="pdf-tool icon-only" data-pdf-action="zoom-out" title="缩小" aria-label="缩小">−</button>
            <button type="button" class="pdf-tool zoom-label" data-pdf-action="actual-size" title="设为 100%"><span data-pdf-zoom>适应宽度</span></button>
            <button type="button" class="pdf-tool icon-only" data-pdf-action="zoom-in" title="放大" aria-label="放大">+</button>
            <button type="button" class="pdf-tool" data-pdf-action="fit-width">适应宽度</button>
          </div>
          <div class="pdf-search-shell">
            <span aria-hidden="true">⌕</span>
            <input type="search" data-pdf-search autocomplete="off" placeholder="搜索 PDF…" aria-label="搜索 PDF">
            <span class="pdf-search-count" data-pdf-search-count></span>
            <button type="button" class="pdf-search-nav" data-pdf-action="prev-result" title="上一个结果">↑</button>
            <button type="button" class="pdf-search-nav" data-pdf-action="next-result" title="下一个结果">↓</button>
          </div>
          <div class="pdf-toolbar-group pdf-toolbar-right">
            <button type="button" class="pdf-tool" data-pdf-action="refresh" title="重新从远程服务器读取最新 PDF">刷新</button>
            ${this.options.standalone ? '' : '<button type="button" class="pdf-tool" data-pdf-action="focus">展开阅读</button>'}
            <button type="button" class="pdf-tool" data-pdf-action="new-window">新窗口</button>
            <a class="pdf-tool pdf-download" href="${esc(downloadUrl)}" download="${esc(name)}">下载</a>
          </div>
        </div>
        <div class="pdf-info-bar">
          <span class="pdf-doc-name">${esc(name)}</span>
          <span data-pdf-meta>${this.options.size ? compactBytes(this.options.size) : '远程 PDF'}</span>
          <span class="pdf-loading-status" data-pdf-status>准备加载…</span>
        </div>
        <div class="pdf-body">
          <aside class="pdf-thumbnails" data-pdf-thumbs aria-label="页面缩略图"></aside>
          <div class="pdf-stage" data-pdf-stage tabindex="0" aria-label="PDF 页面">
            <div class="pdf-pages" data-pdf-pages></div>
          </div>
        </div>
      </div>`;

    this.root = this.container.querySelector('.pdf-viewer');
    this.stage = this.container.querySelector('[data-pdf-stage]');
    this.pages = this.container.querySelector('[data-pdf-pages]');
    this.thumbs = this.container.querySelector('[data-pdf-thumbs]');
    this.pageInput = this.container.querySelector('[data-pdf-page-input]');
    this.totalLabel = this.container.querySelector('[data-pdf-total]');
    this.zoomLabel = this.container.querySelector('[data-pdf-zoom]');
    this.searchInput = this.container.querySelector('[data-pdf-search]');
    this.searchCount = this.container.querySelector('[data-pdf-search-count]');
    this.status = this.container.querySelector('[data-pdf-status]');
    this.meta = this.container.querySelector('[data-pdf-meta]');
  }

  bindEvents() {
    this.root.addEventListener('click', (event) => {
      const action = event.target.closest('[data-pdf-action]')?.dataset.pdfAction;
      if (!action) return;
      if (action === 'prev-page') this.goToPage(this.currentPage - 1);
      if (action === 'next-page') this.goToPage(this.currentPage + 1);
      if (action === 'zoom-out') this.stepZoom(-1);
      if (action === 'zoom-in') this.stepZoom(1);
      if (action === 'actual-size') this.setZoom('manual', 1);
      if (action === 'fit-width') this.setZoom('fit-width');
      if (action === 'refresh') this.load(true).catch((error) => this.showError(error));
      if (action === 'toggle-thumbs') this.root.classList.toggle('thumbs-collapsed');
      if (action === 'prev-result') this.moveSearch(-1);
      if (action === 'next-result') this.moveSearch(1);
      if (action === 'focus') this.toggleFocus(event.target.closest('[data-pdf-action]'));
      if (action === 'new-window') this.openStandalone();
    });

    this.pageInput.addEventListener('change', () => this.goToPage(Number(this.pageInput.value)));
    this.pageInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.goToPage(Number(this.pageInput.value));
        this.stage.focus();
      }
    });

    let searchTimer;
    this.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this.search(this.searchInput.value), 220);
    });
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.moveSearch(event.shiftKey ? -1 : 1);
      }
    });

    this.stage.addEventListener('scroll', () => {
      if (this.scrollFrame) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = 0;
        this.syncCurrentPageFromScroll();
        this.renderNearViewport();
      });
    }, { passive: true });

    this.stage.addEventListener('keydown', (event) => {
      if (event.ctrlKey && event.key.toLocaleLowerCase() === 'f') {
        event.preventDefault();
        this.searchInput.focus();
        this.searchInput.select();
      } else if (event.key === 'PageDown') {
        event.preventDefault();
        this.goToPage(this.currentPage + 1);
      } else if (event.key === 'PageUp') {
        event.preventDefault();
        this.goToPage(this.currentPage - 1);
      }
    });

    this.resizeObserver = new ResizeObserver(() => {
      if (this.zoomMode !== 'fit-width' || !this.pdf) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.updatePageDimensions();
        this.renderNearViewport(true);
      }, 100);
    });
    this.resizeObserver.observe(this.stage);
  }

  async load(force = false) {
    if (this.destroyed) return;
    this.status.textContent = '正在通过 SSH 读取 PDF…';
    this.root.classList.add('is-loading');
    this.searchResults = [];
    this.searchIndex = -1;
    this.searchCount.textContent = '';
    this.textCache.clear();
    this.cancelRendering();
    this.pageObserver?.disconnect();
    this.thumbObserver?.disconnect();
    this.pageCache.clear();
    this.pageViews.clear();
    this.thumbViews.clear();
    this.pages.innerHTML = '<div class="pdf-document-loading"><span class="preview-spinner"></span><strong>正在打开远程 PDF</strong><small>PDF.js 会按需读取页面数据。</small></div>';
    this.thumbs.innerHTML = '';

    if (this.loadingTask) await this.loadingTask.destroy().catch(() => undefined);
    const pdfjs = await loadPdfJs();
    const url = remotePdfUrl(this.options.host, this.options.path, { cacheBust: force ? Date.now() : undefined });
    const loadingTask = pdfjs.getDocument({
      url,
      rangeChunkSize: 256 * 1024,
      cMapUrl: '/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      wasmUrl: '/vendor/pdfjs/wasm/',
    });
    this.loadingTask = loadingTask;
    loadingTask.onProgress = ({ loaded, total }) => {
      if (this.loadingTask !== loadingTask) return;
      const percent = total > 0 ? Math.round(loaded / total * 100) : 0;
      this.status.textContent = total > 0 ? `读取中 ${percent}%` : `已读取 ${compactBytes(loaded)}`;
    };

    const pdf = await loadingTask.promise;
    if (this.destroyed || this.loadingTask !== loadingTask) return;
    this.pdf = pdf;
    this.totalPages = pdf.numPages;
    this.currentPage = clamp(this.currentPage, 1, Math.max(1, this.totalPages));
    this.totalLabel.textContent = String(this.totalPages);
    this.pageInput.max = String(this.totalPages);
    this.pageInput.value = String(this.currentPage);
    this.meta.textContent = `${this.totalPages} 页${this.options.size ? ` · ${compactBytes(this.options.size)}` : ''}`;
    this.pages.innerHTML = '';

    const firstPage = await this.getPage(1);
    const firstViewport = firstPage.getViewport({ scale: 1 });
    for (let pageNumber = 1; pageNumber <= this.totalPages; pageNumber += 1) {
      this.createPageView(pageNumber, firstViewport.width, firstViewport.height);
      this.createThumbView(pageNumber);
    }

    this.setupObservers();
    this.updateZoomLabel();
    this.updatePageDimensions();
    this.root.classList.remove('is-loading');
    this.status.textContent = 'PDF.js · Range 流式读取';
    requestAnimationFrame(() => {
      this.goToPage(this.currentPage, false);
      this.renderNearViewport();
      this.renderNearThumbs();
    });
  }

  setupObservers() {
    this.pageObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) this.renderPage(Number(entry.target.dataset.page)).catch(() => undefined);
      }
    }, { root: this.stage, rootMargin: '900px 0px' });
    for (const view of this.pageViews.values()) this.pageObserver.observe(view.wrapper);

    this.thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) this.renderThumbnail(Number(entry.target.dataset.page)).catch(() => undefined);
      }
    }, { root: this.thumbs, rootMargin: '500px 0px' });
    for (const view of this.thumbViews.values()) this.thumbObserver.observe(view.button);
  }

  createPageView(pageNumber, width, height) {
    const wrapper = document.createElement('section');
    wrapper.className = 'pdf-page pdf-page-loading';
    wrapper.dataset.page = String(pageNumber);
    wrapper.innerHTML = `<div class="pdf-page-number">${pageNumber}</div><canvas aria-label="第 ${pageNumber} 页"></canvas><div class="pdf-page-spinner"></div>`;
    this.pages.append(wrapper);
    this.pageViews.set(pageNumber, {
      wrapper,
      canvas: wrapper.querySelector('canvas'),
      baseWidth: width,
      baseHeight: height,
      renderedScale: 0,
    });
  }

  createThumbView(pageNumber) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pdf-thumb';
    button.dataset.page = String(pageNumber);
    button.innerHTML = `<span class="pdf-thumb-canvas"><canvas></canvas></span><span class="pdf-thumb-label">${pageNumber}</span>`;
    button.addEventListener('click', () => this.goToPage(pageNumber));
    this.thumbs.append(button);
    this.thumbViews.set(pageNumber, { button, canvas: button.querySelector('canvas'), rendered: false });
  }

  async getPage(pageNumber) {
    if (!this.pageCache.has(pageNumber)) this.pageCache.set(pageNumber, this.pdf.getPage(pageNumber));
    return this.pageCache.get(pageNumber);
  }

  scaleFor(view) {
    if (this.zoomMode === 'manual') return this.manualScale;
    const available = Math.max(260, this.stage.clientWidth - 56);
    return clamp(available / view.baseWidth, 0.35, 2.6);
  }

  updatePageDimensions() {
    for (const view of this.pageViews.values()) {
      const scale = this.scaleFor(view);
      view.wrapper.style.width = `${Math.round(view.baseWidth * scale)}px`;
      view.wrapper.style.height = `${Math.round(view.baseHeight * scale)}px`;
    }
  }

  async renderPage(pageNumber, force = false) {
    const view = this.pageViews.get(pageNumber);
    if (!view || !this.pdf || this.destroyed) return;
    const page = await this.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    if (view.baseWidth !== base.width || view.baseHeight !== base.height) {
      view.baseWidth = base.width;
      view.baseHeight = base.height;
    }
    const scale = this.scaleFor(view);
    if (!force && Math.abs(view.renderedScale - scale) < 0.001 && view.canvas.width > 0) return;

    this.renderTasks.get(pageNumber)?.cancel?.();
    const viewport = page.getViewport({ scale });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    view.wrapper.style.width = `${Math.round(viewport.width)}px`;
    view.wrapper.style.height = `${Math.round(viewport.height)}px`;
    view.canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    view.canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    view.canvas.style.width = `${Math.round(viewport.width)}px`;
    view.canvas.style.height = `${Math.round(viewport.height)}px`;
    const context = view.canvas.getContext('2d', { alpha: false });
    const renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      background: '#ffffff',
    });
    this.renderTasks.set(pageNumber, renderTask);
    try {
      await renderTask.promise;
      view.renderedScale = scale;
      view.wrapper.classList.remove('pdf-page-loading');
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException') throw error;
    } finally {
      if (this.renderTasks.get(pageNumber) === renderTask) this.renderTasks.delete(pageNumber);
    }
  }

  async renderThumbnail(pageNumber) {
    const view = this.thumbViews.get(pageNumber);
    if (!view || view.rendered || !this.pdf || this.destroyed) return;
    const page = await this.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(0.22, 112 / base.width);
    const viewport = page.getViewport({ scale });
    const outputScale = Math.min(window.devicePixelRatio || 1, 1.5);
    view.canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    view.canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    view.canvas.style.width = `${Math.round(viewport.width)}px`;
    view.canvas.style.height = `${Math.round(viewport.height)}px`;
    const task = page.render({
      canvasContext: view.canvas.getContext('2d', { alpha: false }),
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      background: '#ffffff',
    });
    this.thumbRenderTasks.set(pageNumber, task);
    try {
      await task.promise;
      view.rendered = true;
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException') throw error;
    } finally {
      if (this.thumbRenderTasks.get(pageNumber) === task) this.thumbRenderTasks.delete(pageNumber);
    }
  }

  renderNearViewport(force = false) {
    const top = this.stage.scrollTop - 900;
    const bottom = this.stage.scrollTop + this.stage.clientHeight + 900;
    for (const [pageNumber, view] of this.pageViews) {
      const pageTop = view.wrapper.offsetTop;
      const pageBottom = pageTop + view.wrapper.offsetHeight;
      if (pageBottom >= top && pageTop <= bottom) this.renderPage(pageNumber, force).catch(() => undefined);
    }
  }

  renderNearThumbs() {
    const top = this.thumbs.scrollTop - 400;
    const bottom = this.thumbs.scrollTop + this.thumbs.clientHeight + 400;
    for (const [pageNumber, view] of this.thumbViews) {
      const y = view.button.offsetTop;
      if (y + view.button.offsetHeight >= top && y <= bottom) this.renderThumbnail(pageNumber).catch(() => undefined);
    }
  }

  syncCurrentPageFromScroll() {
    if (!this.pageViews.size) return;
    const target = this.stage.scrollTop + 28;
    let closest = this.currentPage;
    let distance = Number.POSITIVE_INFINITY;
    for (const [pageNumber, view] of this.pageViews) {
      const value = Math.abs(view.wrapper.offsetTop - target);
      if (value < distance) {
        distance = value;
        closest = pageNumber;
      }
    }
    this.setCurrentPage(closest);
  }

  setCurrentPage(pageNumber) {
    const next = clamp(Math.round(Number(pageNumber) || 1), 1, Math.max(1, this.totalPages || 1));
    if (this.currentPage === next && this.pageInput.value === String(next)) return;
    this.currentPage = next;
    this.pageInput.value = String(next);
    for (const [number, view] of this.thumbViews) view.button.classList.toggle('active', number === next);
    const thumb = this.thumbViews.get(next)?.button;
    if (thumb && !this.thumbs.matches(':hover')) thumb.scrollIntoView({ block: 'nearest' });
    this.saveState();
  }

  goToPage(pageNumber, smooth = true) {
    if (!this.totalPages) return;
    const next = clamp(Math.round(Number(pageNumber) || 1), 1, this.totalPages);
    const view = this.pageViews.get(next);
    if (!view) return;
    this.setCurrentPage(next);
    this.stage.scrollTo({ top: Math.max(0, view.wrapper.offsetTop - 18), behavior: smooth ? 'smooth' : 'auto' });
    this.renderPage(next).catch(() => undefined);
  }

  setZoom(mode, scale = this.manualScale) {
    this.zoomMode = mode;
    if (mode === 'manual') this.manualScale = clamp(Number(scale) || 1, 0.4, 4);
    this.saveState();
    this.updateZoomLabel();
    this.updatePageDimensions();
    this.renderNearViewport(true);
  }

  stepZoom(direction) {
    const current = this.zoomMode === 'manual'
      ? this.manualScale
      : this.scaleFor(this.pageViews.get(this.currentPage) || [...this.pageViews.values()][0]);
    this.setZoom('manual', current * (direction > 0 ? 1.15 : 1 / 1.15));
  }

  updateZoomLabel() {
    this.zoomLabel.textContent = this.zoomMode === 'fit-width'
      ? '适应宽度'
      : `${Math.round(this.manualScale * 100)}%`;
  }

  async textForPage(pageNumber) {
    if (!this.textCache.has(pageNumber)) {
      this.textCache.set(pageNumber, this.getPage(pageNumber).then(async (page) => {
        const content = await page.getTextContent();
        return normalizeSearch(content.items.map((item) => item.str || '').join(' '));
      }));
    }
    return this.textCache.get(pageNumber);
  }

  async search(rawQuery) {
    const query = normalizeSearch(rawQuery.trim());
    const generation = ++this.searchGeneration;
    this.searchResults = [];
    this.searchIndex = -1;
    if (!query || !this.pdf) {
      this.searchCount.textContent = '';
      return;
    }
    this.searchCount.textContent = '搜索中…';
    const results = [];
    for (let pageNumber = 1; pageNumber <= this.totalPages; pageNumber += 1) {
      if (generation !== this.searchGeneration) return;
      const text = await this.textForPage(pageNumber);
      const count = countOccurrences(text, query);
      for (let index = 0; index < count; index += 1) results.push({ pageNumber, index });
    }
    if (generation !== this.searchGeneration) return;
    this.searchResults = results;
    this.searchIndex = results.length ? 0 : -1;
    this.syncSearchUi();
    if (results.length) this.goToPage(results[0].pageNumber);
  }

  moveSearch(direction) {
    if (!this.searchResults.length) {
      if (this.searchInput.value.trim()) this.search(this.searchInput.value);
      return;
    }
    this.searchIndex = (this.searchIndex + direction + this.searchResults.length) % this.searchResults.length;
    this.syncSearchUi();
    this.goToPage(this.searchResults[this.searchIndex].pageNumber);
  }

  syncSearchUi() {
    if (!this.searchResults.length) {
      this.searchCount.textContent = this.searchInput.value.trim() ? '0 个结果' : '';
      return;
    }
    this.searchCount.textContent = `${this.searchIndex + 1}/${this.searchResults.length}`;
  }

  toggleFocus(button) {
    const layout = this.container.closest('.remote-files-layout');
    if (!layout) return;
    const focused = layout.classList.toggle('pdf-focus-mode');
    button.textContent = focused ? '返回双栏' : '展开阅读';
    setTimeout(() => {
      this.updatePageDimensions();
      this.renderNearViewport(true);
    }, 180);
  }

  openStandalone() {
    const params = new URLSearchParams({
      host: this.options.host,
      path: this.options.path,
      name: this.options.name || '',
      size: String(this.options.size || 0),
    });
    window.open(`/pdf-reader.html?${params.toString()}`, '_blank', 'noopener');
  }

  cancelRendering() {
    for (const task of this.renderTasks.values()) task.cancel?.();
    for (const task of this.thumbRenderTasks.values()) task.cancel?.();
    this.renderTasks.clear();
    this.thumbRenderTasks.clear();
  }

  showError(error) {
    if (this.destroyed) return;
    this.root?.classList.remove('is-loading');
    if (this.status) this.status.textContent = '打开失败';
    if (this.pages) {
      this.pages.innerHTML = `<div class="pdf-error"><span>!</span><strong>无法打开 PDF</strong><small>${esc(error?.message || error)}</small></div>`;
    }
  }

  async destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.scrollFrame);
    clearTimeout(this.resizeTimer);
    this.resizeObserver?.disconnect();
    this.pageObserver?.disconnect();
    this.thumbObserver?.disconnect();
    this.cancelRendering();
    await this.loadingTask?.destroy?.().catch(() => undefined);
    this.pdf = null;
  }
}

export function mountRemotePdfViewer(container, options) {
  return new RemotePdfViewer(container, options);
}
