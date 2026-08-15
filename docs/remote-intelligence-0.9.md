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
│  ├─ Plugin Marketplace                                           │
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
│  ├─ Git / gh                                                     │
│  ├─ Python / Conda                                               │
│  ├─ plugins / MCP servers                                        │
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

## Trust boundaries

1. **Renderer** remains sandboxed and must not receive SSH keys, GitHub token values, DeepSeek API keys, or raw secret environment values.
2. **Local control service** binds to loopback only and performs privileged orchestration through explicit APIs.
3. **SSH host** runs commands with the selected SSH user's permissions; no sudo assumptions.
4. **DeepSeek model/API traffic** remains remote-direct. Proxy fallback is for Bash/Git/curl/wget-style tool traffic only.
5. **Community plugin/MCP registries** are untrusted metadata sources. Discovery does not imply endorsement or safety.
6. **Install/update/remove actions** require an explicit install plan, static checks, source/ref visibility, and user confirmation.

## Provider/adaptor model

Marketplace and MCP integrations should not hard-code a single community schema into the core service.

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
  author
  description
  license
  updatedAt
  popularityMetadata?
  declaredInstallMethod?
  capabilities[]

SecurityReport
  risk: low | medium | high | unknown
  findings[]
  installScripts[]
  executables[]
  networkIndicators[]
  filesystemIndicators[]

InstallPlan
  sourceRepo
  sourceRef
  commands[]
  filesTouched[]
  environmentChanges[]
```

## Initial ecosystem references

- Official: `deepseek-ai/deepseek-harness`
- Community index: `awesome-dsh-plugin/awesome-dsh-plugin`
- Community marketplace: `bradeGithub/DSH-Plugins-Marketplace`

The UI must label source provenance clearly. A community entry must never be rendered as an official DeepSeek recommendation merely because it appears in a marketplace/index.

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
3. Read-only marketplace provider adapters.
4. Security scanner + explicit install plan.
5. MCP Manager on top of the safety gate.
6. Git Assistant integrated with Network Doctor.

## Non-goals

- Reimplementing the DeepSeek Harness agent.
- Automatically running arbitrary community install instructions.
- Automatically force-pushing, resetting, cleaning, rebasing, or rewriting Git history.
- Routing DeepSeek model requests through the local VPN by default.
