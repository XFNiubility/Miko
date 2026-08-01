import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf-8')) as T
}

function readText(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf-8')
}

function cargoPackageVersion(): string {
  const cargoToml = readText('desktop/src-tauri/Cargo.toml')
  const match = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error('Missing package version in desktop/src-tauri/Cargo.toml')
  return match[1]!
}

describe('desktop release readiness', () => {
  it('keeps desktop package, Tauri config, Cargo, and release notes aligned', () => {
    const desktopPackage = readJson<{ version: string }>('desktop/package.json')
    const tauriConfig = readJson<{ version: string }>('desktop/src-tauri/tauri.conf.json')
    const version = desktopPackage.version

    expect(tauriConfig.version).toBe(version)
    expect(cargoPackageVersion()).toBe(version)
    expect(existsSync(path.join(root, 'release-notes', `v${version}.md`))).toBe(true)
  })

  it('keeps updater signing and latest.json release wiring enabled', () => {
    const tauriConfig = readJson<{
      bundle?: { createUpdaterArtifacts?: boolean }
      plugins?: {
        updater?: {
          pubkey?: string
          endpoints?: string[]
        }
      }
    }>('desktop/src-tauri/tauri.conf.json')
    const workflow = readText('.github/workflows/release-desktop.yml')

    expect(tauriConfig.bundle?.createUpdaterArtifacts).toBe(true)
    expect(tauriConfig.plugins?.updater?.pubkey).toBeTruthy()
    expect(tauriConfig.plugins?.updater?.endpoints ?? []).toContain(
      'https://github.com/OpenAisec/miko/releases/latest/download/latest.json',
    )
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY')
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD')
    expect(workflow).toContain('Validate updater signing configuration')
    expect(workflow).toContain('Cache Tauri bundler tools')
    expect(workflow).toContain('Prepare Windows NSIS tools')
    expect(workflow).toContain('updaterJsonPreferNsis: true')
    expect(workflow).toContain('release-notes/v${{ steps.version.outputs.value }}.md')
  })

  it('keeps Windows installer packaging aligned with the NSIS release path', () => {
    const tauriConfig = readJson<{
      bundle?: {
        resources?: string[]
      }
    }>('desktop/src-tauri/tauri.conf.json')
    const localWindowsBuildScript = readText('desktop/scripts/build-windows-x64.ps1')
    const installerHooks = readText('desktop/src-tauri/windows-installer-hooks.nsh')
    const tauriMain = readText('desktop/src-tauri/src/main.rs')
    const tauriLib = readText('desktop/src-tauri/src/lib.rs')
    const workflow = readText('.github/workflows/release-desktop.yml')
    const releaseConfig = readJson<{ bundle?: { useLocalToolsDir?: boolean } }>(
      'desktop/src-tauri/tauri.release-ci.json',
    )

    expect(workflow).toContain("tauri_args: '--bundles nsis'")
    expect(workflow).toContain('updaterJsonPreferNsis: true')
    expect(localWindowsBuildScript).toContain("else { 'nsis' }")
    expect(localWindowsBuildScript).toContain("'.bun\\bin'")
    expect(localWindowsBuildScript).toContain("'.cargo\\bin'")
    expect(localWindowsBuildScript).toContain("'.build-tools\\nsis-3.11\\nsis-3.11\\Bin'")
    expect(localWindowsBuildScript).toContain("'NSIS'")
    expect(localWindowsBuildScript).toContain('Test-NsisAvailable')
    expect(localWindowsBuildScript).toContain('Ensure-BuildToolPaths')
    expect(localWindowsBuildScript).toContain('useLocalToolsDir')
    expect(releaseConfig.bundle?.useLocalToolsDir).toBe(true)
    expect(tauriMain).toContain('create_env_dir_if_set("KIMO_WORKSPACE_ROOT")')
    expect(tauriMain).toContain('fn default_workspace_root()')
    expect(tauriMain).toContain('join("Documents").join("Miko").join("mikospace")')
    expect(tauriMain).toContain('join("_up_").join("_up_")')
    expect(tauriMain).toContain('join("_up").join("_up")')
    expect(tauriMain).toContain('dir.join("data")')
    expect(tauriLib).toContain('join("_up_").join("_up_")')
    expect(tauriLib).toContain('join("_up").join("_up")')
    expect(tauriLib).toContain('dir.join("data")')
    expect(installerHooks).toContain('/IM miko.exe')
    expect(installerHooks).toContain('/IM claude-sidecar.exe')
    expect(tauriConfig.bundle?.resources ?? []).toEqual(expect.arrayContaining([
      '../../data/agents',
      '../../data/skills',
      '../../data/tools',
      '../../data/marketplace',
    ]))
  })

  it('keeps fflate statically bundled for the compiled desktop sidecar', () => {
    const zipUtils = readText('src/utils/dxt/zip.ts')
    const zipCache = readText('src/utils/plugins/zipCache.ts')
    const sidecarBuild = readText('desktop/scripts/build-sidecars.ts')

    expect(zipUtils).toContain("from 'fflate'")
    expect(zipCache).toContain("from 'fflate'")
    expect(zipUtils).not.toContain("import('fflate')")
    expect(zipCache).not.toContain("import('fflate')")
    expect(sidecarBuild).not.toContain("'fflate'")
  })
})
