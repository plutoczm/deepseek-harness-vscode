import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProfileSnapshotStore,
  type ProfileMutationSnapshot,
} from '../src/plugin-center/profile-snapshot-store.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = join(tmpdir(), `dsh-plugin-snapshot-${process.pid}-${String(roots.length)}`)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function expectation(snapshot: ProfileMutationSnapshot) {
  return {
    snapshotId: snapshot.snapshotId,
    snapshotSha256: snapshot.snapshotSha256,
    operationId: snapshot.operationId,
    profileIdentity: snapshot.profileIdentity,
  }
}

describe('Plugin Center Profile snapshot recovery', () => {
  it('restores the complete authority whitelist byte for byte and removes newly-created inputs', async () => {
    const root = await temporaryRoot()
    const profile = join(root, 'profile')
    const snapshots = join(root, 'snapshots')
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    const packageBefore = Buffer.from('{"dependencies":{"old":"1.0.0"}}\n')
    const patchBefore = Buffer.from('- old-bundle\n')
    const modulesBefore = Buffer.from('layoutVersion: 5\n')
    await writeFile(join(profile, 'package.json'), packageBefore)
    await writeFile(join(profile, 'cordis.patch.yml'), patchBefore)
    await writeFile(join(profile, 'node_modules/.modules.yaml'), modulesBefore)

    const store = new ProfileSnapshotStore(profile, snapshots, () => new Date('2026-08-15T01:00:00.000Z'))
    const snapshot = await store.capture('operation-1', '@fixture/dsh-workspace-tools')
    expect(snapshot.files.map(file => [file.path, file.sha256 !== null])).toEqual([
      ['package.json', true],
      ['pnpm-lock.yaml', false],
      ['cordis.patch.yml', true],
      ['node_modules/.modules.yaml', true],
    ])

    await writeFile(join(profile, 'package.json'), '{"dependencies":{"new":"2.0.0"}}\n')
    await writeFile(join(profile, 'pnpm-lock.yaml'), 'new lock\n')
    await rm(join(profile, 'cordis.patch.yml'))
    await writeFile(join(profile, 'node_modules/.modules.yaml'), 'layoutVersion: 9\n')

    await expect(store.restore(expectation(snapshot))).resolves.toEqual(snapshot)
    await expect(readFile(join(profile, 'package.json'))).resolves.toEqual(packageBefore)
    await expect(readFile(join(profile, 'pnpm-lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(profile, 'cordis.patch.yml'))).resolves.toEqual(patchBefore)
    await expect(readFile(join(profile, 'node_modules/.modules.yaml'))).resolves.toEqual(modulesBefore)

    await expect(store.restore(expectation(snapshot))).resolves.toEqual(snapshot)
  })

  it('rejects a damaged snapshot hash before restoring any Profile file', async () => {
    const root = await temporaryRoot()
    const profile = join(root, 'profile')
    const snapshots = join(root, 'snapshots')
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await writeFile(join(profile, 'package.json'), '{"name":"before"}\n')
    const store = new ProfileSnapshotStore(profile, snapshots)
    const snapshot = await store.capture('operation-1', 'fixture-plugin')
    const filename = join(snapshots, 'operation-1/profile-snapshot.json')
    const damaged = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>
    damaged['snapshotSha256'] = 'f'.repeat(64)
    await writeFile(filename, `${JSON.stringify(damaged)}\n`)
    await writeFile(join(profile, 'package.json'), '{"name":"must-stay"}\n')

    await expect(store.restore(expectation(snapshot))).rejects.toMatchObject({
      reasonCode: 'snapshot-hash-mismatch',
    })
    await expect(readFile(join(profile, 'package.json'), 'utf8')).resolves.toBe('{"name":"must-stay"}\n')
  })

  it('rejects a non-whitelisted traversal path without touching the outside canary', async () => {
    const root = await temporaryRoot()
    const profile = join(root, 'profile')
    const snapshots = join(root, 'snapshots')
    const canary = join(root, 'outside.txt')
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await writeFile(join(profile, 'package.json'), '{}\n')
    await writeFile(canary, 'outside\n')
    const store = new ProfileSnapshotStore(profile, snapshots)
    const snapshot = await store.capture('operation-1', 'fixture-plugin')
    const filename = join(snapshots, 'operation-1/profile-snapshot.json')
    const malicious = JSON.parse(await readFile(filename, 'utf8')) as {
      files: Array<Record<string, unknown>>
    }
    malicious.files[0] = { ...malicious.files[0], path: '../outside.txt' }
    await writeFile(filename, `${JSON.stringify(malicious)}\n`)

    await expect(store.restore(expectation(snapshot))).rejects.toMatchObject({
      reasonCode: 'snapshot-path-invalid',
    })
    await expect(readFile(canary, 'utf8')).resolves.toBe('outside\n')
  })

  it.skipIf(process.platform === 'win32')('rejects an authority symlink rather than following it', async () => {
    const root = await temporaryRoot()
    const profile = join(root, 'profile')
    const snapshots = join(root, 'snapshots')
    const canary = join(root, 'outside.txt')
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await writeFile(join(profile, 'package.json'), '{}\n')
    await writeFile(join(profile, 'cordis.patch.yml'), '- before\n')
    await writeFile(canary, 'outside\n')
    const store = new ProfileSnapshotStore(profile, snapshots)
    const snapshot = await store.capture('operation-1', 'fixture-plugin')
    await rm(join(profile, 'cordis.patch.yml'))
    await symlink(canary, join(profile, 'cordis.patch.yml'))

    await expect(store.restore(expectation(snapshot))).rejects.toMatchObject({
      reasonCode: 'snapshot-path-invalid',
    })
    await expect(readFile(canary, 'utf8')).resolves.toBe('outside\n')
  })

  it('rejects a snapshot captured for a different canonical Profile root', async () => {
    const root = await temporaryRoot()
    const profileA = join(root, 'profile-a')
    const profileB = join(root, 'profile-b')
    const snapshots = join(root, 'snapshots')
    await mkdir(join(profileA, 'node_modules'), { recursive: true })
    await mkdir(join(profileB, 'node_modules'), { recursive: true })
    await writeFile(join(profileA, 'package.json'), '{"profile":"a"}\n')
    await writeFile(join(profileB, 'package.json'), '{"profile":"b"}\n')
    const source = new ProfileSnapshotStore(profileA, snapshots)
    const snapshot = await source.capture('operation-1', 'fixture-plugin')
    const wrongProfile = new ProfileSnapshotStore(profileB, snapshots)

    await expect(wrongProfile.restore(expectation(snapshot))).rejects.toThrow('current Profile root')
    await expect(readFile(join(profileB, 'package.json'), 'utf8')).resolves.toBe('{"profile":"b"}\n')
  })

  it('retains the current snapshot and only seven older valid snapshots', async () => {
    const root = await temporaryRoot()
    const profile = join(root, 'profile')
    const snapshots = join(root, 'snapshots')
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await writeFile(join(profile, 'package.json'), '{}\n')
    let minute = 0
    const store = new ProfileSnapshotStore(
      profile,
      snapshots,
      () => new Date(`2026-08-15T01:${String(minute++).padStart(2, '0')}:00.000Z`),
    )
    for (let index = 0; index < 10; index += 1) {
      await store.capture(`operation-${String(index)}`, 'fixture-plugin')
    }

    const retained = (await readdir(snapshots)).sort()
    expect(retained).toHaveLength(8)
    expect(retained).not.toContain('operation-0')
    expect(retained).not.toContain('operation-1')
    expect(retained).toContain('operation-9')
  })
})
