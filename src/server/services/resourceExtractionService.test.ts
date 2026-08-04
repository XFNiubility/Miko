import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetDataDirForTests, setDataDir } from '../../utils/kimoPaths.js'
import { resourceExtractionService } from './resourceExtractionService.js'
import { securityResourceService } from './securityResourceService.js'

const tempDirs: string[] = []

async function makeTempRoots(): Promise<{ root: string; dataDir: string; workDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'miko-resource-extraction-'))
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

describe('resourceExtractionService', () => {
  it('detects references without reading local paths', () => {
    const refs = resourceExtractionService.detectReferences(
      'D:\\work\\assets 目录下是资产，参考 https://example.com/docs，example.org 是主站，10.0.0.5 是内网地址。',
    )

    expect(refs.some((ref) => ref.type === 'local_directory' && ref.value === 'D:\\work\\assets' && ref.permissionStatus === 'pending')).toBe(true)
    expect(refs.some((ref) => ref.type === 'url' && ref.value === 'https://example.com/docs' && ref.permissionStatus === 'pending')).toBe(true)
    expect(refs.some((ref) => ref.type === 'domain' && ref.value === 'example.org' && ref.permissionStatus === 'not_required')).toBe(true)
    expect(refs.some((ref) => ref.type === 'ip' && ref.value === '10.0.0.5' && ref.permissionStatus === 'not_required')).toBe(true)
  })

  it('writes references and fallback extraction for resource content', async () => {
    const { dataDir } = await makeTempRoots()
    const resource = await securityResourceService.createResource({
      title: '目标范围',
      kind: 'scope_policy',
      summary: '测试范围说明',
      content: 'example.com 是主站，D:\\work\\assets 是资产目录，不要测试支付系统。',
    })

    const extraction = await resourceExtractionService.extract(resource.meta.id)
    const references = await resourceExtractionService.getReferences(resource.meta.id)

    expect(extraction?.status).toBe('waiting_for_permission')
    expect(extraction?.summary).toBe('测试范围说明')
    expect(extraction?.warnings).toContain('未能调用可用模型，当前显示基础整理结果')
    expect(references.some((ref) => ref.type === 'domain' && ref.value === 'example.com')).toBe(true)
    expect(references.some((ref) => ref.type === 'local_directory' && ref.permissionStatus === 'pending')).toBe(true)
    await expect(
      readFile(join(dataDir, 'security', 'resources', resource.meta.id, 'extraction.json'), 'utf-8'),
    ).resolves.toContain('waiting_for_permission')
    await expect(
      readFile(join(dataDir, 'security', 'resources', resource.meta.id, 'references.json'), 'utf-8'),
    ).resolves.toContain('D:\\\\work\\\\assets')
  })

  it('persists queued extraction state before a background run starts', async () => {
    const resource = await securityResourceService.createResource({
      title: 'queued resource',
      kind: 'manual_note',
      content: 'example.com',
    })

    await resourceExtractionService.queueExtraction(resource.meta.id)
    const extraction = await resourceExtractionService.getExtraction(resource.meta.id)

    expect(extraction?.status).toBe('queued')
    expect(extraction?.phase).toBe('queued')
    expect(extraction?.startedAt).toBeNumber()
    expect(extraction?.completedAt).toBeNull()
  })

  it('reads an allowed local file and includes its content in extraction', async () => {
    const { dataDir, workDir } = await makeTempRoots()
    const sourcePath = join(workDir, 'asset-list.txt')
    await writeFile(sourcePath, 'asset.example.com\n10.0.0.7:8080', 'utf-8')
    const resource = await securityResourceService.createResource({
      title: '资产文件',
      kind: 'asset_note',
      content: `资产来源：${sourcePath}`,
    })

    await resourceExtractionService.extract(resource.meta.id)
    const references = await resourceExtractionService.getReferences(resource.meta.id)
    const fileRef = references.find((ref) => ref.type === 'local_file')
    expect(fileRef).toBeTruthy()

    const result = await resourceExtractionService.readReference(resource.meta.id, fileRef!.id)

    expect(result.extraction?.content).toContain('asset.example.com')
    await expect(
      readFile(join(dataDir, 'security', 'resources', resource.meta.id, 'extraction.md'), 'utf-8'),
    ).resolves.toContain('10.0.0.7:8080')
  })
})
