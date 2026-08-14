# DeepSeek Harness Remote

Run the **official DeepSeek Harness** on a remote Linux server over SSH, while controlling it from a small local browser launcher. VS Code is no longer required for the remote workflow.

This repository still contains the previously published VS Code extension, but the recommended path is now the standalone app in [`remote/`](./remote/).

## What it does

```text
Local browser
    │
    ▼
DeepSeek Harness Remote (127.0.0.1 only)
    │
    ├── reads ~/.ssh/config
    ├── lets you choose an SSH host
    ├── lets you browse/select a remote workspace
    ├── checks remote Node/Python/Conda
    ├── installs a private Node 22 runtime when needed (no sudo)
    └── opens an SSH local port-forward
             │
             ▼
      Remote Linux server
             │
             └── official @deepseek-ai/dsh --profile web
                    │
                    ├── remote files / Git / Bash / Python
                    └── per-Harness-session Python environment picker
```

Harness itself runs **on the selected remote host**, so its Bash, Git and filesystem operations naturally target that server. The launcher does not reimplement the agent or its coding tools.

## Quick start

Local requirements:

- Node.js 20+ on the computer running the launcher.
- OpenSSH `ssh` and `scp` available on PATH.
- SSH key/agent authentication that already works with `ssh <alias>`.

Then:

```bash
git clone https://github.com/plutoczm/deepseek-harness-vscode.git
cd deepseek-harness-vscode
npm run remote
```

Or:

```bash
cd remote
npm start
```

The launcher opens:

```text
http://127.0.0.1:4173
```

1. Choose or type an SSH alias such as `GDWYY70`.
2. Click **Check**.
3. Choose/browse the remote workspace.
4. Click **Connect & Open Harness**.
5. The official DeepSeek Harness Web UI opens through the SSH tunnel.

The server list is populated from concrete `Host` entries in `~/.ssh/config`. You can also type any alias that your system `ssh` command understands.

## Remote Node runtime

Current DeepSeek Harness dependencies require a modern Node runtime. If the remote system Node is too old, the launcher can install a private Node 22 runtime under:

```text
~/.deepseek-harness-remote/runtime/node
```

This does **not** require root access and does not replace the server's system Node installation. The private runtime is used only by Harness Remote launches.

## Per-session Conda / venv selection

The bundled Harness plugin binds an environment choice to the official Harness `DSH_SESSION_ID`.

On the **first Bash action of each root Harness session**, the official Harness Web UI presents a native single-choice question such as:

```text
Python Environment

○ Harness default
○ .venv
○ venv
○ conda: base
○ conda: face_privacy_tkde
○ conda: pytorch
```

A custom environment directory can also be entered. The choice applies only to that Harness session. Subagents inherit their parent's environment.

You can change or inspect it later with:

```text
/env
/env status
/env system
/env conda: pytorch
/env /absolute/path/to/venv
```

Harness Bash calls are fresh `bash -c` processes, so the plugin does not depend on a one-time `conda activate`. Instead it writes a small session-specific activation fragment and loads it through `BASH_ENV` for every Bash call.

Environment state is stored remotely under:

```text
~/.deepseek-harness-remote/session-env
```

## Remote files created

The launcher uses only the current user's home directory:

```text
~/.deepseek-harness-remote/
├── runtime/node/       # optional private Node 22
├── plugin/             # Harness session-env plugin
└── session-env/        # per-session environment state
```

It also places the plugin package in the user's normal Harness module-resolution location under `$DSH_HOME` (default `~/.dsh`).

## Security model

- The control UI binds to `127.0.0.1`, not the LAN.
- SSH authentication is delegated to the system OpenSSH client and `~/.ssh/config`.
- The launcher does not store SSH private keys.
- Harness Web traffic is exposed locally only through `ssh -L`.
- Remote commands run with the permissions of the SSH user you selected.

## Current scope

The standalone path currently targets Linux remote hosts with Bash. SSH password prompts are intentionally not embedded in the browser UI; configure key/agent authentication first. If the remote system Node is too old, downloading the private runtime requires access to `nodejs.org` from that server.

The environment chooser is a native Harness question shown on first Bash use, plus `/env`. A permanent environment dropdown in the Harness header would require a deeper Web UI patch and is intentionally deferred to keep compatibility with upstream Harness.

## Development

```bash
cd remote
npm run check
npm test
npm start
```

The standalone app uses Node built-ins only; there are currently no third-party runtime dependencies.

## Legacy VS Code extension

The existing Marketplace extension remains in this repository for users who want the VS Code workflow:

```text
plutoczm.deepseek-harness-vscode-plutoczm
```

The standalone `remote/` app is the recommended architecture for SSH-host selection and remote Harness execution because it avoids VS Code Server, Remote Extension Host and file-watcher lifecycle coupling.

## License

MIT
