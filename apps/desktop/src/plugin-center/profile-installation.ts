/** Exact installed-Bundle reconciliation and validation for the selected Profile. */

import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  loadProfile,
  readProfileBundleState,
  readProfileManifest,
  reconcileProfileBundles,
  resolveBundleDir,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import type { CatalogVersionPreflight } from '@deepseek-ai/dsh-plugin-center-contracts'

function packagePath(profileDirectory: string, packageName: string): string {
  return join(profileDirectory, 'node_modules', ...packageName.split('/'))
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must hold an object`)
  }
  return value as Record<string, unknown>
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : record(value, label)
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.every(item => typeof item === 'string')
    && value.length === expected.length
    && [...value].sort().every((item, index) => item === [...expected].sort()[index])
}

function patchValues(patch: string, key: 'id' | 'name'): ReadonlySet<string> {
  const values = new Set<string>()
  const expression = key === 'id' ? /^\s*-\s+id:\s+(.+?)\s*$/u : /^\s+name:\s+(.+?)\s*$/u
  for (const line of patch.split(/\r?\n/u)) {
    const matched = line.match(expression)?.[1]?.trim()
    if (matched === undefined) continue
    const unquoted = ((matched.startsWith("'") && matched.endsWith("'"))
      || (matched.startsWith('"') && matched.endsWith('"'))) ? matched.slice(1, -1) : matched
    values.add(unquoted)
  }
  return values
}

function exportsBundle(profileDirectory: string, installAnchor: string, packageName: string): boolean {
  try {
    const directory = resolveBundleDir('desktop', packageName, installAnchor, profileDirectory)
    return readProfileManifest('desktop', directory).dsh?.bundle?.patch !== undefined
  } catch {
    return false
  }
}

/** Reconcile the shared Bundle list and reject any installed identity drift. */
export async function reconcileAndValidateInstalledBundle(input: {
  readonly before: ProfileManifest
  readonly profileDirectory: string
  readonly installAnchor: string
  readonly candidate: CatalogVersionPreflight
  readonly expectedEnabled?: boolean
}): Promise<void> {
  const after = readProfileManifest('desktop', input.profileDirectory)
  if (!(input.candidate.packageName in (after.dependencies ?? {}))) {
    throw new Error('package manager did not retain the validated package as a Profile dependency')
  }
  const reconciliation = reconcileProfileBundles(
    input.before,
    after,
    packageName => exportsBundle(input.profileDirectory, input.installAnchor, packageName),
  )
  if (reconciliation.changed) {
    await writeFileAtomic(
      join(input.profileDirectory, 'package.json'),
      `${JSON.stringify(reconciliation.manifest, null, 2)}\n`,
      { mode: 0o600, dirMode: 0o700 },
    )
  }
  const expectedEnabled = input.expectedEnabled ?? true
  const bundleState = readProfileBundleState(readProfileManifest('desktop', input.profileDirectory))
  if (bundleState.bundles.includes(input.candidate.packageName) !== expectedEnabled
    || bundleState.disabledBundles.includes(input.candidate.packageName) === expectedEnabled) {
    throw new Error(`validated package did not preserve its expected ${expectedEnabled ? 'active' : 'disabled'} Bundle state`)
  }

  const packageDirectory = packagePath(input.profileDirectory, input.candidate.packageName)
  const manifestPath = join(packageDirectory, 'package.json')
  const manifest = record(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown, manifestPath)
  if (manifest['name'] !== input.candidate.packageName || manifest['version'] !== input.candidate.version) {
    throw new Error('installed package identity differs from the validated exact version')
  }
  const dsh = record(manifest['dsh'], `${manifestPath} dsh`)
  const bundle = record(dsh['bundle'], `${manifestPath} dsh.bundle`)
  if (bundle['patch'] !== input.candidate.bundlePatch) {
    throw new Error('installed package activation declaration differs from the validated catalog record')
  }
  const patchPath = resolve(packageDirectory, input.candidate.bundlePatch)
  const fromRoot = relative(packageDirectory, patchPath)
  if (fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\')) {
    throw new Error('installed package Bundle patch resolves outside its package')
  }
  const patch = await readFile(patchPath, 'utf8')
  const ids = patchValues(patch, 'id')
  const names = patchValues(patch, 'name')
  const pluginCenter = optionalRecord(dsh['pluginCenter'], `${manifestPath} dsh.pluginCenter`)
  const declaredClientEvidence = pluginCenter?.['expectedClientModules'] !== undefined
    && sameStrings(pluginCenter['expectedClientModules'], input.candidate.expectedClientModules)
  if (input.candidate.expectedEntries.some(entryId => !ids.has(entryId))
    || (!declaredClientEvidence
      && input.candidate.expectedClientModules.some(moduleName => !names.has(moduleName)))) {
    throw new Error('installed package Bundle patch differs from the catalog activation evidence')
  }
  if (input.candidate.expectedClientModules.includes(input.candidate.packageName)
    && optionalRecord(dsh['client'], `${manifestPath} dsh.client`) === undefined) {
    throw new Error('installed package no longer declares its cataloged client module')
  }
  if ((pluginCenter?.['expectedEntries'] !== undefined
      && !sameStrings(pluginCenter['expectedEntries'], input.candidate.expectedEntries))
    || (pluginCenter?.['expectedClientModules'] !== undefined
      && !sameStrings(pluginCenter['expectedClientModules'], input.candidate.expectedClientModules))
    || (pluginCenter?.['expectedSkillIds'] !== undefined
      && !sameStrings(pluginCenter['expectedSkillIds'], input.candidate.expectedSkillIds))) {
    throw new Error('installed package plugin-center declaration differs from the catalog activation evidence')
  }

  if (expectedEnabled) {
    const home = dirname(dirname(input.profileDirectory))
    const loaded = loadProfile('desktop', 'web', input.installAnchor, home)
    if (!loaded.layers.some(layer => layer.packageName === input.candidate.packageName)) {
      throw new Error('reconciled Profile cannot resolve the validated Bundle layer')
    }
  } else if (!exportsBundle(input.profileDirectory, input.installAnchor, input.candidate.packageName)) {
    throw new Error('disabled validated package no longer resolves as a Bundle')
  }
}

/** Reconcile a removed dependency and require both active and disabled metadata to disappear. */
export async function reconcileAndValidateUninstalledBundle(input: {
  readonly before: ProfileManifest
  readonly profileDirectory: string
  readonly installAnchor: string
  readonly packageName: string
}): Promise<void> {
  const after = readProfileManifest('desktop', input.profileDirectory)
  if (input.packageName in (after.dependencies ?? {})) {
    throw new Error('package manager retained the removed package as a Profile dependency')
  }
  const reconciliation = reconcileProfileBundles(
    input.before,
    after,
    packageName => exportsBundle(input.profileDirectory, input.installAnchor, packageName),
  )
  if (reconciliation.changed) {
    await writeFileAtomic(
      join(input.profileDirectory, 'package.json'),
      `${JSON.stringify(reconciliation.manifest, null, 2)}\n`,
      { mode: 0o600, dirMode: 0o700 },
    )
  }
  const bundleState = readProfileBundleState(reconciliation.manifest)
  if (bundleState.bundles.includes(input.packageName) || bundleState.disabledBundles.includes(input.packageName)) {
    throw new Error('removed package remains in active or disabled Bundle metadata')
  }
}
