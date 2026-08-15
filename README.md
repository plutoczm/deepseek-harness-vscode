# dsh-ssh-vpn-bridge

A focused DeepSeek Harness plugin for two problems only:

1. **SSH remote workspaces that reuse the OpenSSH configuration you already know works.**
2. **Windows VPN / local proxy bridging to the remote host**, so remote Git, curl and wget can fall back to `127.0.0.1:7890` when the server cannot reach GitHub reliably.

It deliberately does not try to be a desktop IDE, plugin marketplace, MCP manager, Git GUI, or model wrapper.

## Core rule: one SSH identity path

If this works in Windows Terminal:

```powershell
ssh gdwyy70
```

Harness should use the same OpenSSH identity/configuration path instead of asking you to re-enter host, username, private key or ProxyJump in a second SSH stack.

The bundled `dsh-ssh-remote` dependency supplies the mature Harness UI, SSH alias discovery, workspace anchors and routing model. This bridge replaces its actual remote transport with the **system `ssh` executable** for directory browsing, file reads/writes, explicit remote commands and persistent terminal shells. That avoids the common Windows failure where OpenSSH can authenticate through the Windows agent or an encrypted key but a separate Node `ssh2` client cannot.

Remote file metadata/list/read/write operations are executed through system OpenSSH and a small Python helper on the remote host. No remote source tree is copied locally.

## Important: use one SSH workspace provider

Do **not** keep another SSH workspace/runtime plugin active at the same time as this bundle. Multiple SSH providers can compete for Harness filesystem, subprocess, terminal, and workspace routing seams and produce failures that look like an SSH authentication/network problem.

Before testing this plugin, disable or uninstall competing SSH plugins such as `@captain1275/dsh-ssh`. Unrelated plugins (balance, appearance, vision routing, workshop, etc.) can stay installed.

## Network model

```text
DeepSeek Harness on Windows
       |
       +---- system OpenSSH / ~/.ssh/config ----> remote Linux host
       |                |
       |                +---- browse/read/write/terminal/Bash
       |
       +---- Windows 127.0.0.1:7890 (Clash/Mihomo/etc.)
                         |
                         +-- ssh -R 127.0.0.1:17890:127.0.0.1:7890
                                          |
                                          v
                                  remote Git/curl/wget
                                          |
                                        GitHub
```

Default mode is **auto**:

- Probe GitHub directly from the SSH host.
- If direct access works, keep the server network untouched.
- If direct access fails and Windows `127.0.0.1:7890` accepts HTTP CONNECT, open an SSH reverse tunnel.
- Inject `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` only into remote workspace processes/terminals.
- `NO_PROXY` includes `api.deepseek.com` / `.deepseek.com` by default.

Because Harness and the model run locally in this architecture, DeepSeek model calls are not routed through the remote proxy bridge.

## Prerequisites

- DeepSeek Harness / `dsh` with Node 22+.
- Windows OpenSSH client on PATH.
- A non-interactive SSH alias that already works from the same Windows account running Harness:

```powershell
ssh gdwyy70
```

- `python3` or `python` on the remote Linux host for remote file metadata/list/read/write helpers.
- For VPN fallback, an HTTP or mixed proxy listening on Windows `127.0.0.1:7890`. Clash/Mihomo mixed ports normally work. A SOCKS-only port does not.

## Install from GitHub

After this branch is merged to main:

```sh
dsh plugin --profile web add 'github:plutoczm/deepseek-harness-vscode'
```

For testing the development branch, prefer an exact commit SHA so the test is reproducible:

```sh
dsh plugin --profile web add 'github:plutoczm/deepseek-harness-vscode#<commit-sha>'
```

Restart the Web profile after installation.

## Use

1. Keep SSH configuration in your Windows OpenSSH config (`%USERPROFILE%\.ssh\config`).
2. Open Harness Web.
3. Use the SSH Remote workspace UI supplied by the bundled SSH provider.
4. Pick an SSH alias such as `gdwyy70`.
5. Browse and open `/mnt/ext-disk/czm2025/Projects/face_privacy_tkde` (or any other remote directory).
6. Use **Full access** for the session so Harness may launch the local `ssh.exe` process.
7. Bash/file/terminal activity for that workspace is routed to the SSH host.
8. Network mode is automatically direct-first, then Windows `7890` fallback.

No SSH private key or password is copied into this plugin's settings.

## Optional environment configuration

```text
DSH_SSH_PROXY_MODE=auto          # auto | direct | proxy
DSH_SSH_PROXY_HOST=127.0.0.1
DSH_SSH_PROXY_PORT=7890
DSH_SSH_PROXY_REMOTE_PORT=17890
DSH_SSH_PROXY_HEALTH_INTERVAL_MS=60000
DSH_SSH_PROXY_NO_PROXY=api.deepseek.com,.deepseek.com,127.0.0.1,localhost,::1
```

`auto` is recommended. `proxy` forces the tunnel. `direct` disables VPN fallback.

## Acceptance tests

Inside a remote workspace, these should all describe the remote machine/repository:

```sh
pwd
hostname
git remote -v
git ls-remote origin
git push --dry-run
```

To explicitly test the Windows VPN bridge, launch Harness once with:

```powershell
$env:DSH_SSH_PROXY_MODE='proxy'
dsh web
```

Then in the remote Harness terminal/Bash:

```sh
env | grep -i proxy
curl -I https://github.com --connect-timeout 10
```

The remote proxy variables should point to a loopback port such as `http://127.0.0.1:17890`, which is reverse-forwarded to Windows `127.0.0.1:7890`. After testing, restart Harness without the forced environment variable to return to `auto` mode.

## Security / trust boundary

- SSH keys and agent state stay with system OpenSSH / your existing Windows SSH configuration.
- The reverse-forward listener binds to remote **127.0.0.1**, not all interfaces.
- The plugin never reads or exports the DeepSeek API key.
- Remote proxy environment is scoped to routed remote processes and remote terminal shells.
- File payloads travel over the existing encrypted SSH connection.
- No sudo/root access is required.

## Upstream basis

The remote workspace dependency is pinned to `CrazyShout/dsh-ssh-remote` commit `72a2ac6b0f277ab0706ee93634dee2c639070728` for reproducibility. It is MIT-licensed. We retain its Harness UI/workspace model while deliberately making system OpenSSH authoritative for actual remote authentication/data transport.

See `NOTICE` for attribution.

## Plugin-market plan

After the Windows + real-SSH test is stable, this repository can be submitted to `awesome-dsh-plugin`. That registry requires a real `dsh.bundle` manifest and is consumed by the community `dsh-market`, so there is no need to build another marketplace into this project.

## Status

This is the first focused implementation branch. CI covers Node 22/24, Windows OpenSSH presence, unit tests, package creation, and an official Harness packaged-plugin Web smoke test. A real Windows `ssh gdwyy70` + local mixed proxy `127.0.0.1:7890` test is still required before release/merge.
