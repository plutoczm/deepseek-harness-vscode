import { describe, expect, it } from 'vitest'
import { resolveMacReleaseArchitecture } from '../scripts/release-mac.ts'

describe('macOS release architecture', () => {
  it('uses the host architecture unless one supported target is explicit', () => {
    expect(resolveMacReleaseArchitecture([], 'arm64')).toBe('arm64')
    expect(resolveMacReleaseArchitecture(['--arm64'], 'x64')).toBe('arm64')
    expect(resolveMacReleaseArchitecture(['--x64'], 'arm64')).toBe('x64')
  })

  it('rejects unsupported architectures and Electron Builder config overrides', () => {
    expect(() => resolveMacReleaseArchitecture([], 'ia32')).toThrow('--arm64 or --x64')
    expect(() => resolveMacReleaseArchitecture(['--universal'], 'arm64')).toThrow('--arm64 or --x64')
    expect(() => resolveMacReleaseArchitecture(['--arm64', '--config.mac.notarize=false'], 'arm64'))
      .toThrow('--arm64 or --x64')
  })
})
