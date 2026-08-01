import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetDataDirForTests, setDataDir } from '../../utils/kimoPaths.js'
import { SettingsService } from './settingsService.js'

const tempDirs: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'miko-settings-workspace-'))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  resetDataDirForTests()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('SettingsService default workspace', () => {
  it('normalizes, creates, and clears the user default workspace setting', async () => {
    const root = await makeTempRoot()
    const dataDir = join(root, 'data')
    const workspaceDir = join(root, 'custom-workspace')
    setDataDir(dataDir)

    const service = new SettingsService()
    await service.updateUserSettings({ defaultWorkspaceDir: workspaceDir })

    expect(existsSync(workspaceDir)).toBe(true)
    expect(await service.getUserSettings()).toMatchObject({
      defaultWorkspaceDir: workspaceDir,
    })

    await service.updateUserSettings({ defaultWorkspaceDir: null })

    const settingsText = await readFile(join(dataDir, 'settings.json'), 'utf-8')
    expect(settingsText).not.toContain('defaultWorkspaceDir')
  })

  it('resolves relative default workspace paths beside the data root', async () => {
    const root = await makeTempRoot()
    const dataDir = join(root, 'data')
    setDataDir(dataDir)

    const service = new SettingsService()
    await service.updateUserSettings({ defaultWorkspaceDir: 'workspace' })

    expect(await service.getUserSettings()).toMatchObject({
      defaultWorkspaceDir: join(root, 'workspace'),
    })
    expect(existsSync(join(root, 'workspace'))).toBe(true)
  })
})
