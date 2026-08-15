import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { openSshRuntime } from './runtime.js';
import { readRemoteWorkspaceManifest } from './remote-workspace.js';
import { shellQuote } from './util.js';

export const name = 'dsh-openssh-vpn-remote-tools';
export const inject = ['tools', 'systemPrompt'];

function text(value) {
  return [{ type: 'text', text: String(value) }];
}

function workspaceFor(exec) {
  const anchor = exec?.agent?.session?.header?.cwd;
  if (!anchor) throw new Error('remote workspace tools require a session cwd');
  const manifest = readRemoteWorkspaceManifest(anchor);
  if (!manifest) {
    throw new Error(`session cwd is not an OpenSSH remote workspace anchor: ${anchor}`);
  }
  return manifest;
}

function remotePath(workspace, input = '.') {
  const root = posix.resolve(workspace.remotePath);
  const raw = String(input || '.').trim() || '.';
  const resolved = raw.startsWith('/') ? posix.resolve(raw) : posix.resolve(root, raw);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`path escapes remote workspace root ${root}: ${raw}`);
  }
  return resolved;
}

function relativeRemotePath(workspace, absolute) {
  const rel = posix.relative(posix.resolve(workspace.remotePath), absolute);
  return rel === '' ? '.' : rel;
}

function commandResult(result) {
  const lines = [`[exit code: ${result.exitCode ?? 'null'}]`];
  if (result.stdout) lines.push(result.stdout.replace(/\s+$/u, ''));
  if (result.stderr) lines.push(`[stderr]\n${result.stderr.replace(/\s+$/u, '')}`);
  if (result.timedOut) lines.push('[timed out]');
  if (result.error) lines.push(`[error] ${result.error}`);
  return lines.join('\n');
}

async function runInWorkspace(workspace, command, timeoutMs = 60_000, workdir = workspace.remotePath) {
  const { engine } = openSshRuntime();
  const wrapped = `cd ${shellQuote(workdir)} && ${command}`;
  return engine.exec(workspace.alias, wrapped, timeoutMs);
}

async function writeRemoteFile(workspace, path, content) {
  const absolute = remotePath(workspace, path);
  const encoded = Buffer.from(String(content), 'utf8').toString('base64');
  const parent = posix.dirname(absolute);
  const command = [
    `mkdir -p ${shellQuote(parent)}`,
    `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(absolute)}`,
  ].join(' && ');
  const result = await runInWorkspace(workspace, command, 120_000);
  if (!result.success) throw new Error(result.stderr.trim() || result.error || 'remote write failed');
  return { path: relativeRemotePath(workspace, absolute), bytes: Buffer.byteLength(String(content), 'utf8') };
}

function bashTool() {
  return defineTool({
    name: 'bash',
    description: 'Execute a bash command on the SSH host backing this Harness remote workspace. The default workdir is the real remote project directory, not the local Windows workspace anchor. GitHub traffic automatically follows the OpenSSH/VPN route selected by dsh-openssh-vpn.',
    parameters: {
      command: { type: 'string', required: true, description: 'Bash command to execute on the remote host.' },
      description: { type: 'string', required: true, description: 'Short description of the command for UI/log display.' },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds; default 60000.' },
      workdir: { type: 'string', description: 'Remote workdir. Relative paths are resolved inside the remote workspace and cannot escape it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          timedOut: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(commandResult(value)),
    },
    async execute(args, exec) {
      const workspace = workspaceFor(exec);
      const workdir = args.workdir === undefined
        ? workspace.remotePath
        : remotePath(workspace, args.workdir);
      return runInWorkspace(
        workspace,
        String(args.command || ''),
        Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 60_000,
        workdir,
      );
    },
  });
}

function readTool() {
  return defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file from the current SSH-backed remote workspace. Paths are remote-project-relative unless an absolute path inside the remote workspace is supplied.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path.' },
      offset: { type: 'integer', description: '1-based first line; default 1.' },
      limit: { type: 'integer', description: 'Maximum lines; default 400, max 2000.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.content),
    },
    async execute(args, exec) {
      const workspace = workspaceFor(exec);
      const absolute = remotePath(workspace, args.path);
      const start = Math.max(1, Math.trunc(Number(args.offset) || 1));
      const limit = Math.max(1, Math.min(2000, Math.trunc(Number(args.limit) || 400)));
      const end = start + limit - 1;
      const command = `test -f ${shellQuote(absolute)} && sed -n ${shellQuote(`${start},${end}p`)} ${shellQuote(absolute)}`;
      const result = await runInWorkspace(workspace, command, 60_000);
      if (!result.success) throw new Error(result.stderr.trim() || `remote read failed: ${absolute}`);
      return { path: relativeRemotePath(workspace, absolute), content: result.stdout };
    },
  });
}

function writeTool() {
  return defineTool({
    name: 'write',
    description: 'Write/replace a UTF-8 text file in the current SSH-backed remote workspace. Parent directories are created automatically.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path.' },
      content: { type: 'string', required: true, description: 'Complete UTF-8 file contents.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => text(`wrote ${value.bytes} bytes to ${value.path}`),
    },
    async execute(args, exec) {
      return writeRemoteFile(workspaceFor(exec), args.path, args.content);
    },
  });
}

function editTool() {
  return defineTool({
    name: 'edit',
    description: 'Replace exact text in a UTF-8 file in the current SSH-backed remote workspace. By default the old text must occur exactly once; set replaceAll=true to replace every occurrence.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path.' },
      oldText: { type: 'string', required: true, description: 'Exact text to replace.' },
      newText: { type: 'string', required: true, description: 'Replacement text.' },
      replaceAll: { type: 'boolean', description: 'Replace all occurrences instead of requiring exactly one.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          replacements: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => text(`edited ${value.path}: ${value.replacements} replacement(s)`),
    },
    async execute(args, exec) {
      const workspace = workspaceFor(exec);
      const absolute = remotePath(workspace, args.path);
      const result = await runInWorkspace(workspace, `cat ${shellQuote(absolute)}`, 60_000);
      if (!result.success) throw new Error(result.stderr.trim() || `remote read failed: ${absolute}`);
      const oldText = String(args.oldText);
      if (oldText === '') throw new Error('oldText must not be empty');
      const source = result.stdout;
      let count = 0;
      let cursor = 0;
      while (true) {
        const index = source.indexOf(oldText, cursor);
        if (index < 0) break;
        count += 1;
        cursor = index + oldText.length;
      }
      if (count === 0) throw new Error('oldText was not found in the remote file');
      if (args.replaceAll !== true && count !== 1) {
        throw new Error(`oldText occurs ${count} times; provide more context or set replaceAll=true`);
      }
      const next = args.replaceAll === true
        ? source.split(oldText).join(String(args.newText))
        : source.replace(oldText, String(args.newText));
      await writeRemoteFile(workspace, absolute, next);
      return { path: relativeRemotePath(workspace, absolute), replacements: args.replaceAll === true ? count : 1 };
    },
  });
}

function globTool() {
  return defineTool({
    name: 'glob',
    description: 'List files in the SSH-backed remote workspace matching a shell-style path pattern. Returns at most 500 paths.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Pattern such as **/*.py, src/*.ts, or *.md.' },
      path: { type: 'string', description: 'Optional remote directory inside the workspace to search from.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { paths: { type: 'array', items: { type: 'string' }, required: true } },
      },
      render: (_args, value) => text(value.paths.join('\n') || 'no matches'),
    },
    async execute(args, exec) {
      const workspace = workspaceFor(exec);
      const base = args.path === undefined ? workspace.remotePath : remotePath(workspace, args.path);
      const pattern = String(args.pattern || '*').replace(/^\.\//u, '');
      const command = `find ${shellQuote(base)} -type f -path ${shellQuote(posix.join(base, pattern))} -print | head -n 500`;
      const result = await runInWorkspace(workspace, command, 60_000);
      if (!result.success) throw new Error(result.stderr.trim() || 'remote glob failed');
      const root = posix.resolve(workspace.remotePath);
      const paths = result.stdout.split(/\r?\n/u).filter(Boolean).map((item) => posix.relative(root, item) || '.');
      return { paths };
    },
  });
}

function grepTool() {
  return defineTool({
    name: 'grep',
    description: 'Search text recursively in the SSH-backed remote workspace using grep -E. Returns at most 500 matching lines with file names and line numbers.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Extended regular expression.' },
      path: { type: 'string', description: 'Optional file/directory inside the remote workspace; default workspace root.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { matches: { type: 'string', required: true } },
      },
      render: (_args, value) => text(value.matches || 'no matches'),
    },
    async execute(args, exec) {
      const workspace = workspaceFor(exec);
      const target = args.path === undefined ? workspace.remotePath : remotePath(workspace, args.path);
      const command = `grep -RIn --exclude-dir=.git -E ${shellQuote(String(args.pattern))} ${shellQuote(target)} 2>/dev/null | head -n 500 || true`;
      const result = await runInWorkspace(workspace, command, 60_000);
      const root = posix.resolve(workspace.remotePath);
      const rewritten = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) =>
        line.startsWith(`${root}/`) ? line.slice(root.length + 1) : line).join('\n');
      return { matches: rewritten };
    },
  });
}

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:openssh-remote-workspace',
    order: 80,
    text: 'This session is attached to an SSH-backed remote workspace. The session cwd is a local Harness anchor only. The bash/read/write/edit/glob/grep tools in this preset transparently operate on the mapped remote host and remote project root; use them for all project filesystem and command work.',
  });
  const disposers = [bashTool(), readTool(), writeTool(), editTool(), globTool(), grepTool()]
    .map((tool) => ctx.tools.register(tool));
  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}
