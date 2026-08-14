import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

interface SessionEnvironmentIntegration {
  readonly env: NodeJS.ProcessEnv;
  readonly patchArgs: string[];
}

interface OwnedHarnessState {
  readonly pid: number;
  readonly port: number;
  readonly workspace: string;
  readonly logPath: string;
  readonly startedAt: number;
  readonly processStartTicks?: string;
}

class HarnessLauncher implements vscode.Disposable {
  private child?: ChildProcess;
  private owned?: OwnedHarnessState;
  private starting?: Promise<void>;
  private stopping = false;
  private state: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
  private readonly output = vscode.window.createOutputChannel('DeepSeek Harness');
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar.command = 'deepseekHarness.open';
    this.updateStatus();
    this.statusBar.show();
  }

  async start(): Promise<void> {
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.startInternal().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startInternal(): Promise<void> {
    const port = this.port();
    const workspace = this.workspacePath();

    const persisted = await this.readOwnedState();
    if (persisted && persisted.port === port && (await this.pidMatchesState(persisted))) {
      this.owned = persisted;
      this.state = 'starting';
      this.updateStatus('Reattaching to extension-owned Harness process');
      this.output.appendLine(
        `[launcher] Reattaching to Harness PID ${persisted.pid} from a previous Extension Host.`,
      );
      this.output.appendLine(`[launcher] Harness workspace: ${persisted.workspace}`);
      this.output.appendLine(`[launcher] Persistent log: ${persisted.logPath}`);

      try {
        await this.waitForOwnedPort(port, this.startupTimeoutMs(), persisted);
        this.state = 'running';
        this.updateStatus(
          persisted.workspace === workspace
            ? 'Reattached after Extension Host reload'
            : `Running for ${persisted.workspace}`,
        );
        this.output.appendLine(`[launcher] Harness Web UI is ready on 127.0.0.1:${port}.`);
        return;
      } catch (error) {
        this.output.appendLine(`[launcher] Persisted Harness could not be reattached: ${errorText(error)}`);
        await this.stopOwnedProcess();
      }
    } else if (persisted) {
      await this.clearOwnedState();
    }

    if (await this.isPortOpen(port)) {
      this.state = 'running';
      this.updateStatus('Using an existing service on the configured port');
      this.output.appendLine(`[launcher] Reusing service already listening on 127.0.0.1:${port}.`);
      this.output.appendLine(
        '[launcher] Note: per-session /env integration is only guaranteed when Harness was started by this extension.',
      );
      return;
    }

    const npx = this.npxCommand();
    const integration = await this.prepareSessionEnvironmentIntegration();
    const args = [
      '--yes',
      '@deepseek-ai/dsh',
      '--profile',
      'web',
      ...integration.patchArgs,
      '--port',
      String(port),
    ];

    await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true, mode: 0o700 });
    const logPath = path.join(this.context.globalStorageUri.fsPath, 'harness.log');
    await fs.writeFile(logPath, '', { encoding: 'utf8', mode: 0o600 });
    const logHandle = await fs.open(logPath, 'a', 0o600);

    this.state = 'starting';
    this.updateStatus();
    this.output.appendLine('');
    this.output.appendLine(`[launcher] Workspace: ${workspace}`);
    this.output.appendLine(`[launcher] Starting: ${npx} ${args.join(' ')}`);
    this.output.appendLine(`[launcher] Persistent log: ${logPath}`);

    let spawnError: Error | undefined;
    let child: ChildProcess;
    try {
      child = spawn(npx, args, {
        cwd: workspace,
        env: integration.env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', logHandle.fd, logHandle.fd],
      });
    } finally {
      await logHandle.close();
    }

    this.child = child;
    child.unref();

    child.once('error', (error) => {
      spawnError = error;
      this.output.appendLine(`[launcher] Failed to start process: ${error.message}`);
    });

    if (!child.pid) {
      this.state = 'error';
      this.updateStatus();
      throw new Error('DeepSeek Harness process started without a PID.');
    }

    const owned: OwnedHarnessState = {
      pid: child.pid,
      port,
      workspace,
      logPath,
      startedAt: Date.now(),
      processStartTicks: await this.readProcessStartTicks(child.pid),
    };
    this.owned = owned;
    await this.writeOwnedState(owned);

    child.once('exit', (code, signal) => {
      const intentional = this.stopping;
      if (this.child === child) {
        this.child = undefined;
      }
      if (this.owned?.pid === owned.pid) {
        this.owned = undefined;
        void this.clearOwnedStateIfPid(owned.pid);
      }
      if (!intentional) {
        this.output.appendLine(
          `[launcher] Harness process exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}.`,
        );
        this.output.appendLine(`[launcher] Process log: ${logPath}`);
        this.state = 'stopped';
        this.updateStatus();
      }
    });

    try {
      await this.waitForOwnedPort(port, this.startupTimeoutMs(), owned, () => spawnError);
      this.state = 'running';
      this.updateStatus();
      this.output.appendLine(`[launcher] Harness Web UI is ready on 127.0.0.1:${port}.`);
      if (process.platform !== 'win32') {
        this.output.appendLine('[launcher] Per-session Python environments are available through /env.');
      }
    } catch (error) {
      this.state = 'error';
      this.updateStatus();
      await this.appendPersistentLog();
      await this.stopOwnedProcess();

      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|not found/i.test(message)) {
        throw new Error(
          `Could not run “${npx}”. Install Node.js/npm on the workspace host, or set deepseekHarness.npxPath.\n${message}`,
        );
      }
      throw error;
    }
  }

  async openInVsCode(): Promise<void> {
    await this.start();
    const uri = await this.forwardedUri();
    this.output.appendLine(`[launcher] Opening forwarded UI: ${uri.toString(true)}`);

    try {
      await vscode.commands.executeCommand('simpleBrowser.show', uri.toString(true));
    } catch (error) {
      this.output.appendLine(
        `[launcher] VS Code Simple Browser unavailable; opening system browser instead: ${String(error)}`,
      );
      await vscode.env.openExternal(uri);
    }
  }

  async openExternal(): Promise<void> {
    await this.start();
    await vscode.env.openExternal(await this.forwardedUri());
  }

  async stop(): Promise<void> {
    if (!this.owned) {
      const persisted = await this.readOwnedState();
      if (persisted && (await this.pidMatchesState(persisted))) {
        this.owned = persisted;
      }
    }

    if (!this.owned) {
      const portInUse = await this.isPortOpen(this.port());
      this.state = portInUse ? 'running' : 'stopped';
      this.updateStatus(portInUse ? 'Service is running but was not started by this extension' : undefined);
      if (portInUse) {
        vscode.window.showInformationMessage(
          'DeepSeek Harness is listening on the configured port, but this extension does not own that process, so it was left running.',
        );
      }
      return;
    }

    await this.stopOwnedProcess();
    this.state = 'stopped';
    this.updateStatus();
    this.output.appendLine('[launcher] Harness stopped.');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async showLogs(): Promise<void> {
    await this.appendPersistentLog();
    this.output.show(true);
  }

  private async forwardedUri(): Promise<vscode.Uri> {
    const remoteUri = vscode.Uri.parse(`http://127.0.0.1:${this.port()}`);
    return vscode.env.asExternalUri(remoteUri);
  }

  private workspacePath(): string {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    const folder = activeFolder ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a workspace folder before starting DeepSeek Harness.');
    }
    return folder.uri.fsPath;
  }

  private port(): number {
    return vscode.workspace.getConfiguration('deepseekHarness').get<number>('port', 3080);
  }

  private startupTimeoutMs(): number {
    return vscode.workspace
      .getConfiguration('deepseekHarness')
      .get<number>('startupTimeoutMs', 120000);
  }

  private npxCommand(): string {
    const configured = vscode.workspace
      .getConfiguration('deepseekHarness')
      .get<string>('npxPath', 'npx')
      .trim();
    if (process.platform === 'win32' && configured === 'npx') {
      return 'npx.cmd';
    }
    return configured || (process.platform === 'win32' ? 'npx.cmd' : 'npx');
  }

  private async prepareSessionEnvironmentIntegration(): Promise<SessionEnvironmentIntegration> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (process.platform === 'win32') {
      this.output.appendLine(
        '[launcher] Per-session /env activation currently targets Bash on Linux/macOS; Windows launcher remains unchanged.',
      );
      return { env, patchArgs: [] };
    }

    const sourceDir = path.join(this.context.extensionUri.fsPath, 'harness-plugin');
    const packageTarget = path.join(
      this.dshHome(),
      'profiles',
      'node_modules',
      'deepseek-harness-vscode-session-env',
    );
    await fs.mkdir(packageTarget, { recursive: true });
    for (const filename of ['package.json', 'index.js']) {
      await fs.copyFile(path.join(sourceDir, filename), path.join(packageTarget, filename));
    }

    const sessionEnvDir = path.join(this.context.globalStorageUri.fsPath, 'session-env');
    await fs.mkdir(sessionEnvDir, { recursive: true, mode: 0o700 });

    const bashEnv = path.join(sourceDir, 'bash-env.sh');
    const patch = path.join(sourceDir, 'cordis.patch.yml');
    const inheritedBashEnv = process.env.BASH_ENV?.trim();

    env.BASH_ENV = bashEnv;
    env.DEEPSEEK_HARNESS_SESSION_ENV_DIR = sessionEnvDir;
    env.DEEPSEEK_HARNESS_BASE_PATH = process.env.PATH ?? '';
    delete env.DEEPSEEK_HARNESS_PARENT_BASH_ENV;
    if (inheritedBashEnv && path.resolve(inheritedBashEnv) !== path.resolve(bashEnv)) {
      env.DEEPSEEK_HARNESS_PARENT_BASH_ENV = inheritedBashEnv;
    }

    this.output.appendLine(`[launcher] Session environment state: ${sessionEnvDir}`);
    this.output.appendLine(`[launcher] Harness session environment plugin: ${packageTarget}`);
    return { env, patchArgs: ['--patch', patch] };
  }

  private dshHome(): string {
    const configured = process.env.DSH_HOME?.trim();
    if (!configured) return path.join(os.homedir(), '.dsh');
    if (configured === '~') return os.homedir();
    if (configured.startsWith('~/')) return path.join(os.homedir(), configured.slice(2));
    return path.resolve(configured);
  }

  private stateFile(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'harness-process.json');
  }

  private async readOwnedState(): Promise<OwnedHarnessState | undefined> {
    try {
      const raw = await fs.readFile(this.stateFile(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<OwnedHarnessState>;
      if (
        typeof parsed.pid !== 'number' ||
        typeof parsed.port !== 'number' ||
        typeof parsed.workspace !== 'string' ||
        typeof parsed.logPath !== 'string' ||
        typeof parsed.startedAt !== 'number'
      ) {
        return undefined;
      }
      return parsed as OwnedHarnessState;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.output.appendLine(`[launcher] Could not read persisted process state: ${errorText(error)}`);
      }
      return undefined;
    }
  }

  private async writeOwnedState(state: OwnedHarnessState): Promise<void> {
    await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.stateFile(), `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  private async clearOwnedState(): Promise<void> {
    try {
      await fs.unlink(this.stateFile());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.output.appendLine(`[launcher] Could not remove persisted process state: ${errorText(error)}`);
      }
    }
  }

  private async clearOwnedStateIfPid(pid: number): Promise<void> {
    const persisted = await this.readOwnedState();
    if (!persisted || persisted.pid === pid) {
      await this.clearOwnedState();
    }
  }

  private async readProcessStartTicks(pid: number): Promise<string | undefined> {
    if (process.platform !== 'linux') {
      return undefined;
    }
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      const closingParen = stat.lastIndexOf(')');
      if (closingParen < 0) return undefined;
      const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
      return fields[19];
    } catch {
      return undefined;
    }
  }

  private async pidMatchesState(state: OwnedHarnessState): Promise<boolean> {
    try {
      process.kill(state.pid, 0);
    } catch {
      return false;
    }

    if (state.processStartTicks && process.platform === 'linux') {
      const current = await this.readProcessStartTicks(state.pid);
      return current === state.processStartTicks;
    }
    return true;
  }

  private updateStatus(detail?: string): void {
    const remote = vscode.env.remoteName ? `Remote: ${vscode.env.remoteName}` : 'Local';
    const port = this.port();

    switch (this.state) {
      case 'starting':
        this.statusBar.text = '$(sync~spin) Harness starting';
        break;
      case 'running':
        this.statusBar.text = '$(rocket) DeepSeek Harness';
        break;
      case 'error':
        this.statusBar.text = '$(error) DeepSeek Harness';
        break;
      default:
        this.statusBar.text = '$(circle-slash) DeepSeek Harness';
    }

    this.statusBar.tooltip = [
      `DeepSeek Harness · ${remote}`,
      `Workspace port: ${port}`,
      process.platform !== 'win32' ? 'Per-session Python environment: /env' : undefined,
      detail,
      'Click to start/open the official Harness Web UI.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async waitForOwnedPort(
    port: number,
    timeoutMs: number,
    owned: OwnedHarnessState,
    getSpawnError?: () => Error | undefined,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const spawnError = getSpawnError?.();
      if (spawnError) {
        throw spawnError;
      }
      if (!(await this.pidMatchesState(owned))) {
        throw new Error(`DeepSeek Harness PID ${owned.pid} exited before opening port ${port}.`);
      }
      if (await this.isPortOpen(port)) {
        return;
      }
      await delay(300);
    }
    throw new Error(
      `Timed out waiting for DeepSeek Harness on port ${port}. Run “DeepSeek Harness: Show Logs” for details.`,
    );
  }

  private isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const finish = (result: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(500);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
  }

  private async appendPersistentLog(): Promise<void> {
    const logPath = this.owned?.logPath ?? path.join(this.context.globalStorageUri.fsPath, 'harness.log');
    try {
      const text = await fs.readFile(logPath, 'utf8');
      const tail = text.length > 60000 ? text.slice(-60000) : text;
      this.output.appendLine('');
      this.output.appendLine(`[launcher] ===== Harness process log: ${logPath} =====`);
      this.output.append(tail);
      if (tail && !tail.endsWith('\n')) this.output.appendLine('');
      this.output.appendLine('[launcher] ===== End Harness process log =====');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.output.appendLine(`[launcher] Could not read Harness process log: ${errorText(error)}`);
      }
    }
  }

  private async stopOwnedProcess(): Promise<void> {
    const owned = this.owned ?? (await this.readOwnedState());
    this.child = undefined;
    this.owned = undefined;
    if (!owned || !(await this.pidMatchesState(owned))) {
      await this.clearOwnedState();
      return;
    }

    this.stopping = true;
    try {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
          const killer = spawn('taskkill', ['/PID', String(owned.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.once('exit', () => resolve());
          killer.once('error', () => resolve());
        });
      } else {
        try {
          process.kill(-owned.pid, 'SIGTERM');
        } catch {
          try {
            process.kill(owned.pid, 'SIGTERM');
          } catch {
            // Process already exited.
          }
        }

        const deadline = Date.now() + 2500;
        while (Date.now() < deadline && (await this.pidMatchesState(owned))) {
          await delay(150);
        }

        if (await this.pidMatchesState(owned)) {
          try {
            process.kill(-owned.pid, 'SIGKILL');
          } catch {
            try {
              process.kill(owned.pid, 'SIGKILL');
            } catch {
              // Process already exited.
            }
          }
        }
      }
    } finally {
      await this.clearOwnedState();
      this.stopping = false;
    }
  }

  dispose(): void {
    // Deliberately do not terminate Harness here. Remote SSH may recreate the
    // Extension Host during reconnects, reloads, upgrades, or transient host
    // failures. The detached Harness process is persisted and reattached by the
    // next Extension Host. Explicit Stop/Restart remain the only kill paths.
    this.child?.unref();
    this.child = undefined;
    this.statusBar.dispose();
    this.output.dispose();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function activate(context: vscode.ExtensionContext): void {
  const launcher = new HarnessLauncher(context);

  const register = (command: string, action: () => Promise<void> | void) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async () => {
        try {
          await action();
        } catch (error) {
          const choice = await vscode.window.showErrorMessage(errorText(error), 'Show Logs');
          if (choice === 'Show Logs') {
            await launcher.showLogs();
          }
        }
      }),
    );
  };

  register('deepseekHarness.open', () => launcher.openInVsCode());
  register('deepseekHarness.openExternal', () => launcher.openExternal());
  register('deepseekHarness.start', async () => {
    await launcher.start();
    vscode.window.showInformationMessage('DeepSeek Harness is running.');
  });
  register('deepseekHarness.stop', () => launcher.stop());
  register('deepseekHarness.restart', async () => {
    await launcher.restart();
    vscode.window.showInformationMessage('DeepSeek Harness restarted.');
  });
  register('deepseekHarness.showLogs', () => launcher.showLogs());

  context.subscriptions.push(launcher);
}

export function deactivate(): void {
  // HarnessLauncher is disposed by the extension context without killing Harness.
}
