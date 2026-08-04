import { describe, expect, it } from 'bun:test'

import {
  parseUpdaterManifest,
  resolveLocalArtifactName,
  rewriteManifestUrls,
  rewriteManifestUrlsWithArtifacts,
} from './local-update-server.js'

describe('local update server', () => {
  it('rewrites updater download URLs to the local server', () => {
    const rewritten = rewriteManifestUrls({
      version: '1.3.0',
      platforms: {
        'windows-x86_64': {
          signature: 'signature',
          url: 'https://github.com/OpenAisec/miko/releases/download/v1.3.0/Miko_1.3.0_windows_x64_nsis.exe',
        },
      },
    }, 'http://127.0.0.1:8789') as {
      platforms: Record<string, { url: string }>
    }

    expect(rewritten.platforms['windows-x86_64'].url).toBe(
      'http://127.0.0.1:8789/download/Miko_1.3.0_windows_x64_nsis.exe',
    )
  })

  it('preserves non-url fields', () => {
    const rewritten = rewriteManifestUrls({
      version: '1.3.0',
      notes: 'local test',
      platforms: {
        'windows-x86_64': {
          signature: 'signature',
          url: 'Miko_1.3.0_windows_x64_nsis.exe',
        },
      },
    }, 'http://127.0.0.1:8789') as {
      version: string
      notes: string
      platforms: Record<string, { signature: string }>
    }

    expect(rewritten.version).toBe('1.3.0')
    expect(rewritten.notes).toBe('local test')
    expect(rewritten.platforms['windows-x86_64'].signature).toBe('signature')
  })

  it('keeps exact artifact names when the file exists locally', () => {
    expect(resolveLocalArtifactName('miko_1.3.0_x64-setup.exe', [
      'Miko_1.3.0_windows_x64_nsis.exe',
      'miko_1.3.0_x64-setup.exe',
    ])).toBe('miko_1.3.0_x64-setup.exe')
  })

  it('maps updater URLs to the staged artifact name when build output was renamed', () => {
    const rewritten = rewriteManifestUrlsWithArtifacts({
      version: '1.3.0',
      platforms: {
        'windows-x86_64': {
          signature: 'signature',
          url: 'https://github.com/OpenAisec/miko/releases/download/v1.3.0/miko_1.3.0_x64-setup.exe',
        },
      },
    }, 'http://127.0.0.1:8789', [
      'BUILD_INFO.txt',
      'Miko_1.3.0_windows_x64_nsis.exe',
    ]) as {
      platforms: Record<string, { url: string }>
    }

    expect(rewritten.platforms['windows-x86_64'].url).toBe(
      'http://127.0.0.1:8789/download/Miko_1.3.0_windows_x64_nsis.exe',
    )
  })

  it('accepts PowerShell-written latest.json files with a UTF-8 BOM', () => {
    const manifest = parseUpdaterManifest('\uFEFF{"version":"1.3.0"}') as { version: string }

    expect(manifest.version).toBe('1.3.0')
  })
})
