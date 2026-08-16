import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/desktop-release.yml'), 'utf8')
const chineseReadme = readFileSync(resolve(repositoryRoot, 'README.md'), 'utf8')
const englishReadme = readFileSync(resolve(repositoryRoot, 'README.en.md'), 'utf8')

describe('desktop GitHub Release workflow', () => {
  it('binds release assets to one exact Desktop tag and both native builds', () => {
    expect(workflow).toContain('desktop-v${version}')
    expect(workflow).toContain('elif [[ "$version" == *-* ]]')
    expect(workflow).toContain('needs: [prepare, macos, windows]')
    expect(workflow).toContain('run dist:mac -- --arm64')
    expect(workflow).toContain("$env:DSH_DESKTOP_TARGET_PLATFORM = 'win32'")
    expect(workflow).toContain("$env:DSH_DESKTOP_TARGET_ARCH = 'x64'")
  })

  it('requires native signatures and publishes only a complete draft with checksums', () => {
    expect(workflow).toContain('spctl --assess --type execute')
    expect(workflow).toContain('xcrun stapler validate')
    expect(workflow).toContain('Get-AuthenticodeSignature')
    expect(workflow).toContain('! -name SHA256SUMS -print0')
    expect(workflow).toContain('release-assets/SHA256SUMS')
    expect(workflow).toContain('--draft')
    expect(workflow.indexOf('gh release create')).toBeLessThan(workflow.indexOf('gh release edit'))
    expect(workflow).toContain('gh release edit "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --draft=false')
  })

  it('keeps the bilingual public download entry on the Studio repository', () => {
    for (const readme of [chineseReadme, englishReadme]) {
      expect(readme).toContain('https://github.com/fufankeji/deepseek-harness-studio/releases')
      expect(readme).toContain('SHA256SUMS')
      expect(readme).not.toContain('https://github.com/fufankeji/deepseek-harness-desktop')
    }
    expect(chineseReadme).toContain('下载 Windows x64')
    expect(englishReadme).toContain('Download the Windows x64')
  })
})
