import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetDataDirForTests, setDataDir } from '../../utils/kimoPaths.js'
import { sessionTaskService } from './sessionTaskService.js'

const tempDirs: string[] = []

async function makeTempRoots(): Promise<{ root: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'miko-session-tasks-'))
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

describe('sessionTaskService', () => {
  it('stores task json under the owning session task directory', async () => {
    const { dataDir } = await makeTempRoots()

    const task = await sessionTaskService.createTask({
      sessionId: 'session-a',
      type: 'resource_from_session',
      title: 'Extract current session resources',
      status: 'running',
      sourceRefs: [{ type: 'session', id: 'session-a', title: 'Current session' }],
      events: [{
        timestamp: '2026-07-29T00:00:00.000Z',
        level: 'info',
        phase: 'queued',
        message: 'Queued extraction',
      }],
    })

    expect(task.id).toMatch(/^task_/)
    expect(task.sessionId).toBe('session-a')

    const stored = JSON.parse(
      await readFile(join(dataDir, 'security', '_sessions', 'session-a', 'tasks', `${task.id}.json`), 'utf-8'),
    )
    expect(stored.title).toBe('Extract current session resources')
    expect(stored.sourceRefs).toHaveLength(1)
  })

  it('lists, updates, and appends task events without crossing session boundaries', async () => {
    await makeTempRoots()
    const first = await sessionTaskService.createTask({
      sessionId: 'session-a',
      type: 'project_from_session',
      title: 'Build project context',
    })
    await sessionTaskService.createTask({
      sessionId: 'session-b',
      type: 'recon',
      title: 'Other session task',
    })

    const updated = await sessionTaskService.updateTask('session-a', first.id, {
      status: 'done',
      targetRefs: [{ type: 'project', id: 'project-a', title: 'Project A' }],
    })
    expect(updated.status).toBe('done')
    expect(updated.completedAt).toBeNumber()

    const withEvent = await sessionTaskService.appendEvent('session-a', first.id, {
      level: 'info',
      phase: 'done',
      message: 'Project context created',
    })
    expect(withEvent.events.at(-1)?.message).toBe('Project context created')
    expect(withEvent.targetRefs[0]).toMatchObject({ type: 'project', id: 'project-a' })

    const sessionATasks = await sessionTaskService.listTasks('session-a')
    const sessionBTasks = await sessionTaskService.listTasks('session-b')
    expect(sessionATasks.map((task) => task.id)).toEqual([first.id])
    expect(sessionBTasks).toHaveLength(1)
    await expect(sessionTaskService.getTask('session-a', sessionBTasks[0].id)).resolves.toBeNull()
  })

  it('rejects traversal ids before reading task files', async () => {
    await makeTempRoots()

    await expect(sessionTaskService.listTasks('../session-a')).rejects.toThrow('Invalid session id')
    await expect(sessionTaskService.getTask('session-a', '../task')).rejects.toThrow('Invalid task id')
  })
})
