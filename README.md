# DeepSeek Harness Remote

Run the **official DeepSeek Harness** on a remote Linux server over SSH from a dedicated Windows desktop application. VS Code is not required for the recommended workflow, and normal users do not need to start the launcher from a terminal.

The repository still contains the previously published VS Code extension, but the desktop app in [`remote/`](./remote/) is the recommended path.

## Architecture

```text
DeepSeek Harness Remote desktop app
    │
    ├── reads ~/.ssh/config
    ├── selects an SSH host and remote workspace
    ├── browses and previews remote files
    ├── checks remote Node / Python / Conda
    ├── optionally installs a private Node 22 runtime (no sudo)
    └── opens an SSH local port-forward
             │
             ▼
      Remote Linux server
             │
             └── official @deepseek-ai/dsh --profile web
                    │
                    ├── native Harness tools / web_search / Git / Bash
                    ├── per-Harness-session Python environment picker
                    └── event-driven token/cost observer
```

Harness itself runs on the selected remote host, so its filesystem, Git, Bash and Python operations naturally target that server. The launcher does not reimplement the agent or its coding tools.

## Windows desktop app

The primary distribution target is a Windows x64 NSIS installer:

```text
DeepSeek-Harness-Remote-0.4.0-Setup-x64.exe
```

After installation, launch **DeepSeek Harness Remote** from the desktop shortcut or Start menu. The app starts its loopback control service internally and opens both the launcher and Harness in desktop windows. No PowerShell, `npm run remote`, or manual localhost tab is required for normal use.

SSH authentication is delegated to the system OpenSSH client. An existing command such as:

```text
ssh my-server
```

should already work with key/agent authentication.

Typical flow:

1. Choose or type an SSH alias.
2. Click **检查连接**.
3. Pick a remote workspace from the collapsible directory browser or **远程文件** page.
4. Click **连接并打开 Harness**.
5. The official Harness Web UI opens through the SSH tunnel.

Concrete `Host` aliases from `~/.ssh/config` populate the server list, but any alias understood by the system `ssh` command can be entered manually.

## Event-driven DeepSeek token and cost display

Version 0.4.0 no longer polls DeepSeek `/user/balance`.

The bundled Harness usage observer wraps the official `llm/stream` extension seam. When the provider emits Harness's canonical `usage` chunk, the observer forwards that usage event over the already-open Harness SSH stdout channel. The desktop process consumes the marker locally and updates the Harness cost widget immediately.

```text
provider response
    ↓
Harness StreamChunk { type: "usage" }
    ↓
remote usage observer
    ↓ existing SSH stdout
local HarnessManager
    ↓ in-process event
Electron Harness window
```

There is no fixed 10-second timer and no balance-endpoint request. The update boundary is the same provider-usage boundary that feeds Harness's own token accounting.

The widget shows the most recently active Harness session within that remote Harness instance:

```text
DeepSeek API                       ● 实时事件

当前会话消耗                      ¥0.001284
Input  24.8K   Output  1.4K   Cache  91%
DeepSeek-V4-Flash · 本次 ¥0.000143 · 7 次 usage
```

Accounting uses the same disjoint buckets as Harness:

```text
billed input = uncached input + cache reads + cache writes
cache hit %  = cache reads / billed input
```

Cost is computed locally from the provider-reported token buckets. The 0.4.0 bundled CNY price table follows the DeepSeek V4 public pricing available at release time:

| Model | Cache hit / 1M | Cache miss / 1M | Output / 1M |
|---|---:|---:|---:|
| `deepseek-v4-flash` | ¥0.02 | ¥1 | ¥2 |
| `deepseek-v4-pro` | ¥0.025 | ¥3 | ¥6 |

Unknown/custom model ids keep showing exact token telemetry but are marked **unpriced** rather than silently applying the wrong rate. When DeepSeek changes model pricing, this local table should be updated in a new app release.

The observer excludes auxiliary Harness calls that carry a `purpose` such as session-title/compaction so the displayed conversation usage stays aligned with the native conversation stats semantics.

## Network behavior and optional local proxy fallback

The default network mode is deliberately simple:

```text
Harness / DeepSeek API / web_search / Git / Bash
    -> remote server network directly
```

The launcher does **not** automatically probe or use the local VPN/proxy.

If a remote server later loses access to GitHub or other external sites, expand **高级网络** before launching a new instance and explicitly enable:

```text
网络故障时使用本机代理 127.0.0.1:7890
```

Only then does the app create the optional SSH reverse proxy bridge for Bash/tool subprocess traffic. The option applies to that newly launched Harness instance only. DeepSeek model traffic is not globally assigned the local proxy.

The development overrides remain available:

```text
DSH_LOCAL_PROXY_HOST
DSH_LOCAL_PROXY_PORT
```

The fallback currently expects an HTTP/mixed proxy that accepts HTTP `CONNECT`; a SOCKS-only endpoint is treated as unavailable rather than silently changing model routing.

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

Current Harness dependencies require a modern Node runtime. If the remote system Node is too old, the launcher can install a private Node 22 runtime under:

```text
~/.deepseek-harness-remote/runtime/node
```

This does not require root access and does not replace the server's system Node installation. The private runtime is used only by Harness Remote launches.

## Per-session Conda / venv selection

The bundled session-environment plugin binds an environment choice to the official Harness `DSH_SESSION_ID`.

On the first Bash action of each root Harness session, the native Harness Web UI presents a single-choice question such as:

```text
Python Environment

○ Harness default
○ .venv
○ venv
○ conda: base
○ conda: project-env
```

The choice applies only to that Harness session, and subagents inherit the parent selection. A custom virtual-environment path can also be selected through `/env`.

Useful commands:

```text
/env
/env status
/env system
/env conda: project-env
/env /absolute/path/to/venv
```

Harness Bash calls are fresh `bash -c` processes, so the plugin writes a small session-specific activation fragment and loads it through `BASH_ENV` for every Bash call instead of relying on one long-lived `conda activate` shell.

Environment state is stored remotely under:

```text
~/.deepseek-harness-remote/session-env
```

## Remote files created

The launcher uses the current SSH user's home directory:

```text
~/.deepseek-harness-remote/
├── runtime/node/       # optional private Node 22
├── plugin/             # session-env + usage observer deployment files
├── session-env/        # per-session environment + optional network state
└── logs/
```

The plugin packages are also copied into the user's normal Harness module-resolution directory under `$DSH_HOME` (default `~/.dsh`).

## Security model

- The local control service binds to `127.0.0.1`, not the LAN.
- Electron renderers use sandboxing, context isolation and no Node integration.
- SSH authentication is delegated to the system OpenSSH client and `~/.ssh/config`.
- The launcher does not store SSH private keys.
- Harness Web traffic is exposed locally only through `ssh -L`.
- The optional VPN/proxy bridge is disabled by default and is enabled only per requested instance.
- The usage observer forwards token counts/model ids/session ids only; it does not forward the DeepSeek API key or prompt/response content.
- No `/user/balance` polling is performed by the 0.4.0 cost display.
- Remote commands run with the permissions of the selected SSH user.
- Unexpected non-local application-window navigation is blocked; normal HTTPS links open externally.

## Current scope

The remote execution path targets Linux SSH hosts with Bash. Embedded SSH password prompts are intentionally not supported; configure key/agent authentication first. If the remote system Node is too old, private-runtime installation requires that server to reach `nodejs.org`.

The cost widget is event-driven and session-aware, but the desktop overlay follows the **most recently active usage-producing session** inside a Harness instance. Switching to an old idle session does not synthesize a new usage event; the next model request from that session makes it current immediately.

## Development

The terminal workflow remains available for contributors and debugging:

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

GitHub Actions builds the Windows x64 installer and uploads it as the `DeepSeek-Harness-Remote-Windows-x64` workflow artifact.

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
