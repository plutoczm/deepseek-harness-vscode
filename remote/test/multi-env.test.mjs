import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { apply } from '../harness-plugin/index.js';

const execFileAsync = promisify(execFile);

async function commandPath(command) {
  const { stdout } = await execFileAsync('sh', ['-lc', `command -v ${command}`]);
  return stdout.trim();
}

async function writePythonShim(file, systemPython, modules, extraPythonPath = '') {
  const script = `#!/usr/bin/env bash\nif [ "\${1:-}" = "-c" ] && printf '%s' "\${2:-}" | grep -q 'packages_distributions'; then\n  printf '%s\\n' '${JSON.stringify(modules)}'\n  exit 0\nfi\n${extraPythonPath ? `export PYTHONPATH=${JSON.stringify(extraPythonPath)}:\"\${PYTHONPATH:-}\"\n` : ''}exec ${JSON.stringify(systemPython)} "$@"\n`;
  await writeFile(file, script, { encoding: 'utf8', mode: 0o755 });
  await chmod(file, 0o755);
}

test('configures a fixed environment whitelist and auto-routes a Python script', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dhr-multi-env-'));
  const sessionDir = path.join(root, 'sessions');
  const project = path.join(root, 'project');
  const systemPython = await commandPath('python3');
  const previousEnvDir = process.env.DEEPSEEK_HARNESS_SESSION_ENV_DIR;

  try {
    process.env.DEEPSEEK_HARNESS_SESSION_ENV_DIR = sessionDir;
    await mkdir(project, { recursive: true });

    const defaultBin = path.join(project, '.venv', 'bin');
    const routedBin = path.join(project, 'venv', 'bin');
    const routedLib = path.join(project, 'venv', 'lib');
    await mkdir(defaultBin, { recursive: true });
    await mkdir(routedBin, { recursive: true });
    await mkdir(routedLib, { recursive: true });
    await writePythonShim(path.join(defaultBin, 'python'), systemPython, ['shared_pkg']);
    await writePythonShim(path.join(routedBin, 'python'), systemPython, ['shared_pkg', 'unique_eval'], routedLib);
    await writeFile(path.join(routedLib, 'unique_eval.py'), 'VALUE = 1\n', 'utf8');

    const routedScript = path.join(project, 'evaluate_task.py');
    await writeFile(
      routedScript,
      'import os\nimport unique_eval\nprint(os.environ.get("DHR_SELECTED_ENV", ""))\n',
      'utf8',
    );

    let registered;
    let questionCall = 0;
    const ctx = {
      commands: {
        register(definition) {
          if (definition.name === 'env') registered = definition;
        },
      },
      userQuestions: {
        async ask() {
          questionCall += 1;
          if (questionCall === 1) {
            return { answers: [{ id: 'allowed-python-environments', selected: ['.venv', 'venv'] }] };
          }
          return { answers: [{ id: 'default-python-environment', selected: ['.venv'] }] };
        },
      },
      on() {},
    };

    apply(ctx);
    assert.ok(registered?.handler, 'the /env command should be registered');

    const agent = { session: { header: { id: 'session/test', cwd: project } } };
    const result = await registered.handler({ rawInput: '', agent, signal: new AbortController().signal });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /Default Python environment: \.venv/u);

    const safeId = 'session_test';
    const metadataPath = path.join(sessionDir, `${safeId}.json`);
    const routerPath = path.join(sessionDir, `${safeId}.router.mjs`);
    const activationPath = path.join(sessionDir, `${safeId}.sh`);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));

    assert.equal(metadata.version, 2);
    assert.equal(metadata.defaultName, '.venv');
    assert.deepEqual(metadata.allowed.map((item) => item.name), ['.venv', 'venv']);
    assert.equal(metadata.autoRouting, true);
    assert.ok(metadata.allowed.find((item) => item.name === 'venv').modules.includes('unique_eval'));
    assert.ok(!metadata.allowed.find((item) => item.name === '.venv').modules.includes('unique_eval'));

    await execFileAsync(process.execPath, ['--check', routerPath]);
    const activation = await readFile(activationPath, 'utf8');
    assert.match(activation, /dhr-run/u);
    assert.match(activation, /dhr-auto/u);

    const { stdout, stderr } = await execFileAsync(process.execPath, [routerPath, 'python', routedScript], {
      cwd: project,
      env: {
        ...process.env,
        DEEPSEEK_HARNESS_BASE_PATH: process.env.PATH || '',
      },
    });
    assert.equal(stdout.trim(), 'venv');
    assert.match(stderr, /\[env:auto\] venv/u);

    const routes = JSON.parse(await readFile(path.join(sessionDir, `${safeId}.routes.json`), 'utf8'));
    assert.equal(routes[routedScript], 'venv');

    await chmod(activationPath, 0o600);
  } finally {
    if (previousEnvDir === undefined) delete process.env.DEEPSEEK_HARNESS_SESSION_ENV_DIR;
    else process.env.DEEPSEEK_HARNESS_SESSION_ENV_DIR = previousEnvDir;
    await rm(root, { recursive: true, force: true });
  }
});
