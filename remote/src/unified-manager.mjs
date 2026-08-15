import { EventEmitter } from 'node:events';

export class UnifiedHarnessManager extends EventEmitter {
  constructor(remoteManager, localManager) {
    super();
    this.remoteManager = remoteManager;
    this.localManager = localManager;
    for (const source of [remoteManager, localManager]) {
      for (const event of ['instance-status', 'usage', 'balance']) {
        source.on(event, (payload) => this.emit(event, payload));
      }
    }
  }

  owner(id) {
    if (this.localManager.instances.has(id)) return this.localManager;
    if (this.remoteManager.instances.has(id)) return this.remoteManager;
    return undefined;
  }

  decorate(instance, mode) {
    return instance ? { ...instance, mode: instance.mode || mode } : instance;
  }

  list() {
    return [
      ...this.localManager.list().map((item) => this.decorate(item, 'local')),
      ...this.remoteManager.list().map((item) => this.decorate(item, 'ssh')),
    ].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  get(id) {
    const owner = this.owner(id);
    if (!owner) return undefined;
    return this.decorate(owner.get(id), owner === this.localManager ? 'local' : 'ssh');
  }

  logs(id) { return this.owner(id)?.logs(id) ?? ''; }
  usage(id) { return this.owner(id)?.usage(id); }
  balance(id) { return this.owner(id)?.balance(id); }

  onInstanceStatus(id, listener) {
    const handler = (event) => {
      if (!id || event.instanceId === id) listener(this.get(event.instanceId) || event.instance);
    };
    this.on('instance-status', handler);
    return () => this.off('instance-status', handler);
  }

  onUsage(id, listener) {
    const handler = (event) => { if (event.instanceId === id) listener(event.snapshot); };
    this.on('usage', handler);
    return () => this.off('usage', handler);
  }

  onBalance(id, listener) {
    const handler = (event) => { if (event.instanceId === id) listener(event.snapshot); };
    this.on('balance', handler);
    return () => this.off('balance', handler);
  }

  async launch(options = {}) {
    return options.mode === 'local'
      ? this.localManager.launch(options)
      : this.remoteManager.launch(options);
  }

  async stop(id) {
    const owner = this.owner(id);
    return owner ? owner.stop(id) : false;
  }

  async stopAll() {
    await Promise.all([
      this.remoteManager.stopAll(),
      this.localManager.stopAll(),
    ]);
  }
}
