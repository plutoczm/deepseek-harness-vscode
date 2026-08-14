import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'node:child_process';
import * as net from 'node:net';

class HarnessLauncher implements vscode.Disposable {
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private stopping = false;
  private state: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
  private readonly output = vscode.window.createOutputChannel('DeepSeek Harness');
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  constructor() {
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

    if (await this.isPortOpen(port)) {
      this.state = 'running';
      this.updateStatus('Using an existing service on the configured port');
      this.output.appendLine(`[launcher] Reusing service already listening on 127.0.0.1:${port}.`);
      return;
    }

    const workspace = this.workspacePath();
    const npx = this.npxCommand();
    const args = ['--yes', '@deepseek-ai/dsh', '--profile', 'web', '--port', String(port)];

    this.state = 'starting';
    this.updateStatus();
    this.output.appendLine('');
    this.output.appendLine(`[launcher] Workspace: ${workspace}`);
    this.output.appendLine(`[launcher] Starting: ${npx} ${args.join(' ')}`);

    let spawnError: Error | undefined;
    const child = spawn(npx, args, {
      cwd: workspace,
      env: process.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.output.append(chunk));
    child.stderr?.on('data', (chunk: string) => this.output.append(chunk));
    child.once('error', (error) => {
      spawnError = error;
      this.output.appendLine(`[launcher] Failed to start process: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      const intentional = this.stopping;
      if (this.child === child) {
        this.child = undefined;
      }
      if (!intentional) {
        this.output.appendLine(
          `[launcher] Harness process exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}.`,
        );
        this.state = 'stopped';
        this.updateStatus();
      }
    });

    try {
      await this.waitForPort(port, this.startupTimeoutMs(), () => spawnError, child);
      this.state = 'running';
      this.updateStatus();
      this.output.appendLine(`[launcher] Harness Web UI is ready on 127.0.0.1:${port}.`);
    } catch (error) {
      this.state = 'error';
      this.updateStatus();
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
    if (!this.child) {
      const portInUse = await this.isPortOpen(this.port());
      this.state = portInUse ? 'running' : 'stopped';
      this.updateStatus(portInUse ? 'Service is running but was not started by this extension' : undefined);
      if (portInUse) {
        vscode.window.showInformationMessage(
          'DeepSeek Harness is listening on the configured port, but this extension did not start that process, so it was left running.',
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

  showLogs(): void {
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
      detail,
      'Click to start/open the official Harness Web UI.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async waitForPort(
    port: number,
    timeoutMs: number,
    getSpawnError: () => Error | undefined,
    child: ChildProcess,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const spawnError = getSpawnError();
      if (spawnError) {
        throw spawnError;
      }
      if (child.exitCode !== null) {
        throw new Error(`DeepSeek Harness exited before opening port ${port} (code ${child.exitCode}).`);
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

  private async stopOwnedProcess(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || !child.pid) {
      return;
    }

    this.stopping = true;
    try {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.once('exit', () => resolve());
          killer.once('error', () => {
            child.kill();
            resolve();
          });
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }

        const deadline = Date.now() + 2500;
        while (Date.now() < deadline && (await this.isPortOpen(this.port()))) {
          await delay(150);
        }

        if (await this.isPortOpen(this.port())) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }
    } finally {
      this.stopping = false;
    }
  }

  dispose(): void {
    const child = this.child;
    this.child = undefined;
    if (child?.pid && child.exitCode === null) {
      try {
        if (process.platform === 'win32') {
          child.kill();
        } else {
          process.kill(-child.pid, 'SIGTERM');
        }
      } catch {
        child.kill();
      }
    }
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
  const launcher = new HarnessLauncher();

  const register = (command: string, action: () => Promise<void> | void) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async () => {
        try {
          await action();
        } catch (error) {
          const choice = await vscode.window.showErrorMessage(errorText(error), 'Show Logs');
          if (choice === 'Show Logs') {
            launcher.showLogs();
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
  // HarnessLauncher is disposed by the extension context.
}
