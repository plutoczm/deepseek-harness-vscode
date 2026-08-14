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

export const name = 'remote-session-env';
export const inject = ['commands', 'userQuestions', 'tools'];

const ENV_DIR_VARIABLE = 'DEEPSEEK_HARNESS_SESSION_ENV_DIR';
const DEFAULT_LABEL = 'Harness default';
const PROJECT_ENV_NAMES = ['.venv', 'venv', 'env'];
const MAX_CONDA_ENVS = 64;
const MAX_MODULES = 1024;

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
    router: join(directory, `${safe}.router.mjs`),
    routes: join(directory, `${safe}.routes.json`),
    notice: join(directory, `${safe}.notice`),
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
        maxBuffer: 4 * 1024 * 1024,
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

function inferPurpose(name) {
  const lower = String(name).toLowerCase();
  const purposes = [];
  if (/insight|arcface|recognition|faceid|embedding/u.test(lower)) purposes.push('face recognition / embedding / InsightFace-style tasks');
  if (/eval|benchmark|metric|test/u.test(lower)) purposes.push('evaluation / benchmark / metrics');
  if (/render|3d|pytorch3d|mesh|geometry/u.test(lower)) purposes.push('3D / rendering / geometry');
  if (/train|torch|cuda|main|privacy/u.test(lower)) purposes.push('main project / training / general Python work');
  if (/data|preprocess|dataset/u.test(lower)) purposes.push('dataset / preprocessing');
  return purposes.length ? purposes.join('; ') : `environment named ${name}`;
}

function makeSystemEnvironment(python) {
  return {
    id: 'system',
    kind: 'system',
    name: 'system',
    label: DEFAULT_LABEL,
    description: python
      ? `Inherited Harness environment · ${python}`
      : 'Inherited Harness process environment',
    purpose: 'system/default shell tools',
    python: python || undefined,
    modules: [],
  };
}

function uniqueEnvironments(environments) {
  const seenRoots = new Set();
  const names = new Map();
  const result = [];

  for (const environment of environments) {
    const rootKey = environment.root ? resolve(environment.root) : `kind:${environment.kind}`;
    if (seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);

    const baseName = environment.name || environment.label;
    const count = (names.get(baseName) ?? 0) + 1;
    names.set(baseName, count);
    result.push(count === 1 ? environment : {
      ...environment,
      name: `${baseName}-${count}`,
      label: `${environment.label} · ${environment.root ?? count}`,
    });
  }
  return result;
}

async function environmentModules(environment, cwd) {
  if (!environment.python || environment.kind === 'system') return [];
  const source = [
    'import importlib.metadata as m, json',
    `names = sorted(str(x) for x in m.packages_distributions().keys() if isinstance(x, str))[:${MAX_MODULES}]`,
    'print(json.dumps(names))',
  ].join('; ');
  const raw = await run(environment.python, ['-c', source], cwd, 8000);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string').slice(0, MAX_MODULES) : [];
  } catch {
    return [];
  }
}

async function detectEnvironments(agent, { includeModules = false } = {}) {
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
      name,
      label: name,
      description: `${isConda ? 'Conda' : 'Virtual'} environment in this workspace · ${envPython}`,
      purpose: inferPurpose(name),
      root,
      python: envPython,
      condaBase: isConda ? conda.base : undefined,
      modules: [],
    });
  }

  for (const root of conda.roots) {
    if (!(await isDirectory(root))) continue;
    const envPython = await firstPython(root);
    if (!envPython) continue;
    const shortName = conda.base && resolve(root) === resolve(conda.base) ? 'base' : basename(root);
    environments.push({
      id: `conda:${root}`,
      kind: 'conda',
      name: shortName,
      label: shortName,
      description: `Conda · ${root} · ${envPython}`,
      purpose: inferPurpose(shortName),
      root,
      python: envPython,
      condaBase: conda.base,
      modules: [],
    });
  }

  const unique = uniqueEnvironments(environments);
  if (!includeModules) return unique;
  return Promise.all(unique.map(async (environment) => ({
    ...environment,
    modules: await environmentModules(environment, cwd),
  })));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function environmentActivationLines(environment) {
  if (environment.kind === 'system') {
    return [
      'unset VIRTUAL_ENV CONDA_PREFIX CONDA_DEFAULT_ENV CONDA_PROMPT_MODIFIER CONDA_SHLVL PYTHONHOME',
      'export PATH="${DEEPSEEK_HARNESS_BASE_PATH:-$PATH}"',
      `export DEEPSEEK_HARNESS_ENV_NAME=${shellQuote(environment.name)}`,
    ];
  }

  const root = shellQuote(environment.root);
  const bin = shellQuote(join(environment.root, 'bin'));
  if (environment.kind === 'venv') {
    return [
      'unset CONDA_PREFIX CONDA_DEFAULT_ENV CONDA_PROMPT_MODIFIER CONDA_SHLVL PYTHONHOME',
      `export VIRTUAL_ENV=${root}`,
      `export PATH=${bin}:"\${DEEPSEEK_HARNESS_BASE_PATH:-$PATH}"`,
      `export DEEPSEEK_HARNESS_ENV_NAME=${shellQuote(environment.name)}`,
    ];
  }

  const shortName = shellQuote(environment.name || basename(environment.root));
  const condaScript = environment.condaBase
    ? join(environment.condaBase, 'etc', 'profile.d', 'conda.sh')
    : undefined;
  const lines = [
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
    `export DEEPSEEK_HARNESS_ENV_NAME=${shellQuote(environment.name)}`,
  );
  return lines;
}

function dhrRunCase(environment) {
  const name = shellQuote(environment.name);
  if (environment.kind === 'system') {
    return `    ${name}) ( unset VIRTUAL_ENV CONDA_PREFIX CONDA_DEFAULT_ENV CONDA_PROMPT_MODIFIER CONDA_SHLVL PYTHONHOME; export PATH="\${DEEPSEEK_HARNESS_BASE_PATH:-$PATH}"; "$@" ) ;;`;
  }
  const root = shellQuote(environment.root);
  const bin = shellQuote(join(environment.root, 'bin'));
  if (environment.kind === 'conda') {
    return `    ${name}) if command -v conda >/dev/null 2>&1; then conda run -p ${root} --no-capture-output "$@"; else ( unset VIRTUAL_ENV PYTHONHOME; export CONDA_PREFIX=${root}; export CONDA_DEFAULT_ENV=${name}; export PATH=${bin}:"\${DEEPSEEK_HARNESS_BASE_PATH:-$PATH}"; "$@" ); fi ;;`;
  }
  return `    ${name}) ( unset CONDA_PREFIX CONDA_DEFAULT_ENV CONDA_PROMPT_MODIFIER CONDA_SHLVL PYTHONHOME; export VIRTUAL_ENV=${root}; export PATH=${bin}:"\${DEEPSEEK_HARNESS_BASE_PATH:-$PATH}"; "$@" ) ;;`;
}

function activationScript(config, paths) {
  const defaultEnvironment = config.allowed.find((environment) => environment.name === config.defaultName) ?? config.allowed[0];
  const allowedNames = config.allowed.map((environment) => environment.name).join(', ');
  return [
    '# Generated by DeepSeek Harness Remote. Do not edit.',
    ...environmentActivationLines(defaultEnvironment),
    `export DHR_ENV_CONFIG=${shellQuote(paths.metadata)}`,
    `export DHR_ENV_ROUTER=${shellQuote(paths.router)}`,
    `export DHR_DEFAULT_ENV=${shellQuote(defaultEnvironment.name)}`,
    `export DHR_ALLOWED_ENVS=${shellQuote(allowedNames)}`,
    '',
    'dhr-env-list() {',
    `  printf '%s\\n' ${shellQuote(`Default: ${defaultEnvironment.name}`)} ${shellQuote(`Allowed: ${allowedNames}`)}`,
    '}',
    'dhr-run() {',
    '  _dhr_name="${1:-}"',
    '  [ -n "$_dhr_name" ] || { printf "usage: dhr-run <environment> -- <command> [args...]\\n" >&2; return 2; }',
    '  shift',
    '  [ "${1:-}" = "--" ] && shift',
    '  [ "$#" -gt 0 ] || { printf "dhr-run: command required\\n" >&2; return 2; }',
    '  case "$_dhr_name" in',
    ...config.allowed.map(dhrRunCase),
    '    *) printf "dhr-run: environment %s is not allowed in this Harness session.\\n" "$_dhr_name" >&2; return 64 ;;',
    '  esac',
    '}',
    'dhr-auto() { command node "$DHR_ENV_ROUTER" "$@"; }',
    'python() { dhr-auto python "$@"; }',
    'python3() { dhr-auto python3 "$@"; }',
    'pytest() { dhr-auto pytest "$@"; }',
    'pip() { dhr-auto pip "$@"; }',
    'pip3() { dhr-auto pip3 "$@"; }',
    'torchrun() { dhr-auto torchrun "$@"; }',
    'accelerate() { dhr-auto accelerate "$@"; }',
    'export -f dhr-env-list dhr-run dhr-auto python python3 pytest pip pip3 torchrun accelerate',
    '',
    `if ( set -o noclobber; : > ${shellQuote(paths.notice)} ) 2>/dev/null; then`,
    `  printf '[env] Allowed Python environments: %s. Default: %s. Python commands are auto-routed inside this whitelist; use dhr-run <name> -- <command> to override.\\n' ${shellQuote(allowedNames)} ${shellQuote(defaultEnvironment.name)} >&2`,
    'fi',
    '',
  ].join('\n');
}

function routerSource(paths) {
  return `import { existsSync, readFileSync, writeFileSync } from 'node:fs';\nimport { dirname, isAbsolute, resolve, join } from 'node:path';\nimport { spawnSync } from 'node:child_process';\n\nconst metadataPath = ${JSON.stringify(paths.metadata)};\nconst routesPath = ${JSON.stringify(paths.routes)};\nconst config = JSON.parse(readFileSync(metadataPath, 'utf8'));\nconst allowed = Array.isArray(config.allowed) ? config.allowed : [];\nconst defaultEnv = allowed.find((item) => item.name === config.defaultName) || allowed[0];\nconst [tool, ...args] = process.argv.slice(2);\nif (!tool || !defaultEnv) process.exit(2);\n\nfunction lower(value) { return String(value || '').toLowerCase(); }\nfunction tokens(value) { return lower(value).split(/[^a-z0-9]+/u).filter((item) => item.length >= 3 && !['env','conda','python','main','base'].includes(item)); }\nfunction readRoutes() { try { return JSON.parse(readFileSync(routesPath, 'utf8')); } catch { return {}; } }\nfunction targetInfo() {\n  if ((tool === 'python' || tool === 'python3') && args[0] === '-m' && args[1]) return { key: 'module:' + args[1], text: args[1], path: null };\n  let candidate = '';\n  if (tool === 'python' || tool === 'python3') candidate = args.find((item) => item && !item.startsWith('-')) || '';\n  else if (tool === 'pytest') candidate = args.find((item) => item && !item.startsWith('-')) || '';\n  if (!candidate) return { key: 'tool:' + tool, text: tool + ' ' + args.join(' '), path: null };\n  const absolute = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);\n  return { key: absolute, text: absolute + ' ' + args.join(' '), path: existsSync(absolute) ? absolute : null };\n}\nfunction importsFrom(path) {\n  if (!path) return [];\n  try {\n    const source = readFileSync(path, 'utf8').slice(0, 512 * 1024);\n    const found = new Set();\n    const pattern = /^\\s*(?:from|import)\\s+([A-Za-z_][A-Za-z0-9_.]*)/gmu;\n    for (const match of source.matchAll(pattern)) found.add(match[1].split('.')[0].toLowerCase());\n    return [...found];\n  } catch { return []; }\n}\nfunction choose() {\n  const explicit = process.env.DHR_ENV;\n  if (explicit) {\n    const matched = allowed.find((item) => item.name === explicit);\n    if (matched) return { environment: matched, reason: 'explicit' };\n  }\n  const target = targetInfo();\n  const learned = readRoutes()[target.key];\n  if (learned) {\n    const matched = allowed.find((item) => item.name === learned);\n    if (matched) return { environment: matched, reason: 'learned', target };\n  }\n  const imports = importsFrom(target.path);\n  const moduleOwners = new Map();\n  for (const environment of allowed) for (const module of environment.modules || []) {\n    const key = lower(module);\n    if (!moduleOwners.has(key)) moduleOwners.set(key, []);\n    moduleOwners.get(key).push(environment.name);\n  }\n  const scores = new Map(allowed.map((item) => [item.name, 0]));\n  for (const environment of allowed) {\n    const nameTokens = tokens(environment.name);\n    const purposeTokens = tokens(environment.purpose);\n    for (const token of nameTokens) if (lower(target.text).includes(token)) scores.set(environment.name, scores.get(environment.name) + 8);\n    for (const token of purposeTokens) if (lower(target.text).includes(token)) scores.set(environment.name, scores.get(environment.name) + 2);\n    const modules = new Set((environment.modules || []).map(lower));\n    for (const imported of imports) {\n      if (!modules.has(imported)) continue;\n      const owners = moduleOwners.get(imported) || [];\n      scores.set(environment.name, scores.get(environment.name) + (owners.length === 1 ? 7 : 1));\n    }\n  }\n  const ranked = allowed.map((item) => ({ item, score: scores.get(item.name) || 0 })).sort((a, b) => b.score - a.score);\n  const best = ranked[0];\n  const second = ranked[1];\n  if (best && best.score >= 6 && best.score >= (second?.score || 0) + 2) return { environment: best.item, reason: imports.length ? 'imports/path' : 'path', target };\n  return { environment: defaultEnv, reason: 'default', target };\n}\nfunction childEnvironment(environment) {\n  const env = { ...process.env, DHR_SELECTED_ENV: environment.name };\n  delete env.DHR_ENV;\n  delete env.PYTHONHOME;\n  const basePath = process.env.DEEPSEEK_HARNESS_BASE_PATH || process.env.PATH || '';\n  if (environment.kind === 'system' || !environment.root) {\n    delete env.VIRTUAL_ENV; delete env.CONDA_PREFIX; delete env.CONDA_DEFAULT_ENV;\n    env.PATH = basePath;\n    return env;\n  }\n  env.PATH = join(environment.root, 'bin') + ':' + basePath;\n  if (environment.kind === 'venv') {\n    env.VIRTUAL_ENV = environment.root; delete env.CONDA_PREFIX; delete env.CONDA_DEFAULT_ENV;\n  } else {\n    delete env.VIRTUAL_ENV; env.CONDA_PREFIX = environment.root; env.CONDA_DEFAULT_ENV = environment.name;\n  }\n  return env;\n}\nfunction executable(environment) {\n  if (tool === 'python' || tool === 'python3') return { file: environment.python || tool, args };\n  if (tool === 'pytest') return { file: environment.python || 'python', args: ['-m', 'pytest', ...args] };\n  if (tool === 'pip' || tool === 'pip3') return { file: environment.python || 'python', args: ['-m', 'pip', ...args] };\n  if (environment.root) {\n    const candidate = join(environment.root, 'bin', tool);\n    if (existsSync(candidate)) return { file: candidate, args };\n  }\n  return { file: tool, args };\n}\nfunction remember(target, environment, reason, status) {\n  if (!target?.key || status !== 0 || reason === 'default' || reason === 'explicit') return;\n  const routes = readRoutes();\n  routes[target.key] = environment.name;\n  try { writeFileSync(routesPath, JSON.stringify(routes, null, 2) + '\\n', { mode: 0o600 }); } catch {}\n}\nconst selected = choose();\nif (!selected?.environment) process.exit(2);\nif (selected.environment.name !== defaultEnv.name || selected.reason !== 'default') {\n  process.stderr.write('[env:auto] ' + selected.environment.name + ' ← ' + (selected.reason || 'route') + '\\n');\n}\nconst command = executable(selected.environment);\nconst result = spawnSync(command.file, command.args, { stdio: 'inherit', env: childEnvironment(selected.environment) });\nconst status = Number.isInteger(result.status) ? result.status : 1;\nremember(selected.target, selected.environment, selected.reason, status);\nif (result.error) process.stderr.write('[env:auto] ' + result.error.message + '\\n');\nprocess.exit(status);\n`;
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function readConfig(agent) {
  const paths = sessionPaths(sessionId(agent));
  if (!paths) return undefined;
  try {
    const parsed = JSON.parse(await readFile(paths.metadata, 'utf8'));
    if (parsed?.version === 2 && Array.isArray(parsed.allowed) && parsed.allowed.length) return parsed;
    if (parsed?.version === 1 && parsed.label) {
      return {
        version: 2,
        sessionId: sessionId(agent),
        defaultName: parsed.label,
        allowed: [{
          id: parsed.kind === 'system' ? 'system' : `legacy:${parsed.root || parsed.label}`,
          kind: parsed.kind || 'system',
          name: parsed.label,
          label: parsed.label,
          description: parsed.root || parsed.python || parsed.label,
          purpose: inferPurpose(parsed.label),
          root: parsed.root || undefined,
          python: parsed.python || undefined,
          modules: [],
        }],
        selectedAt: parsed.selectedAt || new Date().toISOString(),
        cwd: parsed.cwd || agent.session.header.cwd || null,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function saveConfig(agent, config, extra = {}) {
  const id = sessionId(agent);
  const paths = sessionPaths(id);
  if (!paths) throw new Error(`${ENV_DIR_VARIABLE} is not configured; restart Harness from DeepSeek Harness Remote.`);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const metadata = {
    ...config,
    version: 2,
    sessionId: id,
    selectedAt: new Date().toISOString(),
    cwd: agent.session.header.cwd ?? null,
    ...extra,
  };
  await atomicWrite(paths.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
  await atomicWrite(paths.router, routerSource(paths));
  await atomicWrite(paths.activation, activationScript(metadata, paths));
  await rm(paths.notice, { force: true });
  return metadata;
}

async function inheritForSubagent(agent) {
  const header = agent.session.header;
  if (header.origin !== 'subagent' || !header.parentSession) return false;
  if (await readConfig(agent)) return true;
  const parentPaths = sessionPaths(String(header.parentSession));
  if (!parentPaths) return false;
  try {
    const parentConfig = JSON.parse(await readFile(parentPaths.metadata, 'utf8'));
    if (parentConfig?.version !== 2 || !Array.isArray(parentConfig.allowed)) return false;
    await saveConfig(agent, {
      ...parentConfig,
      sessionId: sessionId(agent),
    }, { inheritedFrom: String(header.parentSession) });
    const childPaths = sessionPaths(sessionId(agent));
    if (childPaths && await pathExists(parentPaths.routes)) {
      await atomicWrite(childPaths.routes, await readFile(parentPaths.routes, 'utf8'));
    }
    return true;
  } catch {
    return false;
  }
}

function optionLabel(environment) {
  return environment.name === environment.label ? environment.name : `${environment.name} · ${environment.label}`;
}

async function configureEnvironments(ctx, agent, signal) {
  const environments = await detectEnvironments(agent, { includeModules: true });
  if (!environments.length) throw new Error('No Python environments were detected.');
  if (environments.length === 1) {
    return saveConfig(agent, {
      defaultName: environments[0].name,
      allowed: environments,
      autoRouting: true,
    });
  }

  const current = await readConfig(agent);
  const allowedAnswer = await ctx.userQuestions.ask({
    agent,
    signal,
    questions: [{
      id: 'allowed-python-environments',
      header: 'Allowed Python Environments',
      question: 'Choose the fixed environments this Harness session is allowed to use.',
      detail: current?.allowed?.length
        ? `Current: ${current.allowed.map((item) => item.name).join(', ')}`
        : 'DeepSeek can auto-route Python commands only inside this whitelist.',
      multiSelect: true,
      options: environments.map((environment) => ({
        label: optionLabel(environment),
        description: `${environment.kind} · ${environment.purpose}${environment.root ? ` · ${environment.root}` : ''}`,
      })),
    }],
  });

  const selectedLabels = allowedAnswer.answers?.find((item) => item.id === 'allowed-python-environments')?.selected ?? [];
  const allowed = environments.filter((environment) => selectedLabels.includes(optionLabel(environment)));
  if (!allowed.length) throw new Error('Select at least one allowed environment for this session.');

  let defaultEnvironment = allowed[0];
  if (allowed.length > 1) {
    const defaultAnswer = await ctx.userQuestions.ask({
      agent,
      signal,
      questions: [{
        id: 'default-python-environment',
        header: 'Default Python Environment',
        question: 'Choose the default environment when routing is uncertain.',
        detail: 'DeepSeek/auto-routing may choose another allowed environment for a specific script; ambiguous commands stay here.',
        options: allowed.map((environment) => ({
          label: environment.name,
          description: `${environment.purpose}${environment.root ? ` · ${environment.root}` : ''}`,
        })),
      }],
    });
    const defaultName = defaultAnswer.answers?.find((item) => item.id === 'default-python-environment')?.selected?.[0];
    defaultEnvironment = allowed.find((environment) => environment.name === defaultName) ?? allowed[0];
  }

  return saveConfig(agent, {
    defaultName: defaultEnvironment.name,
    allowed,
    autoRouting: true,
  });
}

function configText(config) {
  const lines = [
    `Default Python environment: ${config.defaultName}`,
    'Allowed environments for this Harness session:',
  ];
  for (const environment of config.allowed || []) {
    lines.push(`- ${environment.name}${environment.name === config.defaultName ? ' [DEFAULT]' : ''}: ${environment.purpose || environment.description || environment.kind}`);
    if (environment.root) lines.push(`  root: ${environment.root}`);
    if (environment.python) lines.push(`  python: ${environment.python}`);
  }
  lines.push('Python/pytest/pip/torchrun/accelerate commands are auto-routed only inside this whitelist.');
  lines.push('Explicit override: dhr-run <environment> -- <command> [args...]');
  return lines.join('\n');
}

async function setDefault(agent, requested) {
  const config = await readConfig(agent);
  if (!config) return undefined;
  const matched = config.allowed.find((environment) => environment.name.toLowerCase() === requested.toLowerCase());
  if (!matched) return undefined;
  return saveConfig(agent, { ...config, defaultName: matched.name });
}

async function runEnvCommand(ctx, invocation) {
  const input = invocation.rawInput.trim();
  if (!environmentDirectory()) {
    return { kind: 'error', text: 'Session environments are unavailable. Restart Harness using DeepSeek Harness Remote.' };
  }

  const command = input.toLowerCase();
  if (input === '' || command === 'select' || command === 'configure') {
    try {
      return { kind: 'success', text: configText(await configureEnvironments(ctx, invocation.agent, invocation.signal)) };
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : 'Environment configuration failed.' };
    }
  }

  if (command === 'status' || command === 'list') {
    const config = await readConfig(invocation.agent);
    return {
      kind: 'success',
      text: config ? configText(config) : 'No environment whitelist is configured yet. Run /env to configure this session.',
    };
  }

  const defaultMatch = /^default\s+(.+)$/iu.exec(input);
  if (defaultMatch) {
    const updated = await setDefault(invocation.agent, defaultMatch[1].trim());
    return updated
      ? { kind: 'success', text: configText(updated) }
      : { kind: 'error', text: `Environment is not in this session whitelist: ${defaultMatch[1].trim()}` };
  }

  const updated = await setDefault(invocation.agent, input);
  if (updated) return { kind: 'success', text: configText(updated) };
  return {
    kind: 'error',
    text: `Unknown or disallowed environment: ${input}\nUse /env to change the whitelist, /env list to inspect it, or /env default <name> to change only the default.`,
  };
}

export function apply(ctx) {
  ctx.commands.register({
    name: 'env',
    description: 'configure the fixed Python environment whitelist and default for this Harness session',
    input: { hint: '[list|configure|default <name>]' },
    handler: (invocation) => runEnvCommand(ctx, invocation),
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'bash' || !exec.agent || !environmentDirectory()) return next();
    if (await readConfig(exec.agent)) return next();
    if (await inheritForSubagent(exec.agent)) return next();
    try {
      await configureEnvironments(ctx, exec.agent, exec.signal);
      return next();
    } catch {
      return {
        kind: 'deny',
        reason: 'Configure the allowed Python environments for this Harness session with /env before running Bash.',
      };
    }
  });
}
