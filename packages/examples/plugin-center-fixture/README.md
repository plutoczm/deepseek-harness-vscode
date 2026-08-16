# @deepseek-ai/dsh-plugin-center-fixture

English | [中文](README.zh.md)

Reviewed development fixture for the Desktop Plugin Center trusted-install path. Its Bundle patch adds the `fixture.workspace-tools` Host entry, and the same package declares a browser client half that contributes a visible Workspace tools page. Production features must not depend on this fixture.

## Model Experience

None, as the fixture contributes product UI and Host activation evidence only.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Development evidence only** — the package is reviewed for deterministic F003 tests, not supported as a production plugin or user-facing workspace tool.
