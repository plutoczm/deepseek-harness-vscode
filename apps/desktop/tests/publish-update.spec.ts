import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectReleaseBundle,
  publishReleaseBundle,
  type ReleaseObjectStore,
  type ReleasePayload,
} from '../scripts/publish-update.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop update publisher', () => {
  it('validates channel metadata, payload hashes, and blockmaps', () => {
    const directory = releaseDirectory('rc.yml', 'Harness Setup.exe')
    const bundle = collectReleaseBundle([directory], { currentVersion: '1.2.3-rc.4', allowCurrentBaseline: false })
    expect(bundle).toMatchObject({ version: '1.2.3-rc.4', channel: 'rc' })
    expect(bundle.payloads.map(payload => payload.kind).sort()).toEqual(['artifact', 'blockmap', 'metadata'])
  })

  it('requires a macOS ZIP except for an explicit same-version baseline', () => {
    const directory = releaseDirectory('rc-mac.yml', 'Harness.dmg')
    expect(() => collectReleaseBundle([directory], {
      currentVersion: '1.2.3-rc.4',
      allowCurrentBaseline: false,
    })).toThrow('缺少 ZIP')
    expect(collectReleaseBundle([directory], {
      currentVersion: '1.2.3-rc.4',
      allowCurrentBaseline: true,
    }).version).toBe('1.2.3-rc.4')
  })

  it('rejects metadata paths that escape the release directory', () => {
    const directory = releaseDirectory('rc.yml', '../outside.exe')
    expect(() => collectReleaseBundle([directory], {
      currentVersion: '1.2.3-rc.4',
      allowCurrentBaseline: false,
    })).toThrow('只允许同目录文件名')
  })

  it('uploads immutable files before publishing mutable channel metadata', async () => {
    const directory = releaseDirectory('rc.yml', 'Harness Setup.exe')
    const bundle = collectReleaseBundle([directory], { currentVersion: '1.2.3-rc.4', allowCurrentBaseline: false })
    const uploaded: ReleasePayload[] = []
    const stored = new Map<string, ReleasePayload>()
    const store: ReleaseObjectStore = {
      head: (objectKey) => {
        const payload = stored.get(objectKey)
        return Promise.resolve(payload === undefined ? undefined : { size: payload.size, sha512: payload.sha512 })
      },
      put: (payload) => {
        uploaded.push(payload)
        stored.set(payload.objectKey, payload)
        return Promise.resolve()
      },
    }
    const verified: string[] = []
    await publishReleaseBundle(bundle, store, (payload) => {
      verified.push(payload.objectKey)
      return Promise.resolve()
    })
    expect(uploaded.at(-1)?.kind).toBe('metadata')
    expect(verified).toEqual([expect.stringMatching(/rc\.yml$/)])
  })
})

function releaseDirectory(metadataName: string, artifactName: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-update-publish-'))
  temporaryRoots.push(root)
  mkdirSync(root, { recursive: true })
  const safeName = artifactName.includes('/') ? 'outside.exe' : artifactName
  const artifact = Buffer.from('installer bytes')
  const blockmap = Buffer.from('blockmap bytes')
  writeFileSync(join(root, safeName), artifact)
  writeFileSync(join(root, `${safeName}.blockmap`), blockmap)
  const sha512 = createHash('sha512').update(artifact).digest('base64')
  writeFileSync(join(root, metadataName), [
    'version: 1.2.3-rc.4',
    'files:',
    `  - url: ${artifactName}`,
    `    sha512: ${sha512}`,
    `    size: ${String(artifact.length)}`,
    `path: ${artifactName}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-08-15T00:00:00.000Z'",
    '',
  ].join('\n'))
  return root
}
