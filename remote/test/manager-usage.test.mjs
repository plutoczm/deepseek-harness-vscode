import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessManager } from '../src/manager.mjs';

function usageMarker(payload) {
  return `__DHR_USAGE__${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function balanceMarker(payload) {
  return `__DHR_BALANCE__${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

test('consumes usage markers without exposing them as launcher logs', () => {
  const manager = new HarnessManager('/tmp/plugin');
  const instance = {
    id: 'instance-1',
    logs: '',
    stdoutBuffer: '',
    usageSessions: new Map(),
  };
  manager.instances.set(instance.id, instance);

  const events = [];
  const dispose = manager.onUsage(instance.id, (snapshot) => events.push(snapshot));
  const marker = usageMarker({
    sessionId: 'session-1',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    usage: {
      inputTokens: 900,
      cacheReadTokens: 100,
      outputTokens: 50,
    },
    at: '2026-08-14T13:00:00.000Z',
  });

  manager.handleHarnessStdout(instance, `[remote] ready\n${marker}\nnext line\n`);
  dispose();

  assert.equal(events.length, 1);
  assert.equal(events[0].available, true);
  assert.equal(events[0].session.sessionId, 'session-1');
  assert.equal(events[0].session.inputTokens, 1_000);
  assert.equal(events[0].session.outputTokens, 50);
  assert.equal(events[0].session.cacheHitPercent, 10);
  assert.match(instance.logs, /\[remote\] ready/);
  assert.match(instance.logs, /next line/);
  assert.doesNotMatch(instance.logs, /__DHR_USAGE__/);
});

test('buffers partial stdout markers across SSH chunks', () => {
  const manager = new HarnessManager('/tmp/plugin');
  const instance = {
    id: 'instance-2',
    logs: '',
    stdoutBuffer: '',
    usageSessions: new Map(),
  };
  manager.instances.set(instance.id, instance);

  const marker = usageMarker({
    sessionId: 'session-2',
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    usage: { inputTokens: 100, outputTokens: 20 },
  });
  const split = Math.floor(marker.length / 2);
  manager.handleHarnessStdout(instance, marker.slice(0, split));
  assert.equal(manager.usage(instance.id).available, false);
  manager.handleHarnessStdout(instance, `${marker.slice(split)}\n`);
  assert.equal(manager.usage(instance.id).available, true);
  assert.equal(manager.usage(instance.id).session.requests, 1);
});

test('consumes balance markers and keeps balance telemetry out of launcher logs', () => {
  const manager = new HarnessManager('/tmp/plugin');
  const instance = {
    id: 'instance-3',
    status: 'running',
    logs: '',
    stdoutBuffer: '',
    usageSessions: new Map(),
  };
  manager.instances.set(instance.id, instance);

  const events = [];
  const dispose = manager.onBalance(instance.id, (snapshot) => events.push(snapshot));
  const marker = balanceMarker({
    version: 1,
    ok: true,
    available: true,
    currency: 'CNY',
    total: 42.1837,
    granted: 2.1837,
    toppedUp: 40,
    fetchedAt: '2026-08-15T03:43:00.000Z',
  });

  manager.handleHarnessStdout(instance, `[remote] balance-ready\n${marker}\n`);
  dispose();

  assert.equal(events.length, 1);
  assert.equal(events[0].received, true);
  assert.equal(events[0].active, true);
  assert.equal(events[0].ok, true);
  assert.equal(events[0].available, true);
  assert.equal(events[0].currency, 'CNY');
  assert.equal(events[0].total, 42.1837);
  assert.equal(events[0].granted, 2.1837);
  assert.equal(events[0].toppedUp, 40);
  assert.equal(events[0].fetchedAt, '2026-08-15T03:43:00.000Z');
  assert.match(instance.logs, /balance-ready/);
  assert.doesNotMatch(instance.logs, /__DHR_BALANCE__/);
});

test('preserves missing balance amounts as null instead of displaying a fake zero', () => {
  const manager = new HarnessManager('/tmp/plugin');
  const instance = {
    id: 'instance-4',
    status: 'running',
    logs: '',
    stdoutBuffer: '',
    usageSessions: new Map(),
  };
  manager.instances.set(instance.id, instance);

  manager.handleHarnessStdout(instance, `${balanceMarker({
    version: 1,
    ok: false,
    available: false,
    error: '未找到 DEEPSEEK_API_KEY',
    fetchedAt: '2026-08-15T03:43:00.000Z',
  })}\n`);

  const snapshot = manager.balance(instance.id);
  assert.equal(snapshot.received, true);
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.total, null);
  assert.equal(snapshot.granted, null);
  assert.equal(snapshot.toppedUp, null);
});
