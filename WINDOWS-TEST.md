# Windows acceptance test

This development branch intentionally keeps the SSH workspace provider as an explicit top-level Harness plugin. Do not weaken pnpm's `blockExoticSubdeps` policy.

## 0. Disable competing SSH providers

In Harness Plugin Workshop, disable/uninstall other SSH workspace providers such as `@captain1275/dsh-ssh` before this test. Balance/vision/workshop plugins can remain enabled.

## 1. Verify Windows OpenSSH and the remote host

```cmd
ssh gdwyy70
```

On the remote host, verify Python is available:

```sh
python3 --version || python --version
```

Then exit back to Windows.

## 2. Install the pinned SSH workspace provider as a direct plugin

```cmd
npx @deepseek-ai/dsh plugin --profile web add "github:CrazyShout/dsh-ssh-remote#72a2ac6b0f277ab0706ee93634dee2c639070728"
```

It is deliberately installed directly rather than hidden as a Git subdependency. pnpm's `blockExoticSubdeps` is a useful supply-chain protection and should stay enabled.

## 3. Install this bridge

Use the current PR commit SHA shown in the PR. Example:

```cmd
npx @deepseek-ai/dsh plugin --profile web add "github:plutoczm/deepseek-harness-vscode#<bridge-commit-sha>"
```

## 4. Start Harness

```cmd
npx @deepseek-ai/dsh web
```

Add an SSH workspace using alias `gdwyy70`, then browse/open the desired remote directory.

## 5. Verify the remote workspace

Run in the Harness remote workspace:

```sh
pwd
hostname
git remote -v
git ls-remote origin
git push --dry-run
```

## 6. Force-test the Windows 7890 bridge

Close Harness, then in Windows PowerShell:

```powershell
$env:DSH_SSH_PROXY_MODE="proxy"
npx @deepseek-ai/dsh web
```

Inside the remote workspace:

```sh
env | grep -i proxy
curl -I https://github.com --connect-timeout 10
git ls-remote origin
```

Expected proxy values point at remote loopback (`127.0.0.1:17890` or the next candidate port). That remote listener is an SSH reverse tunnel to Windows `127.0.0.1:7890`.

After the test:

```powershell
Remove-Item Env:DSH_SSH_PROXY_MODE
```

Restart Harness to return to the default `auto` policy.
