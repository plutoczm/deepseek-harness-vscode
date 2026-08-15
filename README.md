# dsh-ssh-vpn-bridge

A focused DeepSeek Harness plugin for two problems only:

1. **SSH remote workspaces that reuse the OpenSSH configuration you already know works.**
2. **Windows VPN / local proxy bridging to the remote host**, so remote Git, curl and wget can fall back to `127.0.0.1:7890` when the server cannot reach GitHub reliably.

It deliberately does not try to be a desktop IDE, plugin marketplace, MCP manager, Git GUI, or model wrapper.

## Why this exists

If this works in Windows Terminal:

```powershell
ssh gdwyy70
```

Harness should not ask you to re-enter the host, username, key and ProxyJump in a second SSH stack.

The remote-workspace layer uses `dsh-ssh-remote`, which discovers concrete aliases from `~/.ssh/config`, resolves effective options through the system OpenSSH client, routes Bash/terminal commands through OpenSSH, and provides SFTP-backed remote files. This package then adds a direct-first network bridge around those workspaces.

## Network model

```text
DeepSeek Harness on Windows
       |
       +---- system OpenSSH / ~/.ssh/config ----> remote Linux host
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
- Your SSH alias already works non-interactively. Test it first:

```powershell
ssh gdwyy70
```

- For VPN fallback, an HTTP or mixed proxy listens on Windows `127.0.0.1:7890`. Clash/Mihomo mixed ports normally work. A SOCKS-only port does not.

## Install from GitHub

After this branch is merged to main:

```sh
dsh plugin --profile web add 'github:plutoczm/deepseek-harness-vscode'
```

For testing the development branch:

```sh
dsh plugin --profile web add 'github:plutoczm/deepseek-harness-vscode#feature/dsh-ssh-proxy-plugin'
```

Restart the Web profile after installation.

## Use

1. Keep SSH configuration in `~/.ssh/config` only.
2. Open Harness Web.
3. Use the SSH Remote workspace UI injected by the bundle.
4. Pick an SSH alias such as `gdwyy70`.
5. Browse and open `/mnt/ext-disk/czm2025/Projects/face_privacy_tkde` (or any other remote directory).
6. Bash/file/terminal activity for that workspace is routed to the SSH host.
7. Network mode is automatically direct-first, then Windows `7890` fallback.

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

## Security / trust boundary

- SSH keys stay with system OpenSSH / your existing SSH configuration.
- The reverse-forward listener binds to remote **127.0.0.1**, not all interfaces.
- The plugin never reads or exports the DeepSeek API key.
- Remote proxy environment is scoped to routed remote processes and proxy-aware remote terminal sessions.
- No sudo/root access is required.

## Upstream basis

The remote workspace dependency is pinned to `CrazyShout/dsh-ssh-remote` commit `72a2ac6b0f277ab0706ee93634dee2c639070728` for reproducibility. It is MIT-licensed. Its architecture is intentionally preferred over plugins that require duplicating SSH credentials inside Harness because it treats system OpenSSH configuration as authoritative.

See `NOTICE` for attribution.

## Status

This is the first focused implementation branch. CI covers syntax and pure network/proxy behavior. Before release, it should also be smoke-tested on Windows against a real `ssh gdwyy70`-style alias and a real mixed proxy on port 7890.
