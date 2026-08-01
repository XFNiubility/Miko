import { afterEach, describe, expect, it } from 'bun:test'
import { Buffer } from 'node:buffer'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetDataDirForTests, setDataDir } from '../../utils/kimoPaths.js'
import { securityResourceService } from './securityResourceService.js'
import { sessionTaskService } from './sessionTaskService.js'
import { sessionService } from './sessionService.js'

const tempDirs: string[] = []

async function makeTempRoots(): Promise<{ root: string; dataDir: string; workDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'miko-security-resources-'))
  const dataDir = join(root, 'data')
  const workDir = join(root, 'workspace')
  tempDirs.push(root)
  setDataDir(dataDir)
  await mkdir(dataDir, { recursive: true })
  await mkdir(workDir, { recursive: true })
  return { root, dataDir, workDir }
}

afterEach(async () => {
  resetDataDirForTests()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('securityResourceService', () => {
  it('stores resources under data/security/resources and builds prompt context', async () => {
    const { dataDir } = await makeTempRoots()

    const created = await securityResourceService.createResource({
      title: '目标资产清单',
      kind: 'asset_note',
      tags: ['asset', 'recon', 'asset'],
      summary: '包含本次会话要参考的目标范围。',
      content: 'example.com\n10.0.0.5:8080',
    })

    expect(created.meta.id).toMatch(/^res_/)
    expect(created.meta.tags).toEqual(['asset', 'recon'])

    const storedMeta = JSON.parse(
      await readFile(join(dataDir, 'security', 'resources', created.meta.id, 'meta.json'), 'utf-8'),
    )
    expect(storedMeta.title).toBe('目标资产清单')

    const promptItems = await securityResourceService.getPromptResources([created.meta.id])
    expect(promptItems).toHaveLength(1)
    expect(promptItems[0]).toMatchObject({
      title: '目标资产清单',
      kind: 'asset_note',
      summary: '包含本次会话要参考的目标范围。',
    })
    expect(securityResourceService.buildPromptBlock(promptItems)).toContain('Current session linked resources')
    expect(securityResourceService.buildPromptBlock(promptItems)).toContain('example.com')
  })

  it('persists linked resource ids as session metadata without copying content', async () => {
    const { workDir } = await makeTempRoots()
    const resource = await securityResourceService.createResource({
      title: '测试范围',
      kind: 'scope_policy',
      content: 'Do not scan outside example.com',
    })
    const { sessionId, workDir: resolvedWorkDir } = await sessionService.createSession(workDir)

    const linkedIds = await sessionService.setLinkedSecurityResourceIds(sessionId, [resource.meta.id])
    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)

    expect(linkedIds).toEqual([resource.meta.id])
    expect(launchInfo?.workDir).toBe(resolvedWorkDir)
    expect(launchInfo?.linkedSecurityResourceIds).toEqual([resource.meta.id])
    expect(await sessionService.getLinkedSecurityResourceIds(sessionId)).toEqual([resource.meta.id])
  })

  it('imports text files into content and keeps a copied attachment', async () => {
    const { root, dataDir } = await makeTempRoots()
    const sourcePath = join(root, 'asset-list.txt')
    await writeFile(sourcePath, 'example.com\n10.0.0.5:8080', 'utf-8')

    const resource = await securityResourceService.importFiles({
      paths: [sourcePath],
      kind: 'recon_result',
      tags: ['import', 'asset'],
    })

    expect(resource.meta.title).toBe('asset-list.txt')
    expect(resource.meta.kind).toBe('recon_result')
    expect(resource.content).toContain('example.com')
    expect(resource.files.map((file) => file.name)).toEqual(['asset-list.txt'])
    await expect(
      readFile(join(dataDir, 'security', 'resources', resource.meta.id, 'files', 'asset-list.txt'), 'utf-8'),
    ).resolves.toContain('10.0.0.5:8080')
  })

  it('imports uploaded browser files into the same resource storage', async () => {
    const { dataDir } = await makeTempRoots()
    const resource = await securityResourceService.importFiles({
      files: [{
        name: 'browser-scope.md',
        dataBase64: Buffer.from('# Scope\n\nexample.org only', 'utf-8').toString('base64'),
        mimeType: 'text/markdown',
        size: 25,
      }],
      kind: 'scope_policy',
      tags: ['upload'],
    })

    expect(resource.meta.title).toBe('browser-scope.md')
    expect(resource.meta.kind).toBe('scope_policy')
    expect(resource.content).toContain('example.org only')
    expect(resource.files.map((file) => file.name)).toEqual(['browser-scope.md'])
    await expect(
      readFile(join(dataDir, 'security', 'resources', resource.meta.id, 'files', 'browser-scope.md'), 'utf-8'),
    ).resolves.toContain('example.org only')
  })

  it('creates a reusable resource from session transcript messages', async () => {
    const { dataDir, workDir } = await makeTempRoots()
    const { sessionId } = await sessionService.createSession(workDir)
    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
    expect(launchInfo?.filePath).toBeTruthy()
    const now = new Date().toISOString()
    await appendFile(launchInfo!.filePath, [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        timestamp: now,
        message: { role: 'user', content: '请整理 example.net 和 10.0.0.9 的测试范围' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: now,
        message: { role: 'assistant', content: [{ type: 'text', text: '结论：example.net 是主站，10.0.0.9 是内网资产。' }] },
      }),
      '',
    ].join('\n'), 'utf-8')

    const resource = await securityResourceService.createResourceFromSessions({
      sessionIds: [sessionId],
    })

    expect(resource.meta.sourceType).toBe('session_ref')
    expect(resource.meta.sourceRefs?.[0]).toMatchObject({ type: 'session', id: sessionId })
    expect(resource.content).toContain('example.net')
    expect(resource.content).toContain('10.0.0.9')
    await expect(
      readFile(join(dataDir, 'security', 'resources', resource.meta.id, 'content.md'), 'utf-8'),
    ).resolves.toContain('结论')

    const promptItems = await securityResourceService.getPromptResources([resource.meta.id])
    expect(securityResourceService.buildPromptBlock(promptItems)).toContain('example.net')

    const tasks = await sessionTaskService.listTasks(sessionId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      type: 'resource_from_session',
      status: 'done',
    })
    expect(tasks[0].targetRefs[0]).toMatchObject({ type: 'resource', id: resource.meta.id })
  })
})
