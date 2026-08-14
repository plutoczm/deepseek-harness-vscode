import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const name = 'vscode-session-env';
export const inject = ['commands', 'userQuestions', 'tools'];

const ENV_DIR_VARIABLE = 'DEEPSEEK_HARNESS_SESSION_ENV_DIR';
const DEFAULT_LABEL = 'Harness default';
const PROJECT_ENV_NAMES = ['.venv', 'venv', 'env'];
const MAX_CONDA_ENVS = 64;

function sessionId(agent) {
  return String(agent.session.header.id);
}

function safeSessionId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/gu, '_');
}

function environmentDirectory() {
  const value = process.env[ENV_DIR_VARIABLE]?.trim();
  return value || undefined;
}

function sessionPaths(id) {
  const directory = environmentDirectory();
  if (!directory) return undefined;
  const safe = safeSessionId(id);
  return {
    directory,
    activation: join(directory, `${safe}.sh`),
    metadata: join(directory, `${safe}.json`),
  };
}

async function pathExists(path, executable = false) {
  try {
    await access(path, executable ? fsConstants.X_OK : fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function run(file, args, cwd, timeoutMs = 5000) {
  return new Promise((resolveResult) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolveResult(undefined);
          return;
        }
        resolveResult(String(stdout).trim());
      },
    );
  });
}

async function firstPython(root) {
  for (const candidate of [join(root, 'bin', 'python'), join(root, 'bin', 'python3')]) {
    if (await pathExists(candidate, true)) return candidate;
  }
  return undefined;
}

async function systemPython(cwd) {
  return run('sh', ['-lc', 'command -v python3 || command -v python || true'], cwd, 3000);
}

async function condaInfo(cwd) {
  const raw = await run('conda', ['env', 'list', '--json'], cwd);
  if (!raw) return { base: undefined, roots: [] };

  let roots = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.envs)) {
      roots = parsed.envs.filter((value) => typeof value === 'string').slice(0, MAX_CONDA_ENVS);
    }
  } catch {
    return { base: undefined, roots: [] };
  }

  const base = await run('conda', ['info', '--base'], cwd, 3000);
  return { base: base || undefined, roots };
}

function makeSystemEnvironment(python) {
  return {
    id: 'system',
    kind: 'system',
    label: DEFAULT_LABEL,
    description: python
      ? `Use the environment inherited by Harness · ${python}`
      : 'Use the environment inherited by the Harness process',
    python: python || undefined,
  };
}

function uniqueEnvironments(environments) {
  const seenRoots = new Set();
  const labels = new Map();
  const result = [];

  for (const environment of environments) {
    const rootKey = environment.root ? resolve(environment.root) : `kind:${environment.kind}`;
    if (seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);

    const count = (labels.get(environment.label) ?? 0) + 1;
    labels.set(environment.label, count);
    result.push(count === 1 ? environment : {
      ...environment,
      label: `${environment.label} · ${environment.root ?? count}`,
    });
  }
  return result;
}

async function detectEnvironments(agent) {
  const cwd = agent.session.header.cwd || process.cwd();
  const [python, conda] = await Promise.all([systemPython(cwd), condaInfo(cwd)]);
  const environments = [makeSystemEnvironment(python)];

  for (const name of PROJECT_ENV_NAMES) {
    const root = join(cwd, name);
    if (!(await isDirectory(root))) continue;

    const envPython = await firstPython(root);
    if (!envPython) continue;

    const isConda = await isDirectory(join(root, 'conda-meta'));
    environments.push({
      id: `project:${name}`,
      kind: isConda ? 'conda' : 'venv',
      label: name,
      description: `${isConda ? 'Conda' : 'Virtual'} environment in this workspace · ${envPython}`,
      root,
      python: envPython,
      condaBase: isConda ? conda.base : undefined,
    });
  }

  for (const root of conda.roots) {
    if (!(await isDirectory(root))) continue;
    const envPython = await firstPython(root);
    const shortName = conda.base && resolve(root) === resolve(conda.base) ? 'base' : basename(root);
    environments.push({
      id: `conda:${root}`,
      kind: 'conda',
      label: `conda: ${shortName}`,
      description: envPython ? `${root} · ${envPython}` : root,
      root,
      python: envPython,
      condaBase: conda.base,
    });
  }

  return uniqueEnvironments(environments);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function activationScript(environment) {
  const label = shellQuote(environment.label);
  if (environment.kind === 'venv') {
    const root = shellQuote(environment.root);
    const bin = shellQuote(join(environment.root, 'bin'));
    return [
      '# Generated by DeepSeek Harness for VS Code. Do not edit.',
      'unset CONDA_PREFIX CONDA_DEFAULT_ENV CONDA_PROMPT_MODIFIER CONDA_SHLVL',
      'unset PYTHONHOME',
      `export VIRTUAL_ENV=${root}`,
      `export PATH=${bin}:"\${DEEPSEEK_HARNESS_BASE_PATH:-$PATH}"`,
      `export DEEPSEEK_HARNESS_ENV_NAME=${label}`,
      '',
    ].join('\n');
  }

  if (environment.kind === 'conda') {
    const root = shellQuote(environment.root);
    const bin = shellQuote(join(environment.root, 'bin'));
    const shortName = shellQuote(basename(environment.root));
    const condaScript = environment.condaBase
      ? join(environment.condaBase, 'etc', 'profile.d', 'conda.sh')
      : undefined;
    const lines = [
      '# Generated by DeepSeek Harness for VS Code. Do not edit.',
      'unset VIRTUAL_ENV PYTHONHOME',
      'export PATH="${DEEPSEEK_HARNESS_BASE_PATH:-$PATH}"',
    ];

    if (condaScript) {
      const quotedCondaScript = shellQuote(condaScript);
      lines.push(
        `if [ -r ${quotedCondaScript} ]; then`,
        `  . ${quotedCondaScript}`,
        `  conda activate ${root} >/dev/null 2>&1 || true`,
        'fi',
      );
    }

    lines.push(
      `export CONDA_PREFIX=${root}`,
      `export CONDA_DEFAULT_ENV=${shortName}`,
      `export PATH=${bin}:"\${PATH}"`,
      `export DEEPSEEK_HARNESS_ENV_NAME=${label}`,
      '',
    );
    return lines.join('\n');
  }

  return undefined;
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function readSelection(agent) {
  const paths = sessionPaths(sessionId(agent));
  if (!paths) return undefined;
  try {
    return JSON.parse(await readFile(paths.metadata, 'utf8'));
  } catch {
    return undefined;
  }
}

async function saveSelection(agent, environment, extra = {}) {
  const id = sessionId(agent);
  const paths = sessionPaths(id);
  if (!paths) {
    throw new Error(`${ENV_DIR_VARIABLE} is not configured; restart Harness from the VS Code extension.`);
  }

  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const script = activationScript(environment);
  if (script) {
    await atomicWrite(paths.activation, script);
  } else {
    await rm(paths.activation, { force: true });
  }

  const metadata = {
    version: 1,
    sessionId: id,
    kind: environment.kind,
    label: environment.label,
    root: environment.root ?? null,
    python: environment.python ?? null,
    selectedAt: new Date().toISOString(),
    cwd: agent.session.header.cwd ?? null,
    ...extra,
  };
  await atomicWrite(paths.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

async function inheritForSubagent(agent) {
  const header = agent.session.header;
  if (header.origin !== 'subagent' || !header.parentSession) return false;

  const childPaths = sessionPaths(sessionId(agent));
  const parentPaths = sessionPaths(String(header.parentSession));
  if (!childPaths || !parentPaths) return false;
  if (await pathExists(childPaths.metadata)) return true;

  await mkdir(childPaths.directory, { recursive: true, mode: 0o700 });
  try {
    const parentMetadata = JSON.parse(await readFile(parentPaths.metadata, 'utf8'));
    if (await pathExists(parentPaths.activation)) {
      await atomicWrite(childPaths.activation, await readFile(parentPaths.activation, 'utf8'));
    } else {
      await rm(childPaths.activation, { force: true });
    }
    await atomicWrite(childPaths.metadata, `${JSON.stringify({
      ...parentMetadata,
      sessionId: sessionId(agent),
      cwd: header.cwd ?? null,
      selectedAt: new Date().toISOString(),
      inheritedFrom: String(header.parentSession),
    }, null, 2)}\n`);
    return true;
  } catch {
    await saveSelection(agent, makeSystemEnvironment(undefined), {
      inheritedFrom: String(header.parentSession),
    });
    return true;
  }
}

async function chooseEnvironment(ctx, agent, signal) {
  const environments = await detectEnvironments(agent);
  if (environments.length === 1) {
    await saveSelection(agent, environments[0]);
    return environments[0];
  }

  const current = await readSelection(agent);
  const answer = await ctx.userQuestions.ask({
    agent,
    signal,
    questions: [{
      id: 'python-environment',
      header: 'Python Environment',
      question: 'Choose the Python/Conda environment for this Harness session.',
      detail: current?.label ? `Current environment: ${current.label}` : 'This selection affects this session only.',
      options: environments.map((environment) => ({
        label: environment.label,
        description: environment.description,
      })),
    }],
  });

  const selectedLabel = answer.answers?.find((item) => item.id === 'python-environment')?.selected?.[0];
  if (!selectedLabel) throw new Error('Environment selection was cancelled.');
  const selected = environments.find((environment) => environment.label === selectedLabel);
  if (!selected) throw new Error('The selected environment is no longer available.');
  await saveSelection(agent, selected);
  return selected;
}

async function manualEnvironment(input, agent) {
  const cwd = agent.session.header.cwd || process.cwd();
  let candidate = isAbsolute(input) ? input : resolve(cwd, input);
  if (await pathExists(candidate, true) && basename(candidate).startsWith('python')) {
    candidate = dirname(dirname(candidate));
  }
  if (!(await isDirectory(candidate))) return undefined;

  const python = await firstPython(candidate);
  if (!python) return undefined;
  const conda = await isDirectory(join(candidate, 'conda-meta'));
  const condaBase = conda ? (await condaInfo(cwd)).base : undefined;
  return {
    id: `manual:${candidate}`,
    kind: conda ? 'conda' : 'venv',
    label: basename(candidate) || candidate,
    description: `${conda ? 'Conda' : 'Virtual'} environment · ${python}`,
    root: candidate,
    python,
    condaBase,
  };
}

function selectionText(metadata) {
  const lines = [`Python environment for this session: ${metadata.label}`];
  if (metadata.python) lines.push(`Python: ${metadata.python}`);
  if (metadata.root) lines.push(`Environment root: ${metadata.root}`);
  lines.push('Future Harness Bash calls in this session will use this environment.');
  return lines.join('\n');
}

async function runEnvCommand(ctx, invocation) {
  const input = invocation.rawInput.trim();
  if (!environmentDirectory()) {
    return {
      kind: 'error',
      text: 'Per-session environments are unavailable in this Harness process. Restart Harness using the VS Code extension.',
    };
  }

  if (input === '' || input.toLowerCase() === 'select') {
    try {
      const selected = await chooseEnvironment(ctx, invocation.agent, invocation.signal);
      return { kind: 'success', text: selectionText(await readSelection(invocation.agent) ?? selected) };
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : 'Environment selection failed.' };
    }
  }

  const command = input.toLowerCase();
  if (command === 'status') {
    const current = await readSelection(invocation.agent);
    return {
      kind: 'success',
      text: current ? selectionText(current) : 'No environment has been selected for this session yet. Run /env to choose one.',
    };
  }

  if (command === 'system' || command === 'default' || command === 'off') {
    const cwd = invocation.agent.session.header.cwd || process.cwd();
    const selected = makeSystemEnvironment(await systemPython(cwd));
    return { kind: 'success', text: selectionText(await saveSelection(invocation.agent, selected)) };
  }

  const environments = await detectEnvironments(invocation.agent);
  const matched = environments.find((environment) =>
    environment.id.toLowerCase() === command
    || environment.label.toLowerCase() === command
    || environment.root?.toLowerCase() === input.toLowerCase(),
  );
  const selected = matched ?? await manualEnvironment(input, invocation.agent);
  if (!selected) {
    return {
      kind: 'error',
      text: `Environment not found: ${input}\nRun /env to choose from detected environments, or provide a virtual-environment directory/path.`,
    };
  }

  return { kind: 'success', text: selectionText(await saveSelection(invocation.agent, selected)) };
}

export function apply(ctx) {
  ctx.commands.register({
    name: 'env',
    description: 'select the Python environment for this session',
    input: { hint: '[status|system|<name-or-path>]' },
    handler: (invocation) => runEnvCommand(ctx, invocation),
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'bash' || !exec.agent || !environmentDirectory()) return next();
    if (await readSelection(exec.agent)) return next();
    if (await inheritForSubagent(exec.agent)) return next();

    try {
      await chooseEnvironment(ctx, exec.agent, exec.signal);
      return next();
    } catch {
      return {
        kind: 'deny',
        reason: 'Choose a Python environment for this session with /env before running Bash.',
      };
    }
  });
}
