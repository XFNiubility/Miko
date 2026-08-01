import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetDataDirForTests, setDataDir } from '../../utils/kimoPaths.js'
import { handleSecurityApi } from './security.js'

const tempDirs: string[] = []

async function makeTempRoots(): Promise<{ root: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'miko-security-task-api-'))
  const dataDir = join(root, 'data')
  tempDirs.push(root)
  setDataDir(dataDir)
  await mkdir(dataDir, { recursive: true })
  return { root, dataDir }
}

function securityRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  })
}

async function callSecurity(method: string, path: string, body?: unknown): Promise<Response> {
  return handleSecurityApi(
    securityRequest(method, path, body),
    new URL(`http://127.0.0.1${path}`),
    path.split('/').filter(Boolean),
  )
}

afterEach(async () => {
  resetDataDirForTests()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('security session task API', () => {
  it('creates and lists client-visible session tasks', async () => {
    await makeTempRoots()

    const createResponse = await callSecurity('POST', '/api/security/sessions/session-a/tasks', {
      type: 'skill_create',
      title: 'Create Skill - demo',
      status: 'running',
      targetRefs: [{ type: 'skill', id: 'demo', title: 'demo' }],
      events: [{
        timestamp: '2026-07-29T00:00:00.000Z',
        level: 'info',
        phase: 'started',
        message: 'Started skill creator',
      }],
    })
    expect(createResponse.status).toBe(201)
    const created = await createResponse.json() as { task: { id: string; status: string } }
    expect(created.task.status).toBe('running')

    const listResponse = await callSecurity('GET', '/api/security/sessions/session-a/tasks')
    expect(listResponse.status).toBe(200)
    const listed = await listResponse.json() as { tasks: Array<{ id: string; type: string }> }
    expect(listed.tasks.map((task) => ({ id: task.id, type: task.type }))).toEqual([
      { id: created.task.id, type: 'skill_create' },
    ])
  })

  it('allows client failure updates but rejects client completion spoofing', async () => {
    await makeTempRoots()

    const createResponse = await callSecurity('POST', '/api/security/sessions/session-a/tasks', {
      type: 'skill_create',
      title: 'Create Skill - demo',
    })
    const created = await createResponse.json() as { task: { id: string } }

    const failedResponse = await callSecurity('PATCH', `/api/security/sessions/session-a/tasks/${created.task.id}`, {
      status: 'failed',
      event: {
        level: 'error',
        phase: 'failed',
        message: 'Agent run failed',
      },
    })
    expect(failedResponse.status).toBe(200)
    const failed = await failedResponse.json() as { task: { status: string; events: Array<{ message: string }> } }
    expect(failed.task.status).toBe('failed')
    expect(failed.task.events.at(-1)?.message).toBe('Agent run failed')

    const doneResponse = await callSecurity('PATCH', `/api/security/sessions/session-a/tasks/${created.task.id}`, {
      status: 'done',
    })
    expect(doneResponse.status).toBe(400)
  })
})
