import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetDataDirForTests, setDataDir } from '../../utils/kimoPaths.js'
import { securityProjectService } from './securityProjectService.js'
import { sessionTaskService } from './sessionTaskService.js'

const tempDirs: string[] = []

async function makeTempRoots(): Promise<{ root: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'miko-security-projects-'))
  const dataDir = join(root, 'data')
  tempDirs.push(root)
  setDataDir(dataDir)
  await mkdir(dataDir, { recursive: true })
  return { root, dataDir }
}

afterEach(async () => {
  resetDataDirForTests()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('securityProjectService extraction status', () => {
  it('stores project extraction status under the project directory', async () => {
    const { dataDir } = await makeTempRoots()
    const project = await securityProjectService.createProject({
      name: 'Project status',
      target: 'example.com',
      priority: 'P2',
      sessionIds: ['session-a'],
    })

    const queued = await securityProjectService.getExtractionStatus(project.id)
    expect(queued.status).toBe('queued')
    expect(queued.source).toBe('linked_sessions')
    expect(queued.sessionIds).toEqual(['session-a'])

    await securityProjectService.extractFindingsForProject(project.id)
    const completed = await securityProjectService.getExtractionStatus(project.id)
    expect(completed.status).toBe('empty')
    expect(completed.completedAt).toBeNumber()

    await expect(
      readFile(join(dataDir, 'security', project.id, 'extraction-status.json'), 'utf-8'),
    ).resolves.toContain('linked_sessions')

    const tasks = await sessionTaskService.listTasks('session-a')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      type: 'project_from_session',
      status: 'empty',
    })
    expect(tasks[0].targetRefs[0]).toMatchObject({ type: 'project', id: project.id })
  })
})
