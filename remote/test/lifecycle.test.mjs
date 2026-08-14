import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProcessExitCode, sshExitMessage } from '../src/manager.mjs';

test('normalizes Windows unsigned -1 SSH exit code', () => {
  assert.equal(normalizeProcessExitCode(4294967295), -1);
  assert.equal(normalizeProcessExitCode(255), 255);
  assert.equal(normalizeProcessExitCode(0), 0);
  assert.equal(normalizeProcessExitCode(null), null);
});

test('describes lost SSH connections as Harness lifecycle termination', () => {
  assert.match(sshExitMessage(255), /SSH connection lost/u);
  assert.match(sshExitMessage(255), /Harness was stopped/u);
  assert.match(sshExitMessage(4294967295), /Windows exit -1/u);
  assert.equal(sshExitMessage(0), 'SSH/Harness session ended.');
});
