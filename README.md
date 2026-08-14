# DeepSeek Harness Remote

Run the **official DeepSeek Harness** on a remote Linux server over SSH from a dedicated desktop application. VS Code is no longer required for the remote workflow, and normal users do not need to start the launcher from a terminal.

This repository still contains the previously published VS Code extension, but the recommended path is the desktop app in [`remote/`](./remote/).

## What it does

```text
DeepSeek Harness Remote desktop app
    │
    ├── reads ~/.ssh/config
    ├── lets you choose an SSH host
    ├── browses remote directories and files
    ├── previews text and common images
    ├── lets you choose a remote workspace
    ├── checks remote Node/Python/Conda
    ├── installs a private Node 22 runtime when needed (no sudo)
    ├── optionally bridges Bash/Git/web traffic through local 127.0.0.1:7890
    └── opens an SSH local port-forward
             │
             ▼
      Remote Linux server
             │
             └── official @deepseek-ai/dsh --profile web
                    │
                    ├── remote files / Git / Bash / Python
                    ├── per-Harness-session Python environment picker
                    └── DeepSeek model traffic stays on the remote network
```

Harness itself runs **on the selected remote host**, so its Bash, Git and filesystem operations naturally target that server. The launcher does not reimplement the agent or its coding tools.

## Windows desktop app

The primary distribution target is a Windows x64 installer:

```text
DeepSeek-Harness-Remote-0.3.0-Setup-x64.exe
```

After installation, launch **DeepSeek Harness Remote** from the desktop shortcut or Start menu. The app starts its local control service internally and opens the launcher UI inside the desktop window. No `npm run remote`, PowerShell window, or local browser tab is required for normal use.

The desktop app still delegates SSH authentication to the system OpenSSH client, so an existing command such as:

```text
ssh GDWYY70
```

should already work with key/agent authentication.

Inside the app:

1. Choose or type an SSH alias such as `GDWYY70`.
2. Click **检查连接**.
3. Choose the remote workspace using the collapsible directory picker or the **远程文件** page.
4. Click **连接并打开 Harness**.
5. The official DeepSeek Harness Web UI opens in its own application window through the SSH tunnel.

The server list is populated from concrete `Host` entries in `~/.ssh/config`. You can also type any alias that your system `ssh` command understands.

## Local VPN / proxy bridge

Version 0.3.0 can automatically detect a local HTTP/mixed proxy on:

```text
127.0.0.1:7890
```

This matches the common local proxy endpoint used by VPN/proxy clients such as Clash-style configurations. The host and port can also be overridden for development with:

```text
DSH_LOCAL_PROXY_HOST
DSH_LOCAL_PROXY_PORT
```

When the local proxy is reachable, the desktop app opens a dedicated SSH reverse-forward and exposes that proxy on an ephemeral loopback port on the selected remote host.

The important routing rule is deliberately selective:

```text
DeepSeek Harness model/API traffic
    -> remote server network directly

Harness Bash / Git / curl / wget / Python subprocess traffic
    -> BASH_ENV
    -> remote loopback proxy port
    -> SSH reverse-forward
    -> local 127.0.0.1:7890
    -> local VPN / proxy egress
```

The desktop app does **not** set `HTTP_PROXY` or `HTTPS_PROXY` on the Harness process itself. Proxy variables are injected only into Bash/tool subprocesses through the bundled `BASH_ENV` bootstrap. `NO_PROXY` explicitly includes `api.deepseek.com` and `.deepseek.com` as an additional guard.

This is intended to solve cases where the remote server can run DeepSeek normally but cannot reach GitHub or other external research sites. For example, `git push`, `curl`, `wget`, Python `requests`, and similar subprocesses can use the local VPN path without forcing DeepSeek model calls through the VPN.

If `127.0.0.1:7890` is unavailable, the launcher falls back to the remote server's normal network and records that decision in the instance log.

## Live DeepSeek API balance / spend overlay

Desktop Harness windows include a small live DeepSeek API widget. The launcher samples the official DeepSeek `/user/balance` endpoint from the **remote login environment**, so the API-key request follows the remote server's normal network path rather than the local VPN bridge.

The widget shows:

- current DeepSeek account balance (CNY and/or USD as returned by the API),
- approximate balance decrease since that Harness instance started,
- a 10-second refresh cadence.

The balance endpoint requires `DEEPSEEK_API_KEY` to be available in the remote login shell. The key is never rendered into the desktop page or written to launcher logs.

The per-instance spend figure is deliberately labelled approximate: it is derived from the account-level balance decrease between the instance baseline and the latest sample. If the same API key is used concurrently by another Harness instance or another application, those charges also affect the balance delta.

## Remote file browser

The desktop app includes a read-only remote server explorer using the permissions of the selected SSH user.

- Browse arbitrary accessible directories.
- Search/filter the current directory client-side.
- Jump to `/`, the SSH user's home directory, or the current Harness workspace.
- Preview text files up to the first 1 MiB.
- Preview PNG/JPEG/GIF/WebP/BMP images up to 15 MiB.
- Copy remote file paths.
- Set the current directory as the Harness workspace with one click.
- Large/binary files are shown as metadata rather than transferred into the UI.

The browser does not bypass server permissions and does not modify remote files. Code edits remain the responsibility of official Harness.

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
└── session-env/        # per-session environment + per-instance network state
```

It also places the plugin package in the user's normal Harness module-resolution location under `$DSH_HOME` (default `~/.dsh`).

## Security model

- The local control service binds to `127.0.0.1`, not the LAN.
- The Electron renderer uses sandboxing, context isolation and no Node integration.
- SSH authentication is delegated to the system OpenSSH client and `~/.ssh/config`.
- The launcher does not store SSH private keys.
- Harness Web traffic is exposed locally only through `ssh -L`.
- The optional VPN/proxy bridge is exposed to the remote host only through an SSH reverse-forward bound to remote loopback.
- DeepSeek model traffic is not globally assigned the local VPN proxy.
- Remote commands run with the permissions of the SSH user you selected.
- Unexpected non-local application window navigation is blocked; normal HTTPS links open externally.

## Current scope

The remote execution path currently targets Linux SSH hosts with Bash. SSH password prompts are intentionally not embedded in the application; configure key/agent authentication first. If the remote system Node is too old, downloading the private runtime requires access to `nodejs.org` from that server.

The environment chooser is a native Harness question shown on first Bash use, plus `/env`. A permanent environment dropdown in the Harness header would require a deeper Web UI patch and is intentionally deferred to keep compatibility with upstream Harness.

The local VPN bridge currently probes an HTTP/mixed proxy endpoint. A SOCKS-only endpoint that does not accept HTTP `CONNECT` is treated as unavailable rather than silently changing DeepSeek routing.

## Development

The terminal workflow remains available for contributors and debugging only:

```bash
cd remote
npm install
npm run check
npm test
npm run desktop
```

Build the Windows installer with:

```bash
npm run desktop:win
```

GitHub Actions also builds the Windows x64 installer and uploads it as the `DeepSeek-Harness-Remote-Windows-x64` workflow artifact.

## Branding

The desktop launcher uses its own monochrome whale mark and a DeepSeek Harness-inspired interface. It is a community remote launcher and is not affiliated with or endorsed by DeepSeek. DeepSeek Harness itself remains the official upstream runtime launched on the selected server.

## Legacy VS Code extension

The existing Marketplace extension remains in this repository for users who want the VS Code workflow:

```text
plutoczm.deepseek-harness-vscode-plutoczm
```

The desktop `remote/` app is the recommended architecture for SSH-host selection and remote Harness execution because it avoids VS Code Server, Remote Extension Host and file-watcher lifecycle coupling.

## License

MIT
