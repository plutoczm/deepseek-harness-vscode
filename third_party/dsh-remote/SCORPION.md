# Scorpion Desktop integration

This package is based on `flymysql/dsh-remote` 0.5.7 (MIT).

Local additions:
- optional SSH reverse TCP proxy tunnel using the existing `ssh2` connection;
- user-selectable local proxy host/port and remote loopback host/port;
- automatic remote port allocation using SSH `forwardIn(..., 0)`;
- `rw_exec` proxy environment injection;
- `rw_proxy_tunnel` status/test/start/stop tool;
- proxy controls in the Remote Workspace settings UI.

The default remote bind address is `127.0.0.1` to avoid exposing the local proxy to the remote network.
