# DeepSeek Harness Remote per-session environment bootstrap.
# Bash reads this file for every non-interactive `bash -c` through BASH_ENV.

if [ -n "${DEEPSEEK_HARNESS_PARENT_BASH_ENV:-}" ] \
  && [ "${DEEPSEEK_HARNESS_PARENT_BASH_ENV}" != "${BASH_ENV:-}" ] \
  && [ -r "${DEEPSEEK_HARNESS_PARENT_BASH_ENV}" ]; then
  . "${DEEPSEEK_HARNESS_PARENT_BASH_ENV}"
fi

# Network routing is deliberately injected only into Bash/tool processes.
# The Harness process itself does not receive HTTP_PROXY/HTTPS_PROXY, so
# DeepSeek model requests keep using the remote server's normal network path.
if [ -n "${DEEPSEEK_HARNESS_REMOTE_INSTANCE:-}" ] && [ -n "${DEEPSEEK_HARNESS_SESSION_ENV_DIR:-}" ]; then
  _dsh_remote_instance_id="$(printf '%s' "${DEEPSEEK_HARNESS_REMOTE_INSTANCE}" | tr -c 'A-Za-z0-9._-' '_')"
  _dsh_remote_network_file="${DEEPSEEK_HARNESS_SESSION_ENV_DIR}/network-${_dsh_remote_instance_id}.sh"
  if [ -r "${_dsh_remote_network_file}" ]; then
    . "${_dsh_remote_network_file}"
  fi
  unset _dsh_remote_instance_id _dsh_remote_network_file
fi

if [ -n "${DSH_SESSION_ID:-}" ] && [ -n "${DEEPSEEK_HARNESS_SESSION_ENV_DIR:-}" ]; then
  _dsh_remote_env_id="$(printf '%s' "${DSH_SESSION_ID}" | tr -c 'A-Za-z0-9._-' '_')"
  _dsh_remote_env_file="${DEEPSEEK_HARNESS_SESSION_ENV_DIR}/${_dsh_remote_env_id}.sh"
  if [ -r "${_dsh_remote_env_file}" ]; then
    . "${_dsh_remote_env_file}"
  fi
  unset _dsh_remote_env_id _dsh_remote_env_file
fi
