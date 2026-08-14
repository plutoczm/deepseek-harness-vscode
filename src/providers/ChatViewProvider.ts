import * as vscode from 'vscode';
import { HarnessBridgeMessage, HarnessManager } from '../harness/HarnessManager';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'deepseekHarness.chatView';
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly harness: HarnessManager,
  ) {
    this.harness.onMessage((message) => this.forwardHarnessMessage(message));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (message: { type: string; prompt?: string }) => {
      try {
        switch (message.type) {
          case 'send':
            await this.harness.sendPrompt(message.prompt ?? '');
            break;
          case 'setApiKey':
            await vscode.commands.executeCommand('deepseekHarness.setApiKey');
            break;
          case 'newSession':
            this.harness.newSession();
            this.resetConversation();
            break;
          case 'installRuntime':
            await vscode.commands.executeCommand('deepseekHarness.installRuntime');
            break;
          case 'openSettings':
            await vscode.commands.executeCommand(
              'workbench.action.openSettings',
              '@ext:plutoczm.deepseek-harness-vscode',
            );
            break;
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        void view.webview.postMessage({ type: 'error', message: text });
      }
    });
  }

  resetConversation(): void {
    void this.view?.webview.postMessage({
      type: 'reset',
      sessionId: this.harness.getSessionId(),
    });
  }

  private forwardHarnessMessage(message: HarnessBridgeMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); }
  #app { height: 100vh; display: flex; flex-direction: column; }
  header { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); align-items: center; }
  header .title { flex: 1; font-weight: 600; }
  button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 4px; padding: 5px 8px; cursor: pointer; }
  button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
  button:disabled { opacity: .55; cursor: default; }
  #messages { flex: 1; overflow-y: auto; padding: 10px; }
  .bubble { margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .user { background: var(--vscode-inputOption-activeBackground); border: 1px solid var(--vscode-inputOption-activeBorder); }
  .assistant { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
  .error { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
  .activity { margin: 4px 0; padding: 4px 7px; border-left: 2px solid var(--vscode-progressBar-background); color: var(--vscode-descriptionForeground); font-size: 12px; }
  .activity code { color: var(--vscode-textPreformat-foreground); }
  #composer { padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
  textarea { width: 100%; min-height: 82px; resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: 8px; font: inherit; outline: none; }
  .composerRow { display: flex; gap: 6px; margin-top: 6px; align-items: center; }
  .composerRow .hint { flex: 1; color: var(--vscode-descriptionForeground); font-size: 11px; }
  #status { padding: 4px 10px; color: var(--vscode-descriptionForeground); font-size: 11px; min-height: 20px; }
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="title">DeepSeek Harness</div>
    <button class="secondary" id="newSession" title="New session">＋</button>
    <button class="secondary" id="settings" title="Settings">⚙</button>
  </header>
  <div id="status">Workspace agent · Remote SSH compatible</div>
  <main id="messages"></main>
  <section id="composer">
    <textarea id="prompt" placeholder="Ask DeepSeek to inspect, edit, test, or explain this workspace…"></textarea>
    <div class="composerRow">
      <span class="hint">Ctrl/Cmd + Enter to send</span>
      <button class="secondary" id="apiKey">API Key</button>
      <button id="send">Send</button>
    </div>
  </section>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const prompt = document.getElementById('prompt');
  const send = document.getElementById('send');
  const status = document.getElementById('status');
  let busy = false;

  function scrollBottom() { messages.scrollTop = messages.scrollHeight; }
  function addBubble(kind, text) {
    const el = document.createElement('div');
    el.className = 'bubble ' + kind;
    el.textContent = text;
    messages.appendChild(el);
    scrollBottom();
  }
  function addActivity(text) {
    const el = document.createElement('div');
    el.className = 'activity';
    el.textContent = text;
    messages.appendChild(el);
    scrollBottom();
  }
  function setBusy(value) {
    busy = value;
    send.disabled = value;
    status.textContent = value ? 'Agent running…' : 'Workspace agent · Remote SSH compatible';
  }
  function summarizeNotification(n) {
    const method = n && n.method ? n.method : 'notification';
    const params = n && n.params ? n.params : {};
    if (method === 'session.status') return 'Status: ' + (params.status || 'changed');
    if (method === 'subagent.started') return 'Subagent started: ' + (params.childSessionId || 'child');
    if (method === 'subagent.finished') return 'Subagent finished: ' + (params.childSessionId || 'child');
    if (method === 'session.event') {
      const event = params.event || {};
      const type = event.type || 'event';
      if (type === 'tool/call') {
        const name = event.data && (event.data.name || event.data.toolName);
        return 'Tool call' + (name ? ': ' + name : '');
      }
      if (type === 'tool/result') return 'Tool result';
      if (type === 'step/start') return 'Thinking / step started';
      if (type === 'step/end') return 'Step completed';
      if (type === 'turn/end') {
        const reason = event.data && event.data.reason && event.data.reason.kind;
        return 'Turn ended' + (reason ? ': ' + reason : '');
      }
      return type;
    }
    return method;
  }

  function submit() {
    const text = prompt.value.trim();
    if (!text || busy) return;
    addBubble('user', text);
    prompt.value = '';
    setBusy(true);
    vscode.postMessage({ type: 'send', prompt: text });
  }

  send.addEventListener('click', submit);
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  });
  document.getElementById('apiKey').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
  document.getElementById('newSession').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
  document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'notification') {
      addActivity(summarizeNotification(msg.notification));
    } else if (msg.type === 'result') {
      if (msg.finalResponse) addBubble('assistant', msg.finalResponse);
      addActivity('Finished: ' + (msg.finishReason || 'idle'));
      setBusy(false);
    } else if (msg.type === 'error') {
      addBubble('error', msg.message || 'Unknown error');
      setBusy(false);
    } else if (msg.type === 'reset') {
      messages.replaceChildren();
      status.textContent = 'New session: ' + String(msg.sessionId).slice(0, 8);
      setBusy(false);
    } else if (msg.type === 'ready') {
      status.textContent = 'Harness runtime ready';
    }
  });
</script>
</body>
</html>`;
  }
}
