# DeepSeek Harness for VS Code

A thin VS Code launcher for the **official DeepSeek Harness Web UI**, with first-class **Remote SSH** support.

This extension does **not** reimplement the DeepSeek agent, chat UI, sessions, file tools, Bash tools, or model configuration. It starts the official Harness on the current VS Code workspace host and lets VS Code expose that UI to you.

> DeepSeek Harness is currently in developer preview and may introduce breaking changes.

## Install the VSIX

Every successful CI run on `main` builds an installable artifact named:

```text
deepseek-harness-vscode-vsix
```

The downloaded ZIP contains:

```text
deepseek-harness-vscode.vsix
```

To install it in VS Code:

1. Open the repository's **Actions** tab.
2. Open the latest successful **CI** run.
3. Download the `deepseek-harness-vscode-vsix` artifact.
4. Unzip it.
5. In VS Code, open **Extensions** → `...` → **Install from VSIX...**.
6. Select `deepseek-harness-vscode.vsix`.

For Remote SSH, connect to the Linux server first. In the Extensions view, make sure **DeepSeek Harness** is installed/enabled for the SSH host. Because this extension is a workspace extension, the launcher runs in the remote Extension Host.

## What it does

When you run **DeepSeek Harness: Open in VS Code**, the extension:

1. Finds the current VS Code workspace folder.
2. Runs the official Harness from that folder:

   ```bash
   npx --yes @deepseek-ai/dsh --profile web --port 3080
   ```

3. Waits for the Harness Web UI to become available on `127.0.0.1:3080`.
4. Calls `vscode.env.asExternalUri(...)` so Remote SSH ports are reachable from the local VS Code client.
5. Opens the forwarded URL in VS Code's built-in Simple Browser.

The invoking directory is therefore the Harness workspace.

## Architecture

### Local workspace

```text
Local VS Code
    │
    ├─ extension
    │    │
    │    └─ npx @deepseek-ai/dsh --profile web --port 3080
    │
    └─ official DeepSeek Harness Web UI
```

### Remote SSH workspace

```text
Your local computer
┌─────────────────────────────────────┐
│ VS Code                             │
│                                     │
│ Simple Browser                     │
│     ▲                               │
└─────┼───────────────────────────────┘
      │ VS Code Remote port forwarding
      │
      ▼
Remote Linux server (no GUI required)
┌─────────────────────────────────────┐
│ VS Code Server / Extension Host     │
│                                     │
│ deepseek-harness-vscode             │
│          │                          │
│          ▼                          │
│ npx @deepseek-ai/dsh                │
│ --profile web --port 3080           │
│          │                          │
│     127.0.0.1:3080                  │
│          │                          │
│          ├─ Harness Agent           │
│          ├─ Bash                    │
│          ├─ filesystem tools        │
│          ├─ sessions                │
│          └─ official Web UI         │
│                                     │
│ /home/user/project                  │
└─────────────────────────────────────┘
```

The remote Linux server does **not** need a desktop environment, X11, or a browser. It only runs the HTTP service. The UI is rendered on your local computer.

## Remote SSH

1. Connect using **Remote-SSH: Connect to Host...**.
2. Open the project folder on the remote server.
3. Install/enable this extension on the SSH host when VS Code prompts you.
4. Make sure Node.js/npm are available on the remote server:

   ```bash
   node --version
   npm --version
   npx --version
   ```

5. Click the **DeepSeek Harness** item in the VS Code status bar, or run:

   ```text
   DeepSeek Harness: Open in VS Code
   ```

The extension declares:

```json
"extensionKind": ["workspace"]
```

so under Remote SSH the launcher itself runs inside the remote VS Code Extension Host. The `dsh` process, Bash commands, and file access therefore operate on the remote Linux workspace.

## Commands

- **DeepSeek Harness: Open in VS Code** — start if necessary and open the official UI in VS Code.
- **DeepSeek Harness: Open in Browser** — start if necessary and open the forwarded UI in your normal browser.
- **DeepSeek Harness: Start** — start the official Harness without opening the UI.
- **DeepSeek Harness: Stop** — stop a Harness process started by this extension.
- **DeepSeek Harness: Restart** — restart it.
- **DeepSeek Harness: Show Logs** — show `npx` / Harness output.

## Settings

| Setting | Default | Purpose |
|---|---:|---|
| `deepseekHarness.port` | `3080` | Harness Web UI port on the workspace host |
| `deepseekHarness.npxPath` | `npx` | `npx` executable on the local/remote workspace host |
| `deepseekHarness.startupTimeoutMs` | `120000` | How long to wait for first startup |

The first launch can take longer because `npx` may need to download the Harness package.

## DeepSeek API configuration

API keys, models, sessions, tools, approvals, skills, and other agent settings belong to the **official DeepSeek Harness UI**. This VS Code extension intentionally does not duplicate them.

## Port forwarding and security

Harness remains on the workspace host at:

```text
127.0.0.1:<port>
```

The extension asks VS Code to produce an externally reachable URI for that address using `vscode.env.asExternalUri`. In a Remote SSH session, VS Code handles the tunnel between the remote host and your local client.

You do not need to expose port 3080 publicly on the Linux server.

## Existing Harness process

If the configured port is already listening when the extension starts, the extension reuses that service rather than launching a duplicate process.

For safety, **Stop** only terminates a process owned by this extension. It will not kill an unknown process that was already listening on the configured port.

## Development

```bash
git clone https://github.com/plutoczm/deepseek-harness-vscode.git
cd deepseek-harness-vscode
npm install
npm run compile
npm run package
```

`npm run package` creates:

```text
deepseek-harness-vscode.vsix
```

Press `F5` to launch an Extension Development Host.

## Upstream

- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness
- Harness homepage: https://deepseek.com/harness

This project is an independent VS Code integration and is not an official DeepSeek AI product.

## License

MIT
