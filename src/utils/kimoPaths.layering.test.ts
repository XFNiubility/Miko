import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  getBuiltinSkillsDir,
  getBundledMarketplaceLocalCatalogFile,
  getDefaultWorkspaceDir,
  getLocalUpdateManifestFile,
  getMarketplaceLocalCatalogFile,
  resetDataDirForTests,
  getSkillsDir,
  getUpdateManifestCacheFile,
  resolveDataDirFromEnv,
} from './kimoPaths.js'

const ENV_KEYS = [
  'KIMO_DATA_ROOT',
  'KIMO_DATA_DIR',
  'CLAUDE_CONFIG_DIR',
  'KIMO_BUNDLED_DATA_ROOT',
  'KIMO_BUILTIN_SKILLS_DIR',
  'KIMO_WORKSPACE_ROOT',
] as const

const originalEnv = new Map<string, string | undefined>()
for (const key of ENV_KEYS) {
  originalEnv.set(key, process.env[key])
}

const tempRoots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'miko-paths-'))
  tempRoots.push(root)
  return root
}

beforeEach(() => {
  resetDataDirForTests()
})

afterEach(() => {
  resetDataDirForTests()
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('kimoPaths layered roots', () => {
  it('treats KIMO_DATA_ROOT as the exact user data root', () => {
    expect(
      resolveDataDirFromEnv({
        KIMO_DATA_ROOT: 'D:\\Miko\\data',
        KIMO_DATA_DIR: 'D:\\Legacy',
      }),
    ).toBe('D:\\Miko\\data')

    expect(resolveDataDirFromEnv({ KIMO_DATA_DIR: 'D:\\Legacy' })).toBe('D:\\Legacy\\data')
  })

  it('uses bundled skills only when the bundled directory exists', () => {
    const root = tempRoot()
    const dataRoot = join(root, 'userdata', 'data')
    const bundledRoot = join(root, 'bundled-data')
    process.env.KIMO_DATA_ROOT = dataRoot
    process.env.KIMO_BUNDLED_DATA_ROOT = bundledRoot

    expect(getBuiltinSkillsDir()).toBe(getSkillsDir())

    mkdirSync(join(bundledRoot, 'skills'), { recursive: true })
    expect(getBuiltinSkillsDir()).toBe(join(bundledRoot, 'skills'))
  })

  it('uses KIMO_WORKSPACE_ROOT before deriving mikospace from the data root', () => {
    const root = tempRoot()
    process.env.KIMO_DATA_ROOT = join(root, 'userdata', 'data')

    expect(getDefaultWorkspaceDir()).toBe(join(root, 'userdata', 'mikospace'))

    process.env.KIMO_WORKSPACE_ROOT = join(root, 'mikospace')
    expect(getDefaultWorkspaceDir()).toBe(join(root, 'mikospace'))
  })

  it('uses the user-configured default workspace before the launch default', () => {
    const root = tempRoot()
    const dataRoot = join(root, 'data')
    const configuredWorkspace = join(root, 'configured-workspace')
    mkdirSync(dataRoot, { recursive: true })
    writeFileSync(
      join(dataRoot, 'settings.json'),
      JSON.stringify({ defaultWorkspaceDir: configuredWorkspace }),
      'utf-8',
    )
    process.env.KIMO_DATA_ROOT = dataRoot
    process.env.KIMO_WORKSPACE_ROOT = join(root, 'launch-default-workspace')

    expect(getDefaultWorkspaceDir()).toBe(configuredWorkspace)
  })

  it('keeps local marketplace and update manifests under the user data root', () => {
    const root = tempRoot()
    process.env.KIMO_DATA_ROOT = join(root, 'userdata', 'data')

    expect(getMarketplaceLocalCatalogFile()).toBe(
      join(root, 'userdata', 'data', 'marketplace', 'catalog.local.json'),
    )
    expect(getLocalUpdateManifestFile()).toBe(
      join(root, 'userdata', 'data', 'updates', 'update.local.json'),
    )
    expect(getUpdateManifestCacheFile()).toBe(
      join(root, 'userdata', 'data', 'updates', 'manifest-cache.json'),
    )
  })

  it('keeps bundled marketplace catalog under the bundled data root', () => {
    const root = tempRoot()
    process.env.KIMO_DATA_ROOT = join(root, 'userdata', 'data')
    process.env.KIMO_BUNDLED_DATA_ROOT = join(root, 'bundled-data')

    expect(getBundledMarketplaceLocalCatalogFile()).toBe(
      join(root, 'bundled-data', 'marketplace', 'catalog.local.json'),
    )
  })
})
