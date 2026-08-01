import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetDataDirForTests, setDataDir } from '../../utils/kimoPaths.js'
import { SessionService } from './sessionService.js'

const ENV_KEYS = [
  'KIMO_DATA_ROOT',
  'KIMO_DATA_DIR',
  'CLAUDE_CONFIG_DIR',
  'KIMO_WORKSPACE_ROOT',
] as const

const originalEnv = new Map<string, string | undefined>()
for (const key of ENV_KEYS) {
  originalEnv.set(key, process.env[key])
}

const tempDirs: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'miko-session-workspace-'))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  resetDataDirForTests()
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('SessionService default workspace', () => {
  it('creates the default workspace before validating an empty-session launch', async () => {
    const root = await makeTempRoot()
    const dataDir = join(root, 'data')
    const workspaceDir = join(root, 'mikospace')
    setDataDir(dataDir)
    process.env.KIMO_WORKSPACE_ROOT = workspaceDir

    expect(existsSync(workspaceDir)).toBe(false)

    const result = await new SessionService().createSession()

    expect(result.workDir).toBe(await realpath(workspaceDir))
    expect(existsSync(workspaceDir)).toBe(true)
    expect(existsSync(join(dataDir, 'projects'))).toBe(true)
  })

  it('creates the user-configured default workspace when no workDir is provided', async () => {
    const root = await makeTempRoot()
    const dataDir = join(root, 'data')
    const configuredWorkspace = join(root, 'configured-workspace')
    setDataDir(dataDir)
    process.env.KIMO_WORKSPACE_ROOT = join(root, 'launch-default-workspace')
    await mkdir(dataDir, { recursive: true })
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ defaultWorkspaceDir: configuredWorkspace }),
      'utf-8',
    )

    const result = await new SessionService().createSession()

    expect(result.workDir).toBe(await realpath(configuredWorkspace))
    expect(existsSync(configuredWorkspace)).toBe(true)
    expect(existsSync(process.env.KIMO_WORKSPACE_ROOT)).toBe(false)
  })

  it('does not create a missing directory when the caller passes an explicit workDir', async () => {
    const root = await makeTempRoot()
    const dataDir = join(root, 'data')
    const missingWorkDir = join(root, 'missing-project')
    setDataDir(dataDir)

    await expect(new SessionService().createSession(missingWorkDir)).rejects.toThrow(
      'Working directory does not exist',
    )

    expect(existsSync(missingWorkDir)).toBe(false)
  })

  it('expands tilde in an explicit workDir before validating the launch directory', async () => {
    const root = await makeTempRoot()
    const dataDir = join(root, 'data')
    const workspaceDir = join(root, 'tilde-project')
    const originalHome = process.env.HOME
    const originalUserProfile = process.env.USERPROFILE
    process.env.HOME = root
    process.env.USERPROFILE = root
    setDataDir(dataDir)
    await mkdir(workspaceDir, { recursive: true })

    try {
      const result = await new SessionService().createSession('~\\tilde-project')

      expect(result.workDir).toBe(await realpath(workspaceDir))
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE
      } else {
        process.env.USERPROFILE = originalUserProfile
      }
    }
  })
})
