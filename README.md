# dsh-openssh-vpn

A focused DeepSeek Harness plugin for **native OpenSSH remote operations** and **Windows VPN/proxy reuse**.

The invariant is simple:

> If `ssh <alias>` works for the Windows account running Harness, the plugin uses that same `ssh.exe`, the same `~/.ssh/config`, the same key selection, ProxyJump/ProxyCommand rules, known_hosts and RemoteForward configuration.

There is no second Node `ssh2` credential stack and no `sshRemote` provider dependency.

## What it provides

Harness agent tools:

- `openssh_list` — concrete aliases discovered from `%USERPROFILE%\.ssh\config`, resolved with the real `ssh -G`.
- `openssh_exec` — remote command execution through system OpenSSH.
- `openssh_proxy_status` — direct/proxy route diagnostics and refresh.
- `openssh_upload` / `openssh_download` — file transfer through system `scp`.

The package is a normal `dsh.bundle` and boots as a standalone Web-profile plugin.

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
        | SSH RemoteForward owned by VS Code
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

The plugin's proxy policy is:

1. In `auto` mode, probe GitHub directly from the remote host.
2. If direct access works, use the server network.
3. If direct access fails, probe the Windows HTTP/mixed proxy at `127.0.0.1:7890`.
4. If `ssh -G` exposes a matching RemoteForward, probe its remote listen port first.
5. If that port is already live (for example VS Code owns `35052`), **reuse it and do not create or kill any tunnel**.
6. If the configured RemoteForward exists but is not live, start a dedicated OpenSSH `-N` process so the configured forward becomes live.
7. If no matching RemoteForward exists, create a fallback reverse forward on `127.0.0.1:17890+`.

All ordinary command/probe SSH calls include:

```text
-o ClearAllForwardings=yes
```

so a short-lived Harness command never tries to bind the same configured RemoteForward again and never fights VS Code for `35052`.

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
- A working OpenSSH alias, e.g.:

```cmd
ssh gdwyy70
```

- For VPN fallback, an HTTP or mixed proxy on Windows `127.0.0.1:7890`.

No remote Python helper is required in v0.2.0.

## Install development build

Use an exact commit during acceptance testing:

```cmd
npx @deepseek-ai/dsh plugin --profile web add "github:plutoczm/deepseek-harness-vscode#<commit-sha>"
```

Then:

```cmd
npx @deepseek-ai/dsh web
```

Because the tools are named `openssh_*`, this development build can coexist with `@captain1275/dsh-ssh` while testing. The final single-provider cleanup can remove the older plugin after native OpenSSH acceptance.

## Environment options

```text
DSH_SSH_PROXY_MODE=auto          # auto | direct | proxy
DSH_SSH_PROXY_HOST=127.0.0.1
DSH_SSH_PROXY_PORT=7890
DSH_SSH_PROXY_REMOTE_PORT=17890
DSH_SSH_PROXY_HEALTH_INTERVAL_MS=60000
DSH_SSH_PROXY_NO_PROXY=api.deepseek.com,.deepseek.com,127.0.0.1,localhost,::1
DSH_SSH_ALIASES=gdwyy70,gpu02    # optional aliases not discoverable from the main config file
```

`auto` is recommended.

## Real acceptance target

For the current reference machine:

```text
alias: gdwyy70
resolved target: czm2025@172.23.207.70:22
authenticated key: C:\Users\Admin1\.ssh\id_rsa
configured RemoteForward: remote 35052 -> Windows 127.0.0.1:7890
remote project: /mnt/ext-disk/czm2025/Projects/face_privacy_tkde
```

The already-observed external tunnel successfully returned GitHub HTTP 200 and `git ls-remote origin HEAD` through `127.0.0.1:35052`.

See `WINDOWS-TEST.md` for the next packaged-plugin acceptance run.

## Security boundary

- Private keys are not copied into plugin settings or a second JSON credential store.
- Authentication is delegated to the installed system OpenSSH client.
- Existing external tunnels are never killed by the plugin.
- Harness-managed reverse listeners bind to remote loopback.
- The plugin never reads or exports the DeepSeek API key.
- No weakening of pnpm `blockExoticSubdeps` / supply-chain policy is required.

## Status

`0.2.0` is the standalone OpenSSH core. CI covers Node 22/24, pure route-policy tests, Windows OpenSSH presence, package creation, and clean-profile official Harness boot without any secondary SSH provider.
