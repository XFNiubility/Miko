import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetDataDirForTests, setDataDir } from '../../utils/kimoPaths.js'
import { handleUpdatesApi } from './updates.js'

const originalFetch = globalThis.fetch
const tempDirs: string[] = []

afterEach(async () => {
  globalThis.fetch = originalFetch
  resetDataDirForTests()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('updates API', () => {
  it('returns a readable bad request when the resource update endpoint is unreachable', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'miko-updates-api-'))
    tempDirs.push(dataDir)
    setDataDir(dataDir)
    await mkdir(dataDir, { recursive: true })
    globalThis.fetch = (async () => {
      throw new TypeError('connection refused')
    }) as typeof fetch

    const request = new Request('http://127.0.0.1/api/updates/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifestUrl: 'http://updates.example.test/update.json' }),
    })
    const response = await handleUpdatesApi(
      request,
      new URL(request.url),
      ['api', 'updates', 'refresh'],
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'Unable to reach resource update endpoint http://updates.example.test/update.json: connection refused',
    })
  })
})
