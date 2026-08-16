# @deepseek-ai/dsh-plugin-center-skill-fixture

English | [中文](README.zh.md)

Reviewed development fixture for the Desktop Plugin Center Skill-pack install path. Its Bundle patch activates one Host provider, which registers the globally discoverable `fixture-harness-basics` Skill. Production features must not depend on this fixture.

## Model Experience

### `fixture-harness-basics` Skill

#### What the model sees

When a consumer includes or invokes the installed Skill, the model sees its package-owned content explaining that the reviewed fixture proves persistence after a Host restart.

#### Token effect

No tokens are added to ordinary prompts; including `fixture-harness-basics` adds only that deterministic Skill content to the consuming request.

#### KV Cache effect

The catalog changes after installation, but ordinary request prefixes remain unchanged until a consumer includes or invokes `fixture-harness-basics`.

## Known Limitations and Deferred Work

- **Development evidence only** — the Skill text is intentionally fixed for F003 activation tests and is not a production learning resource.
