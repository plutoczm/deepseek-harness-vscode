let currentRuntime;

/**
 * The host bundle and the agent-preset subpath resolve from the same installed
 * package instance. Keep the one OpenSshEngine here so remote-workspace tools
 * reuse exactly the same RouteManager/tunnel ownership as openssh_exec and the
 * Web SSH panel instead of starting a second SSH/VPN stack.
 */
export function installOpenSshRuntime(runtime) {
  currentRuntime = runtime;
  return () => {
    if (currentRuntime === runtime) currentRuntime = undefined;
  };
}

export function openSshRuntime() {
  if (!currentRuntime?.engine) {
    throw new Error('dsh-openssh-vpn host runtime is unavailable; ensure the bundle is active in the Web profile');
  }
  return currentRuntime;
}
