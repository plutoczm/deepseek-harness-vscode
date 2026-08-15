# dsh-openssh-vpn

A DeepSeek Harness plugin for **native OpenSSH remote operations**, **Windows VPN/proxy reuse**, a **real SSH Web panel**, and **SSH-backed Harness workspaces**.

> If `ssh <alias>` works for the Windows account running Harness, the plugin uses that same `ssh.exe`, the same `~/.ssh/config`, key selection, ProxyJump/ProxyCommand rules, known_hosts and RemoteForward configuration.

There is no second Node `ssh2` credential stack and no `sshRemote` provider dependency.

## What it provides

### Harness Web SSH UI

The Web client adds a usable **SSH** entry in the Harness sidebar. If another plugin already created an `SSH` sidebar entry, `dsh-openssh-vpn` can take over that click and open its own panel instead of leaving an empty page.

The panel includes:

- SSH aliases discovered from `%USERPROFILE%\.ssh\config`;
- effective target/user/port/IdentityFile information from `ssh -G`;
- route / source / local proxy / RemoteForward / managed-tunnel status;
- AUTO / DIRECT / PROXY mode switching;
- a terminal-style remote command runner with stdout/stderr and exit code;
- a **远程工作区** control that registers an SSH project as a native Harness Workspace;
- a Settings → Plugins → SSH tab as a second entry point.

The browser never receives private-key contents. Commands are sent to a same-origin host API and executed through the existing native OpenSSH engine.

### SSH-backed Harness Workspace

Harness runs locally on Windows, so its Workspace Registry requires a real Windows directory and cannot directly register a Linux path such as:

```text
gdwyy70:/mnt/ext-disk/czm2025/Projects/face_privacy_tkde
```

The plugin therefore creates a tiny local **workspace anchor** under the Harness home. That anchor contains only SSH mapping metadata; the remote project is **not copied or mirrored to Windows**. Harness registers the anchor as an ordinary Workspace and the plugin renames it to a friendly title such as:

```text
face_privacy_tkde · gdwyy70
```

The workspace's sessions use the generated `openssh-remote` agent preset. Its model-facing coding tools operate on the real remote directory:

- `bash` — remote bash command execution;
- `read` — remote UTF-8 file reads;
- `write` — remote file create/replace;
- `edit` — exact remote text replacement;
- `glob` — remote path search;
- `grep` — remote content search.

The remote preset intentionally does **not** mount Harness' normal Windows-local filesystem or PowerShell coding tools, so the local anchor cannot be mistaken for project contents. The plugin also hooks Harness' native workspace `session.create({ workspaceId })` path: using the normal **New Session / +** UI inside a remote workspace keeps `agentPreset=openssh-remote` instead of silently falling back to the local standard preset.

To open the reference project, select `gdwyy70` in the SSH panel, keep or enter:

```text
/mnt/ext-disk/czm2025/Projects/face_privacy_tkde
```

and click **添加到 Harness 工作区**. The plugin validates the remote directory, registers/renames the official Workspace, creates or reuses a blank remote session, refreshes Harness' native workspace list, and opens the session.

### Harness agent tools

- `openssh_list` — concrete aliases discovered from `%USERPROFILE%\.ssh\config`, resolved with the real `ssh -G`.
- `openssh_exec` — remote command execution through system OpenSSH.
- `openssh_proxy_status` — direct/proxy route diagnostics and refresh.
- `openssh_upload` / `openssh_download` — file transfer through system `scp`.

## Why system OpenSSH

Windows OpenSSH already handles the difficult compatibility surface correctly:

- default IdentityFile selection;
- encrypted/private key handling supported by the user's actual setup;
- Include / Match;
- ProxyJump / ProxyCommand;
- known_hosts;
- RemoteForward;
- Windows-specific OpenSSH behavior.

The plugin asks OpenSSH for the effective configuration using `ssh -G <alias>` instead of re-parsing those semantics itself.

## VS Code RemoteForward reuse

A common setup is:

```text
remote 127.0.0.1:35052
        |
        | SSH RemoteForward owned by VS Code or Harness
        v
Windows 127.0.0.1:7890
        |
        v
       VPN
```

For example, `ssh -G gdwyy70` may contain:

```text
remoteforward 35052 [127.0.0.1]:7890
```

The proxy policy is:

1. In `auto` mode, probe GitHub directly from the remote host.
2. If direct access works, use the server network.
3. Otherwise verify the Windows HTTP/mixed proxy at `127.0.0.1:7890`.
4. If `ssh -G` exposes a matching RemoteForward, probe its remote listen port.
5. If it is already live, reuse it and do not create or kill that external tunnel.
6. If configured but not live, start a dedicated native OpenSSH `-N` owner.
7. If no matching RemoteForward exists, use a verified loopback fallback port from `17890+`.

On Windows corporate VPN stacks such as the reference aTrustVNIC environment, several back-to-back new SSH handshakes can be reset during banner/KEX. The current status path therefore combines **SSH baseline + direct GitHub + configured-proxy** checks inside one authenticated SSH shell, with only a limited delayed retry on transport failure.

All ordinary command/probe SSH calls include:

```text
-o ClearAllForwardings=yes
```

so a short-lived Harness command never tries to bind the same configured RemoteForward again and never fights VS Code for `35052`.

## Proxy environment

When proxy routing is active, `openssh_exec` and remote-workspace bash commands receive HTTP/HTTPS/ALL proxy variables pointing at the active remote loopback forward. Upper- and lower-case forms are exported. Default `NO_PROXY` includes DeepSeek domains and loopback addresses.

## Requirements

- Node 22+ / current DeepSeek Harness.
- Windows OpenSSH `ssh.exe` and `scp.exe` on PATH.
- A working OpenSSH alias such as `ssh gdwyy70`.
- For VPN fallback, an HTTP or mixed proxy on Windows `127.0.0.1:7890`.

No remote Python/helper daemon is required.

## Install

After a release is merged to `main`:

```cmd
npx @deepseek-ai/dsh plugin --profile web add "github:plutoczm/deepseek-harness-vscode#main"
```

During acceptance testing, install the exact commit supplied in PR #28 and restart `dsh web`.

For plugin-workshop's default catalog, the GitHub repository itself must carry the **`dsh-plugin` Topic**. A package.json keyword does not substitute for the GitHub repository Topic.

## Environment options

```text
DSH_SSH_PROXY_MODE=auto          # auto | direct | proxy
DSH_SSH_PROXY_HOST=127.0.0.1
DSH_SSH_PROXY_PORT=7890
DSH_SSH_PROXY_REMOTE_PORT=17890
DSH_SSH_PROXY_HEALTH_INTERVAL_MS=60000
DSH_SSH_PROXY_NO_PROXY=api.deepseek.com,.deepseek.com,127.0.0.1,localhost,::1
DSH_SSH_ALIASES=gdwyy70,gpu02
```

`auto` is recommended.

## Reference acceptance target

```text
alias: gdwyy70
resolved target: czm2025@172.23.207.70:22
authenticated key: C:\Users\Admin1\.ssh\id_rsa
configured RemoteForward: remote 35052 -> Windows 127.0.0.1:7890
remote project: /mnt/ext-disk/czm2025/Projects/face_privacy_tkde
```

The native OpenSSH/VPN core has already passed real-machine acceptance, including `git ls-remote origin HEAD` from that real project through Harness.

## Security boundary

- Private keys are not copied into plugin settings or a second credential store.
- Authentication is delegated to installed system OpenSSH.
- Existing external tunnels are never killed by the plugin.
- Harness-managed reverse listeners bind to remote loopback.
- Remote Workspace anchors contain mapping metadata, not a project checkout.
- Remote file tools reject paths that escape the mapped project root.
- The plugin never reads or exports the DeepSeek API key.
- No weakening of pnpm supply-chain policy is required.

## Status

`0.4.x` is the Web SSH + Remote Workspace line. CI covers Node 22/24, Windows OpenSSH presence, combined one-session route probing, remote-workspace registration/preset generation, native new-session remote routing, package creation, and clean-profile official Harness boot.
