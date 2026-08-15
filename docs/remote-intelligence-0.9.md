# DeepSeek Harness Desktop 0.9.0 — Remote Intelligence Layer

## Goal

Keep the official DeepSeek Harness as the agent/runtime and make the Desktop application responsible for orchestration, diagnostics, extension discovery, safety gates, and workspace-level developer UX.

## Architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│                   DeepSeek Harness Desktop                       │
│                                                                  │
│  Workbench UI                                                    │
│  ├─ Home / Sessions / Files / Terminal                           │
│  ├─ Network Doctor                                               │
│  ├─ Plugin discovery / installed inventory                       │
│  ├─ MCP Manager                                                  │
│  └─ Git Assistant                                                │
│                          │                                       │
│                          ▼                                       │
│  Local Control Service (127.0.0.1 only)                          │
│  ├─ capability + health service                                  │
│  ├─ marketplace provider adapters                                │
│  ├─ security scanner / install planner                           │
│  ├─ terminal PTY manager                                         │
│  └─ Local/SSH Harness managers                                   │
└──────────────────────────┬───────────────────────────────────────┘
                           │ system OpenSSH
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                        Remote SSH Host                            │
│  ├─ official DeepSeek Harness                                    │
│  ├─ official `dsh plugin --profile ...` management path          │
│  ├─ official plugin inventory / Cordis loader state               │
│  ├─ official `@deepseek-ai/dsh-mcp-client` instances             │
│  ├─ Git / gh / Python / Conda                                    │
│  └─ workspace files                                              │
└──────────────────────────┬───────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
        DeepSeek API                GitHub / Web
        remote direct          direct first; optional
                               Windows 127.0.0.1:7890
                               fallback through SSH -R
```

## Official Harness compatibility findings

The 0.9 Desktop layer must wrap official mechanisms instead of inventing parallel formats:

1. **Installed plugin inventory already exists in official Harness.** The Host `pluginInventory/list` projection is deliberately read-only and reports loader entry id, module id, effective enabled state, and current Fiber stage. The official Web Settings UI already consumes that inventory lazily.
2. **Plugin lifecycle authority remains the Cordis Loader.** Desktop should not maintain a second competing enabled/disabled truth.
3. **Official CLI plugin management is `dsh plugin --profile <name> ...`.** It forwards to pnpm inside the profile and reconciles dependencies that declare `dsh.bundle` into the profile bundle stack. Desktop install/update/remove plans should use this path unless upstream changes it.
4. **Git/path plugins may require build scripts.** pnpm >= 10 blocks these until explicitly allowlisted. Desktop must surface the exact package/build-script plan instead of bypassing this protection.
5. **Official MCP client already exists.** `@deepseek-ai/dsh-mcp-client` supports `stdio` and `streamable-http` transports; each configured MCP server is one plugin instance with a stable `serverName` namespace. Current lifecycle is configuration + HMR, not a separate runtime mutation API.
6. **MCP stdio environments are intentionally scrubbed.** The upstream client removes broadly secret-like parent environment variables and only merges explicitly configured env values. Desktop must preserve this security model and redact configured secrets in UI/logs.

## Trust boundaries

1. **Renderer** remains sandboxed and must not receive SSH keys, GitHub token values, DeepSeek API keys, MCP secret values, or raw secret environment values.
2. **Local control service** binds to loopback only and performs privileged orchestration through explicit APIs.
3. **SSH host** runs commands with the selected SSH user's permissions; no sudo assumptions.
4. **DeepSeek model/API traffic** remains remote-direct. Proxy fallback is for Bash/Git/curl/wget-style tool traffic only.
5. **Community plugin/MCP registries** are untrusted metadata sources. Discovery does not imply endorsement or safety.
6. **Install/update/remove actions** require an explicit install plan, static checks, source/ref visibility, and user confirmation.
7. **Official plugin inventory is authoritative for runtime state; Desktop cache is observational only.**

## Provider/adaptor model

Marketplace integrations should not hard-code a single community schema into the core service.

```text
RegistryProvider
  id
  displayName
  provenance: official | community
  discover(query)
  getPackage(id)
  resolveSource(package)

PackageRecord
  sourceRepo
  sourceRef
  packageName?
  author
  description
  license
  updatedAt
  popularityMetadata?
  declaredInstallMethod?
  capabilities[]

InstalledPluginRecord
  loaderEntryId
  moduleId
  enabled
  fiberStage
  source: official-plugin-inventory

SecurityReport
  risk: low | medium | high | unknown
  findings[]
  installScripts[]
  buildScripts[]
  executables[]
  networkIndicators[]
  filesystemIndicators[]

InstallPlan
  profile
  packageSpec
  sourceRepo
  sourceRef
  officialCommand: `dsh plugin --profile <profile> ...`
  commands[]
  filesTouched[]
  environmentChanges[]
  buildScriptApprovalRequired
```

## Marketplace strategy

Use discovery sources as metadata providers, while keeping install execution on the official CLI path.

Initial sources:

- Official runtime/inventory: `deepseek-ai/deepseek-harness`
- Community curated index: `awesome-dsh-plugin/awesome-dsh-plugin`
- Community market implementation/reference: `dsh-market/dsh-market`
- Additional community registries only through explicit adapters

The community `dsh-market` implementation provides several patterns worth preserving rather than re-inventing badly:

- curated-source restriction;
- prefer npm tarballs when a package is registry-published;
- verify npm mapping against repository identity to reduce name-squatting risk;
- keep pnpm build scripts blocked unless the user explicitly allows the exact package;
- sanitized log export;
- clear warning that listing is not endorsement.

Desktop may offer a broader security report, but should not silently weaken these controls.

## MCP Manager strategy

Do not invent a private `mcpServers` format. Use the official Harness MCP client configuration model:

```text
McpInstance
  plugin: @deepseek-ai/dsh-mcp-client
  serverName
  transport: stdio | streamable-http
  command/args/env/cwd?        # stdio
  url/headers?                 # streamable-http
  toolCallTimeoutMs?
```

The manager should generate/review the corresponding Cordis/profile configuration change, show secret fields redacted, validate duplicate `serverName`, and rely on Harness HMR/reload semantics for activation.

## Workstreams

- #17 Network Doctor and GitHub health diagnostics
- #18 Persistent remote capability and health cache
- #19 Read-only plugin marketplace discovery
- #20 Plugin/MCP security scanner and explicit install flow
- #21 MCP Manager
- #22 Git Assistant
- #23 Architecture reference and external ecosystem adapters

## Development order

1. Network Doctor data model and copyable diagnostics.
2. Capability/state cache with TTL and background refresh.
3. Read-only marketplace provider adapters + official installed inventory view.
4. Security scanner + explicit `dsh plugin` install plan.
5. MCP Manager on top of official `@deepseek-ai/dsh-mcp-client` configuration.
6. Git Assistant integrated with Network Doctor.

## Non-goals

- Reimplementing the DeepSeek Harness agent.
- Replacing Cordis Loader as plugin lifecycle authority.
- Inventing a second incompatible plugin or MCP configuration format.
- Automatically running arbitrary community install instructions.
- Automatically bypassing pnpm build-script protections.
- Automatically force-pushing, resetting, cleaning, rebasing, or rewriting Git history.
- Routing DeepSeek model requests through the local VPN by default.
