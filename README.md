# dsh-openssh-vpn

A focused DeepSeek Harness plugin for **native OpenSSH remote operations**, **Windows VPN/proxy reuse**, and a **real SSH Web panel inside Harness**.

> If `ssh <alias>` works for the Windows account running Harness, the plugin uses that same `ssh.exe`, the same `~/.ssh/config`, key selection, ProxyJump/ProxyCommand rules, known_hosts and RemoteForward configuration.

There is no second Node `ssh2` credential stack and no `sshRemote` provider dependency.

## What it provides

### Harness Web UI (v0.3+)

The Web client adds a usable **SSH** entry in the Harness sidebar. If another plugin already created an `SSH` sidebar entry, `dsh-openssh-vpn` can take over that click and open its own panel instead of leaving an empty page.

The panel includes:

- SSH aliases discovered from `%USERPROFILE%\.ssh\config`;
- effective target/user/port/IdentityFile information from `ssh -G`;
- route / source / local proxy / RemoteForward / managed-tunnel status;
- AUTO / DIRECT / PROXY mode switching;
- refresh controls;
- a terminal-style remote command runner with stdout/stderr and exit code;
- quick commands such as `pwd`, `ls -la`, `git status` and `uname -a`;
- a Settings → Plugins → SSH tab as a second entry point.

The browser never receives private-key contents. Commands are sent to a same-origin host API and executed through the existing native OpenSSH engine.

### Harness agent tools

- `openssh_list` — concrete aliases discovered from `%USERPROFILE%\.ssh\config`, resolved with the real `ssh -G`.
- `openssh_exec` — remote command execution through system OpenSSH.
- `openssh_proxy_status` — direct/proxy route diagnostics and refresh.
- `openssh_upload` / `openssh_download` — file transfer through system `scp`.

The package is a normal `dsh.bundle` and declares a `dsh.client` Web module, so one package provides both the host-side OpenSSH engine and the Harness UI.

## Install from the DSH Plugin Workshop

This repository is a standard bundle plugin and can be installed with:

```cmd
npx @deepseek-ai/dsh plugin --profile web add "github:plutoczm/deepseek-harness-vscode#main"
```

For the Plugin Workshop's default **插件话题** search, the GitHub repository must have the topic:

```text
dsh-plugin
```

The package also exposes `dsh.bundle.patch` and `dsh.client`, so the workshop can identify it as an installable DSH bundle.

After install/update, restart:

```cmd
npx @deepseek-ai/dsh web
```

Then click **SSH** in the left sidebar.

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
3. If direct access fails, validate the Windows HTTP/mixed proxy at `127.0.0.1:7890`.
4. If a healthy managed tunnel is already owned by this plugin, preserve it.
5. Otherwise, if the configured RemoteForward is already live (for example VS Code owns `35052`), reuse it without killing it.
6. If the configured RemoteForward exists but is absent, start a dedicated native OpenSSH `-N` owner.
7. If no matching RemoteForward exists, use a verified loopback fallback at `17890+`.

All ordinary command/probe SSH calls include:

```text
-o ClearAllForwardings=yes
```

so short-lived commands never try to bind the configured RemoteForward again.

## Proxy environment

When proxy routing is active, `openssh_exec` prefixes the remote command with:

```text
HTTP_PROXY=http://127.0.0.1:<remote-port>
HTTPS_PROXY=http://127.0.0.1:<remote-port>
ALL_PROXY=http://127.0.0.1:<remote-port>
```

Upper- and lower-case forms are both exported. Default `NO_PROXY` includes DeepSeek domains and loopback addresses.

## Requirements

- Node 22+ / current DeepSeek Harness.
- Windows OpenSSH `ssh.exe` and `scp.exe` on PATH.
- A working OpenSSH alias, e.g. `ssh gdwyy70`.
- For VPN fallback, an HTTP or mixed proxy on Windows `127.0.0.1:7890`.

No remote Python helper is required.

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

`auto` is recommended for normal use. The Web panel can switch the active mode at runtime.

## Reference acceptance machine

```text
alias: gdwyy70
resolved target: czm2025@172.23.207.70:22
authenticated key: C:\Users\Admin1\.ssh\id_rsa
configured RemoteForward: remote 35052 -> Windows 127.0.0.1:7890
remote project: /mnt/ext-disk/czm2025/Projects/face_privacy_tkde
```

Real-machine acceptance has verified a Harness-managed `35052 -> 7890` route and a successful:

```text
cd /mnt/ext-disk/czm2025/Projects/face_privacy_tkde && git ls-remote origin HEAD
```

## Security boundary

- Private keys are not copied into plugin settings or a second credential store.
- Authentication is delegated to the installed system OpenSSH client.
- Existing external tunnels are never killed by the route manager.
- Harness-managed reverse listeners bind to remote loopback.
- The Web API is same-origin and requires a custom request header.
- The plugin never reads or exports the DeepSeek API key.
- No weakening of pnpm supply-chain policy is required.

## Version status

- `0.2.4`: accepted native OpenSSH + Windows VPN routing core.
- `0.3.0`: adds the Harness Web SSH panel and Plugin Workshop-ready client declaration.
