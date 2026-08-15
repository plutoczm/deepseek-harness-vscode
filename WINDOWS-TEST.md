# Windows acceptance test — dsh-openssh-vpn 0.2.0

This test validates the standalone native OpenSSH implementation. No `dsh-ssh-remote` provider is installed or required.

The development tool names are `openssh_*`, so `@captain1275/dsh-ssh` may remain installed during A/B testing without a tool-name collision.

## 1. Baseline: Windows OpenSSH

```cmd
ssh -G gdwyy70 | findstr /I "hostname user port identityfile remoteforward proxyjump proxycommand"
```

Reference result already observed on the target machine:

```text
user czm2025
hostname 172.23.207.70
port 22
identityfile ~/.ssh/id_rsa
...
remoteforward 35052 [127.0.0.1]:7890
```

Authentication baseline:

```cmd
ssh -v gdwyy70 exit 2>&1 | findstr /I "Offering public key Server accepts key Authentication succeeded Authenticated to"
```

The accepted key was `C:\Users\Admin1\.ssh\id_rsa`.

## 2. Existing VS Code tunnel baseline

With the VS Code Remote SSH session active:

```cmd
ssh -o ClearAllForwardings=yes gdwyy70 "curl -x http://127.0.0.1:35052 -I https://github.com --connect-timeout 10"
```

Expected: no duplicate-forward warning and GitHub HTTP 200.

Project Git baseline:

```cmd
ssh -o ClearAllForwardings=yes gdwyy70 "cd /mnt/ext-disk/czm2025/Projects/face_privacy_tkde && HTTP_PROXY=http://127.0.0.1:35052 HTTPS_PROXY=http://127.0.0.1:35052 git ls-remote origin HEAD"
```

Expected: a commit hash followed by `HEAD`.

## 3. Install the exact development build

```cmd
npx @deepseek-ai/dsh plugin --profile web add "github:plutoczm/deepseek-harness-vscode#<current-commit-sha>"
```

Confirm the bundle is present:

```cmd
npx @deepseek-ai/dsh web --dump-default-config | findstr /I "dsh-openssh-vpn"
```

## 4. Start Harness

```cmd
npx @deepseek-ai/dsh web
```

Harness must boot normally without any `sshRemote` pending error.

## 5. Test native OpenSSH tools while VS Code owns 35052

In Harness chat, ask it to call `openssh_proxy_status` for `gdwyy70`.

Expected route when remote GitHub direct is intentionally unavailable or when forcing proxy mode:

```text
route=proxy
source=existing-config-forward
remoteProxy=127.0.0.1:35052
```

Then use `openssh_exec`:

```text
alias: gdwyy70
command: cd /mnt/ext-disk/czm2025/Projects/face_privacy_tkde && git ls-remote origin HEAD
```

Expected: successful exit code and a `HEAD` hash.

## 6. Force proxy mode for deterministic reuse testing

Close Harness. In CMD:

```cmd
set DSH_SSH_PROXY_MODE=proxy
npx @deepseek-ai/dsh web
```

Run `openssh_proxy_status` again. With VS Code still connected, it should report `existing-config-forward` and port `35052`.

No Harness short-lived SSH operation should print:

```text
Warning: remote port forwarding failed for listen port 35052
```

because ordinary calls use `ClearAllForwardings=yes`.

## 7. Test Harness takeover when VS Code is closed

Close the VS Code Remote SSH connection so the externally owned remote `35052` listener disappears. Keep Harness in forced proxy mode and refresh `openssh_proxy_status`.

Expected behavior:

1. the existing `35052` probe fails;
2. Harness starts a persistent native OpenSSH tunnel using the configured `RemoteForward`;
3. status becomes:

```text
route=proxy
source=managed-config-forward
remoteProxy=127.0.0.1:35052
```

`openssh_exec` GitHub/Git commands should remain successful.

## 8. Test fallback when no matching RemoteForward exists

This is covered by CI with adapters and normally does not require editing the real SSH config. If an alias has no `RemoteForward ... 127.0.0.1:7890`, the plugin tries remote loopback ports beginning at `17890` and reports `source=managed-explicit-forward` after verification.

## 9. Restore auto mode

CMD:

```cmd
set DSH_SSH_PROXY_MODE=
```

Restart Harness. Default `auto` probes remote GitHub direct first and only uses the VPN path when required.

## Acceptance criteria

- Harness boots with the plugin installed and no secondary SSH provider dependency.
- `openssh_list` resolves `gdwyy70` through `ssh -G`.
- `openssh_exec` uses the same system OpenSSH identity path as Windows CMD.
- Existing VS Code `35052 -> Windows 7890` is reused without being killed or rebound.
- Closing VS Code causes Harness to take ownership of the configured forward automatically when proxy routing is required.
- GitHub HTTP and `git ls-remote` work through the chosen route.
