# DeepSeek Harness Remote per-session environment bootstrap.
# Bash reads this file for every non-interactive `bash -c` through BASH_ENV.

if [ -n "${DEEPSEEK_HARNESS_PARENT_BASH_ENV:-}" ] \
  && [ "${DEEPSEEK_HARNESS_PARENT_BASH_ENV}" != "${BASH_ENV:-}" ] \
  && [ -r "${DEEPSEEK_HARNESS_PARENT_BASH_ENV}" ]; then
  . "${DEEPSEEK_HARNESS_PARENT_BASH_ENV}"
fi

if [ -n "${DSH_SESSION_ID:-}" ] && [ -n "${DEEPSEEK_HARNESS_SESSION_ENV_DIR:-}" ]; then
  _dsh_remote_env_id="$(printf '%s' "${DSH_SESSION_ID}" | tr -c 'A-Za-z0-9._-' '_')"
  _dsh_remote_env_file="${DEEPSEEK_HARNESS_SESSION_ENV_DIR}/${_dsh_remote_env_id}.sh"
  if [ -r "${_dsh_remote_env_file}" ]; then
    . "${_dsh_remote_env_file}"
  fi
  unset _dsh_remote_env_id _dsh_remote_env_file
fi
