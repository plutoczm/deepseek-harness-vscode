const pty = require('node-pty');

const command = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'echo ELECTRON_PTY_OK']
  : ['-lc', 'printf ELECTRON_PTY_OK'];

let output = '';
let finished = false;
const child = pty.spawn(command, args, {
  name: 'xterm-256color',
  cols: 80,
  rows: 20,
  cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')),
});

const timer = setTimeout(() => {
  if (finished) return;
  finished = true;
  try { child.kill(); } catch { /* ignore */ }
  console.error(`Electron PTY smoke timed out. electron=${process.versions.electron || 'unknown'} output=${JSON.stringify(output)}`);
  process.exit(1);
}, 8000);

timer.unref?.();

child.onData((chunk) => {
  output += chunk;
});

child.onExit(({ exitCode }) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (exitCode !== 0 || !output.includes('ELECTRON_PTY_OK')) {
    console.error(`Electron PTY smoke failed. electron=${process.versions.electron || 'unknown'} exit=${exitCode} output=${JSON.stringify(output)}`);
    process.exit(1);
  }
  console.log(`ELECTRON_PTY_OK electron=${process.versions.electron} node=${process.versions.node}`);
  process.exit(0);
});
