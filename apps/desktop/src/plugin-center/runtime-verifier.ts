/** Post-restart Host health and joined Loader/client/Skill activation verification. */

import { randomUUID } from 'node:crypto'
import {
  decodePluginRuntimeEvidence,
  type CatalogVersionPreflight,
  type PluginRuntimeEvidence,
} from '@deepseek-ai/dsh-plugin-center-contracts'

const GENERATED_LOADER_ENTRY_ID = /^[0-9a-f]{8}$/u
/** Loader children created for live preset instances; their owner entry remains restart-stable. */
const RESTART_SCOPED_LOADER_ENTRY_PREFIXES = ['include:agent-presets:'] as const

type RuntimeEntry = PluginRuntimeEvidence['entries'][number]

interface NormalizedRuntimeEvidence {
  readonly evidence: PluginRuntimeEvidence
  readonly legacyGeneratedEntries: readonly RuntimeEntry[]
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function sortEntries(entries: readonly RuntimeEntry[]): readonly RuntimeEntry[] {
  return [...entries].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function isRestartStableEntry(entry: RuntimeEntry): boolean {
  return !RESTART_SCOPED_LOADER_ENTRY_PREFIXES.some(
    prefix => entry.entryId.startsWith(prefix),
  )
}

function restartStableEntries(entries: readonly RuntimeEntry[]): readonly RuntimeEntry[] {
  return entries.filter(isRestartStableEntry)
}

function normalizeEvidence(
  value: unknown,
  allowLegacyGeneratedIds = false,
): NormalizedRuntimeEvidence {
  const inventory = record(value, 'runtime inventory')
  const entries = inventory['entries']
  if (!Array.isArray(entries)) throw new Error('runtime inventory entries must be an array')
  const sources = entries.map((entry, index) => record(entry, `runtime inventory entry ${String(index)}`))
  const decoded = decodePluginRuntimeEvidence({
    entries: sources.map(source => ({
      entryId: source['entryId'],
      enabled: source['enabled'],
      fiberPhase: source['fiberPhase'],
    })),
    clientModules: inventory['clientModules'],
    skillIds: inventory['skillIds'],
  })
  const legacyGeneratedEntries: RuntimeEntry[] = []
  const projectedEntries = decoded.entries.flatMap((entry, index) => {
    if (!GENERATED_LOADER_ENTRY_ID.test(entry.entryId)) return [entry]
    const moduleName = sources[index]?.['moduleName']
    if (typeof moduleName === 'string' && moduleName.length > 0) {
      return [{ ...entry, entryId: `module:${moduleName}` }]
    }
    if (!allowLegacyGeneratedIds) {
      throw new Error(`runtime inventory entry ${String(index)} lacks stable module identity`)
    }
    legacyGeneratedEntries.push(entry)
    return []
  })
  return {
    evidence: decodePluginRuntimeEvidence({
      entries: [...projectedEntries].sort((left, right) => left.entryId.localeCompare(right.entryId)),
      clientModules: [...decoded.clientModules].sort(),
      skillIds: [...decoded.skillIds].sort(),
    }),
    legacyGeneratedEntries: sortEntries(legacyGeneratedEntries),
  }
}

function sameEvidence(observed: PluginRuntimeEvidence, expected: unknown): boolean {
  const normalized = normalizeEvidence(expected, true)
  const observedStable = {
    ...observed,
    entries: restartStableEntries(observed.entries),
  }
  const expectedStable = {
    ...normalized.evidence,
    entries: restartStableEntries(normalized.evidence.entries),
  }
  if (normalized.legacyGeneratedEntries.length === 0) {
    return JSON.stringify(observedStable) === JSON.stringify(expectedStable)
  }
  const observedGeneratedEntries = observedStable.entries
    .filter(entry => entry.entryId.startsWith('module:'))
    .map(({ enabled, fiberPhase }) => ({ entryId: '', enabled, fiberPhase }))
  const expectedGeneratedEntries = normalized.legacyGeneratedEntries
    .map(({ enabled, fiberPhase }) => ({ entryId: '', enabled, fiberPhase }))
  return JSON.stringify({
    ...observedStable,
    entries: observedStable.entries.filter(entry => !entry.entryId.startsWith('module:')),
  }) === JSON.stringify(expectedStable)
    && JSON.stringify(sortEntries(observedGeneratedEntries))
      === JSON.stringify(sortEntries(expectedGeneratedEntries))
}

function candidateEntry(candidates: readonly CatalogVersionPreflight[], entryId: string): boolean {
  return candidates.some(candidate => candidate.expectedEntries.some(
    expected => entryId === expected || entryId === `include:${expected}`,
  ))
}

function requireUnrelatedContinuity(
  prior: PluginRuntimeEvidence,
  observed: PluginRuntimeEvidence,
  candidates: readonly CatalogVersionPreflight[],
): void {
  for (const entry of prior.entries) {
    if (!isRestartStableEntry(entry)) continue
    if (candidateEntry(candidates, entry.entryId)) continue
    if (!observed.entries.some(current => current.entryId === entry.entryId
      && current.enabled === entry.enabled
      && current.fiberPhase === entry.fiberPhase)) {
      throw new Error(`unrelated Loader entry changed during plugin mutation: ${entry.entryId}`)
    }
  }
  for (const moduleName of prior.clientModules) {
    if (!candidates.some(candidate => candidate.expectedClientModules.includes(moduleName))
      && !observed.clientModules.includes(moduleName)) {
      throw new Error(`unrelated client module disappeared during plugin mutation: ${moduleName}`)
    }
  }
  for (const skillId of prior.skillIds) {
    if (!candidates.some(candidate => candidate.expectedSkillIds.includes(skillId))
      && !observed.skillIds.includes(skillId)) {
      throw new Error(`unrelated Skill disappeared during plugin mutation: ${skillId}`)
    }
  }
}

/** Reads the current Host through its ordinary loopback HTTP surface. */
export class PluginRuntimeVerifier {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly createRpcId: () => string = randomUUID,
    private readonly timeoutMs = 10_000,
  ) {}

  async verifyHealth(origin: string): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => { controller.abort() }, this.timeoutMs)
    try {
      const response = await this.fetcher(`${origin}/`, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok || new URL(response.url || origin).origin !== origin) {
        throw new Error('replacement Host did not answer from its owned loopback origin')
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  /** Read a canonical exact Loader/client/Skill inventory from one owned Host. */
  async readEvidence(origin: string): Promise<PluginRuntimeEvidence> {
    const rpcId = this.createRpcId()
    const controller = new AbortController()
    const timeout = setTimeout(() => { controller.abort() }, this.timeoutMs)
    try {
      const response = await this.fetcher(`${origin}/api/pluginInventory/list`, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: 'pluginInventory/list',
          payload: { args: {} },
        }),
      })
      if (!response.ok) throw new Error(`runtime inventory returned HTTP ${String(response.status)}`)
      const envelope = record(await response.json() as unknown, 'runtime inventory response')
      if (envelope['type'] !== 'server-response' || envelope['rpcId'] !== rpcId) {
        throw new Error('runtime inventory response does not own the request id')
      }
      const result = record(envelope['result'], 'runtime inventory result')
      if (result['ok'] !== true) throw new Error('runtime inventory request failed')
      return normalizeEvidence(result['value']).evidence
    } finally {
      clearTimeout(timeout)
    }
  }

  /** Require the exact prior inventory after a recovery restart. */
  async verifyEvidence(origin: string, expected: PluginRuntimeEvidence): Promise<PluginRuntimeEvidence> {
    const observed = await this.readEvidence(origin)
    if (!sameEvidence(observed, expected)) {
      throw new Error('recovered Host runtime inventory differs from the prior verified inventory')
    }
    return observed
  }

  /** Require every catalog-declared activation identity and return the full target inventory. */
  async verifyActivation(
    origin: string,
    candidate: CatalogVersionPreflight,
  ): Promise<PluginRuntimeEvidence> {
    const inventory = await this.readEvidence(origin)
    for (const expected of candidate.expectedEntries) {
      const active = inventory.entries.some(entry =>
        (entry.entryId === expected || entry.entryId === `include:${expected}`)
        && entry.enabled
        && entry.fiberPhase === 'active',
      )
      if (!active) throw new Error(`expected Loader entry is not active: ${expected}`)
    }
    for (const expected of candidate.expectedClientModules) {
      if (!inventory.clientModules.includes(expected)) {
        throw new Error(`expected client module is not active: ${expected}`)
      }
    }
    for (const expected of candidate.expectedSkillIds) {
      if (!inventory.skillIds.includes(expected)) {
        throw new Error(`expected Skill is not active: ${expected}`)
      }
    }
    return inventory
  }

  /** Require target activation while retaining every unrelated prior runtime identity. */
  async verifyActivationTransition(
    origin: string,
    candidate: CatalogVersionPreflight,
    prior: PluginRuntimeEvidence,
    replacedCandidate?: CatalogVersionPreflight,
  ): Promise<PluginRuntimeEvidence> {
    const inventory = await this.verifyActivation(origin, candidate)
    const continuityCandidates = replacedCandidate === undefined ? [candidate] : [candidate, replacedCandidate]
    requireUnrelatedContinuity(
      normalizeEvidence(prior, true).evidence,
      inventory,
      continuityCandidates,
    )
    return inventory
  }

  /** Require every target identity absent while unrelated prior runtime stays stable. */
  async verifyDeactivation(
    origin: string,
    candidate: CatalogVersionPreflight,
    prior: PluginRuntimeEvidence,
    replacedCandidate?: CatalogVersionPreflight,
  ): Promise<PluginRuntimeEvidence> {
    const inventory = await this.readEvidence(origin)
    const removedCandidates = replacedCandidate === undefined ? [candidate] : [candidate, replacedCandidate]
    for (const expected of new Set(removedCandidates.flatMap(value => value.expectedEntries))) {
      if (inventory.entries.some(entry => entry.entryId === expected || entry.entryId === `include:${expected}`)) {
        throw new Error(`removed Loader entry is still present: ${expected}`)
      }
    }
    for (const expected of new Set(removedCandidates.flatMap(value => value.expectedClientModules))) {
      if (inventory.clientModules.includes(expected)) {
        throw new Error(`removed client module is still present: ${expected}`)
      }
    }
    for (const expected of new Set(removedCandidates.flatMap(value => value.expectedSkillIds))) {
      if (inventory.skillIds.includes(expected)) {
        throw new Error(`removed Skill is still present: ${expected}`)
      }
    }
    requireUnrelatedContinuity(
      normalizeEvidence(prior, true).evidence,
      inventory,
      replacedCandidate === undefined ? [candidate] : [candidate, replacedCandidate],
    )
    return inventory
  }
}
