import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export type HarnessBridgeMessage =
  | { type: 'ready'; model?: string; cwd?: string; sdkVersion?: string }
  | { type: 'notification'; requestId: string; notification: unknown }
  | {
      type: 'result';
      requestId: string;
      sessionId: string;
      finalResponse: string | null;
      finishReason: string | null;
    }
  | { type: 'log'; stream: 'stderr'; message: string }
  | { type: 'error'; requestId?: string; message: string; traceback?: string };

export interface HarnessRuntimeInfo {
  sessionId: string;
  model: string;
  remoteName: string;
  workspaceName: string;
}

const SESSION_STATE_KEY = 'deepseekHarness.currentSessionId';

export class HarnessManager implements vscode.Disposable {
  private process?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private sessionId: string;
  private bridgeReportedError = false;
  private readonly messageEmitter = new vscode.EventEmitter<HarnessBridgeMessage>();
  readonly onMessage = this.messageEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.sessionId = context.workspaceState.get<string>(SESSION_STATE_KEY) ?? randomUUID();
    void context.workspaceState.update(SESSION_STATE_KEY, this.sessionId);
  }

  newSession(): string {
    this.sessionId = randomUUID();
    void this.context.workspaceState.update(SESSION_STATE_KEY, this.sessionId);
    return this.sessionId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getRuntimeInfo(): HarnessRuntimeInfo {
    return {
      sessionId: this.sessionId,
      model: this.config<string>('model', 'deepseek-v4-pro'),
      remoteName: vscode.env.remoteName ?? 'local',
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name ?? 'no-workspace',
    };
  }

  async sendPrompt(prompt: string): Promise<string> {
    const text = prompt.trim();
    if (!text) {
      throw new Error('Prompt is empty.');
    }

    await this.ensureStarted();
    const requestId = randomUUID();
    this.process!.stdin.write(
      JSON.stringify({
        type: 'run',
        requestId,
        sessionId: this.sessionId,
        prompt: text,
      }) + '\n',
    );
    return requestId;
  }

  async restart(): Promise<void> {
    await this.stop(false);
  }

  async interrupt(): Promise<void> {
    await this.stop(true);
  }

  async installOrUpgradeRuntime(): Promise<void> {
    const python = this.config<string>('pythonPath', 'python3');
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Installing DeepSeek Harness runtime',
        cancellable: false,
      },
      () =>
        new Promise<void>((resolve, reject) => {
          execFile(
            python,
            ['-m', 'pip', 'install', '--upgrade', 'deepseek-harness-sdk'],
            { cwd: this.workspacePath() },
            (error, stdout, stderr) => {
              if (error) {
                reject(new Error(`${error.message}\n${stderr}`));
                return;
              }
              const detail = (stdout || stderr).trim().split('\n').slice(-1)[0];
              vscode.window.showInformationMessage(
                `DeepSeek Harness runtime installed${detail ? `: ${detail}` : '.'}`,
              );
              resolve();
            },
          );
        }),
    );
    await this.restart();
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && !this.process.killed) {
      return;
    }

    const apiKey = await this.context.secrets.get('deepseekHarness.apiKey');
    if (!apiKey) {
      throw new Error('DeepSeek API key is not configured. Run “DeepSeek Harness: Set API Key”.');
    }

    const python = this.config<string>('pythonPath', 'python3');
    const bridgePath = this.context.asAbsolutePath(path.join('python', 'harness_bridge.py'));
    const workspace = this.workspacePath();
    const sessionRoot = path.join(this.context.globalStorageUri.fsPath, 'sessions');
    this.bridgeReportedError = false;

    this.process = spawn(python, ['-u', bridgePath], {
      cwd: workspace,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: apiKey,
        DEEPSEEK_BASE_URL: this.config<string>('baseUrl', 'https://api.deepseek.com'),
        DSH_VSCODE_MODEL: this.config<string>('model', 'deepseek-v4-pro'),
        DSH_VSCODE_MAX_TOKENS: String(this.config<number>('maxTokens', 49152)),
        DSH_VSCODE_CWD: workspace,
        DSH_VSCODE_SESSION_ROOT: sessionRoot,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    this.process.stderr.on('data', (chunk: string) => {
      const message = chunk.trim();
      if (message) {
        this.messageEmitter.fire({ type: 'log', stream: 'stderr', message });
      }
    });
    this.process.on('error', (error) => {
      this.bridgeReportedError = true;
      this.messageEmitter.fire({ type: 'error', message: error.message });
    });
    this.process.on('exit', (code, signal) => {
      if (code !== 0 && code !== null && !this.bridgeReportedError) {
        this.messageEmitter.fire({
          type: 'error',
          message: `Harness bridge exited with code ${code}${signal ? ` (${signal})` : ''}.`,
        });
      }
      this.process = undefined;
      this.stdoutBuffer = '';
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as HarnessBridgeMessage;
        if (message.type === 'error') {
          this.bridgeReportedError = true;
        }
        this.messageEmitter.fire(message);
      } catch {
        this.bridgeReportedError = true;
        this.messageEmitter.fire({ type: 'error', message: `Invalid bridge output: ${line}` });
      }
    }
  }

  private workspacePath(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a workspace folder before starting DeepSeek Harness.');
    }
    return folder.uri.fsPath;
  }

  private config<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('deepseekHarness').get<T>(key, fallback);
  }

  private async stop(force: boolean): Promise<void> {
    const child = this.process;
    this.process = undefined;
    if (!child || child.killed) return;

    if (!force) {
      try {
        child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
      } catch {
        // Ignore a broken pipe during shutdown.
      }
    }

    child.kill();
  }

  dispose(): void {
    void this.stop(false);
    this.messageEmitter.dispose();
  }
}
