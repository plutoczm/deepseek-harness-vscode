# DeepSeek Harness for VS Code

A VS Code workspace extension that brings the official **DeepSeek Harness (`dsh`)** into the editor with a Claude Code-style agent sidebar and first-class **Remote SSH** support.

> Status: early alpha. DeepSeek Harness itself is currently in developer preview and may introduce breaking changes.

## Architecture

```text
VS Code UI / Webview
        │
        │ postMessage
        ▼
Workspace Extension Host
        │
        │ JSON-lines bridge
        ▼
Python bridge
        │
        ▼
deepseek-harness-sdk
        │ JSON-RPC / stdio
        ▼
dsh-jsonrpc-agent
        │
        ├─ bash
        ├─ read / write / edit
        ├─ subagent
        └─ session events
```

The extension declares `extensionKind: ["workspace"]`. When a folder is opened through VS Code Remote SSH, the Extension Host, Python bridge, DeepSeek Harness runtime, filesystem tools, and shell execution all run on the **remote workspace host** rather than on your local machine.

## Current features

- DeepSeek Harness activity-bar container and agent sidebar
- DeepSeek-V4-Pro / DeepSeek-V4-Flash model setting
- Official `deepseek-harness-sdk` runtime integration
- Streaming Harness notifications (`session.event`, status, subagent lifecycle)
- Workspace-persisted current session id
- Persistent sidebar draft and recent UI history
- Secure DeepSeek API key storage through VS Code `SecretStorage`
- One-command runtime installation / upgrade
- Remote SSH-compatible workspace execution
- New-session and interrupt-current-run commands
- Context chips for active selection, current/Explorer file, and VS Code Problems
- Configurable per-context truncation for large files/diagnostic sets
- Editor right-click actions for **Fix Selected Code**, **Explain Selected Code**, and **Add Selection to Context**
- Explorer right-click action for **Add File to Context**
- Runtime metadata in the sidebar (local/remote host, model, session id, SDK version)
- Runtime settings automatically take effect after configuration changes by restarting the bridge

## Requirements

- VS Code 1.100+
- Python 3 available on the workspace host
- A DeepSeek API key
- For Remote SSH: install the extension on the remote side when VS Code prompts you

## Development

```bash
git clone https://github.com/plutoczm/deepseek-harness-vscode.git
cd deepseek-harness-vscode
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

## Runtime setup

From the Command Palette, run:

```text
DeepSeek Harness: Install/Upgrade Runtime
```

This executes on the workspace host:

```bash
python3 -m pip install --upgrade deepseek-harness-sdk
```

Then run:

```text
DeepSeek Harness: Set API Key
```

The key is stored using VS Code SecretStorage and is only injected into the Harness bridge process environment.

## Using editor context

The composer exposes three context buttons:

```text
+ Selection   + File   + Problems
```

Each captured item is shown as a removable context chip before the prompt is sent. You can also use the editor and Explorer context menus.

Examples:

1. Select a function and choose **DeepSeek Harness: Fix Selected Code**.
2. Select an unfamiliar block and choose **DeepSeek Harness: Explain Selected Code**.
3. Right-click a file in Explorer and choose **DeepSeek Harness: Add File to Context**.
4. Add **Problems** to send current workspace diagnostics with your request.

Captured context is capped by `deepseekHarness.maxContextChars` per item and is marked when truncated.

## Interrupting a run

While the agent is running, the Send button becomes a **Stop** button. You can also run:

```text
DeepSeek Harness: Interrupt Current Run
```

The plugin terminates the current bridge/runtime process. The next prompt starts a fresh runtime process while retaining the same VS Code session id, allowing Harness persistence/recovery to handle an interrupted turn.

## Remote SSH

1. Connect with `Remote-SSH: Connect to Host...`.
2. Open a folder on the remote machine.
3. Install/enable this extension on the SSH host.
4. Run `DeepSeek Harness: Install/Upgrade Runtime`.
5. Configure the API key.
6. Open the DeepSeek Harness icon in the Activity Bar.

The active VS Code workspace folder becomes the Harness working directory.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `deepseekHarness.pythonPath` | `python3` | Python executable on the workspace host |
| `deepseekHarness.model` | `deepseek-v4-pro` | Harness model |
| `deepseekHarness.baseUrl` | `https://api.deepseek.com` | DeepSeek API base URL |
| `deepseekHarness.maxTokens` | `49152` | Per-request max output tokens |
| `deepseekHarness.maxContextChars` | `60000` | Maximum characters captured for each context item |

## Roadmap

- Native VS Code diff / Accept / Reject workflow backed by an approval-aware Harness filesystem/tool layer
- Session history browser, explicit resume, and fork UI
- Richer structured tool-call/result cards
- `@file`, `@folder`, `@selection`, `@terminal`, and `@problems` text mention parser
- Approval and permission UI
- Direct TypeScript JSON-RPC transport to remove the Python bridge option
- Skills, MCP, and Harness profile/preset management
- VSIX and Marketplace release automation

## Upstream

- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness
- Harness homepage: https://deepseek.com/harness

This project is an independent VS Code integration and is not an official DeepSeek AI product.

## License

MIT
