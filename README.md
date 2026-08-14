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
- Persistent Harness sessions
- Secure DeepSeek API key storage through VS Code `SecretStorage`
- One-command runtime installation / upgrade
- Remote SSH-compatible workspace execution
- New-session command

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

## Roadmap

- Rich tool-call cards with arguments and results
- Native VS Code diff / Accept / Reject workflow
- `@file`, `@folder`, `@selection`, `@terminal`, and Problems context
- Session history / resume / fork UI
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
