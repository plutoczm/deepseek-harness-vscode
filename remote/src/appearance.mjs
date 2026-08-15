import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_WALLPAPER_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f3/Young_Mao_Zedong_statue%2C_2010110309.jpg/960px-Young_Mao_Zedong_statue%2C_2010110309.jpg';

const DEFAULTS = {
  enabled: true,
  imageUrl: DEFAULT_WALLPAPER_URL,
  opacity: 82,
  blur: 16,
};

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.toString() : DEFAULT_WALLPAPER_URL;
  } catch {
    return DEFAULT_WALLPAPER_URL;
  }
}

export class AppearanceStore extends EventEmitter {
  constructor(directory = process.env.DSH_REMOTE_SETTINGS_DIR || path.join(homedir(), '.deepseek-harness-remote')) {
    super();
    this.directory = directory;
    this.file = path.join(directory, 'appearance.json');
    this.settings = { ...DEFAULTS, updatedAt: new Date().toISOString() };
    this.imageCache = undefined;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this.settings;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.settings = this.normalize(parsed);
    } catch {
      this.settings = this.normalize(DEFAULTS);
    }
    return this.settings;
  }

  normalize(value = {}) {
    return {
      enabled: value.enabled !== false,
      imageUrl: safeHttpsUrl(value.imageUrl),
      opacity: clamp(value.opacity, 50, 100, DEFAULTS.opacity),
      blur: clamp(value.blur, 0, 32, DEFAULTS.blur),
      updatedAt: new Date().toISOString(),
    };
  }

  async get() {
    await this.load();
    return { ...this.settings };
  }

  async set(patch = {}) {
    await this.load();
    const next = this.normalize({ ...this.settings, ...patch });
    const imageChanged = next.imageUrl !== this.settings.imageUrl;
    this.settings = next;
    if (imageChanged) this.imageCache = undefined;
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.file, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8');
    this.emit('change', { ...this.settings });
    return { ...this.settings };
  }

  async reset() {
    this.imageCache = undefined;
    return this.set(DEFAULTS);
  }

  async wallpaperDataUrl() {
    const settings = await this.get();
    if (!settings.enabled) return undefined;
    if (this.imageCache?.url === settings.imageUrl) return this.imageCache.dataUrl;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      timer.unref?.();
      let response;
      try {
        response = await fetch(settings.imageUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) return undefined;
      const type = response.headers.get('content-type') || 'image/jpeg';
      if (!type.startsWith('image/')) return undefined;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 8 * 1024 * 1024) return undefined;
      const dataUrl = `data:${type};base64,${bytes.toString('base64')}`;
      this.imageCache = { url: settings.imageUrl, dataUrl };
      return dataUrl;
    } catch {
      return undefined;
    }
  }
}

export const appearanceStore = new AppearanceStore();
