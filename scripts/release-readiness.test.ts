import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { compareSemver, type ReleaseVersionPolicy } from './release-version.js'

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
    const rootPackage = readJson<{ version: string }>('package.json')
    const desktopPackage = readJson<{ version: string }>('desktop/package.json')
    const tauriConfig = readJson<{ version: string }>('desktop/src-tauri/tauri.conf.json')
    const versionPolicy = readJson<ReleaseVersionPolicy>('release/version-policy.json')
    const version = desktopPackage.version

    expect(rootPackage.version).toBe(version)
    expect(tauriConfig.version).toBe(version)
    expect(cargoPackageVersion()).toBe(version)
    expect(existsSync(path.join(root, 'release-notes', `v${version}.md`))).toBe(true)
    expect(versionPolicy.product).toBe('Miko')
    expect(versionPolicy.artifactPrefix).toBe('Miko_')
    expect(compareSemver(version, versionPolicy.historicalPublicVersionFloor)).toBeGreaterThan(0)
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
    expect(workflow).toContain('CLAUDE_CODE_BUN_TARGET=bun-windows-x64')
    expect(workflow).toContain('updaterJsonPreferNsis: true')
    expect(workflow).toContain('release-notes/v${{ steps.version.outputs.value }}.md')
    expect(readText('scripts/release.ts')).toContain("'release/version-policy.json'")
    expect(readText('scripts/release.ts')).toContain("path.join(homedir(), '.cargo')")
    expect(readText('scripts/release.ts')).toContain("process.platform === 'win32' ? 'cargo.exe' : 'cargo'")
  })

  it('keeps public release and build surfaces branded as Miko', () => {
    const releaseWorkflow = readText('.github/workflows/release-desktop.yml')
    const devWorkflow = readText('.github/workflows/build-desktop-dev.yml')
    const releaseSurfaces = [
      releaseWorkflow,
      devWorkflow,
      readText('desktop/scripts/build-windows-x64.ps1'),
      readText('desktop/scripts/build-macos-arm64.sh'),
      readText('desktop/scripts/build-sidecars.ts'),
      readText('desktop/scripts/build-sidecars-debug.ts'),
      readText('desktop/scripts/e2e-slash-plugin-agent-browser.sh'),
      readText('scripts/local-update-server.test.ts'),
    ]
    const legacyProductPattern = new RegExp(['Claude', 'Code', 'Haha'].join('[ -]'), 'i')
    const legacyCliPath = path.join(root, 'bin', ['claude', 'haha'].join('-'))

    for (const surface of releaseSurfaces) {
      expect(surface).not.toMatch(legacyProductPattern)
    }

    expect(releaseWorkflow).toContain("releaseName: 'Miko v__VERSION__'")
    expect(releaseWorkflow).toContain("asset_name_pattern: 'Miko_[version]_windows_x64_[bundle][ext]'")
    expect(devWorkflow).toContain('name: Miko-v${{ steps.version.outputs.version }}-${{ matrix.artifact_name }}')
    expect(existsSync(legacyCliPath)).toBe(false)

    const desktopPackage = readJson<{ name?: string }>('desktop/package.json')
    const tauriConfig = readJson<{ productName?: string; app?: { windows?: Array<{ title?: string }> } }>(
      'desktop/src-tauri/tauri.conf.json',
    )
    expect(desktopPackage.name).toBe('miko-desktop')
    expect(tauriConfig.productName).toBe('Miko')
    expect(tauriConfig.app?.windows?.[0]?.title).toBe('Miko')
    expect(readText('desktop/src-tauri/Cargo.toml')).toContain('name = "miko_desktop_lib"')
    expect(readText('desktop/src-tauri/src/main.rs')).toContain('miko_desktop_lib::run()')
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
    expect(localWindowsBuildScript).toContain('$buildStartedAt = Get-Date')
    expect(localWindowsBuildScript).toContain('Where-Object { $_.LastWriteTime -ge $buildStartedAt }')
    expect(localWindowsBuildScript).toContain('if ($hasTauriSigningKey) {')
    expect(localWindowsBuildScript).toContain("if ($windowsBundle -eq 'nsis') { @('*.exe') }")
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

  it('keeps the release quality entrypoints executable from package scripts', () => {
    const rootPackage = readJson<{ scripts?: Record<string, string> }>('package.json')
    const desktopPackage = readJson<{ scripts?: Record<string, string> }>('desktop/package.json')
    const rootScripts = rootPackage.scripts ?? {}
    const desktopScripts = desktopPackage.scripts ?? {}

    expect(rootScripts['check:server']).toContain('bun test')
    expect(rootScripts['check:desktop']).toContain('bun run test')
    expect(rootScripts['check:persistence-upgrade']).toContain('marketplace-auth.test.ts')
    expect(rootScripts['check:release']).toContain('release-readiness.test.ts')
    expect(rootScripts['check:native']).toBe('bun run scripts/check-native.ts')
    expect(rootScripts.verify).toContain('bun run check:server')
    expect(rootScripts.verify).toContain('bun run check:native')
    expect(desktopScripts.test).toBe('vitest run')

    const nativeCheck = readText('scripts/check-native.ts')
    expect(nativeCheck).toContain("path.join(homedir(), '.cargo')")
    expect(nativeCheck).toContain("env.CLAUDE_CODE_BUN_TARGET = 'bun-windows-x64'")
    expect(nativeCheck).toContain("'run', 'build:sidecars'")
    expect(nativeCheck).toContain("'cargo', 'check'")
  })
})
