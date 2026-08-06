import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { unzipFile } from '../utils/dxt/zip.js'
import {
  getBundledDataDir,
  getDataDir,
  getLocalUpdateManifestFile,
  getMarketplaceCatalogCacheFile,
  getUpdateManifestCacheFile,
  getUpdatesDir,
} from '../utils/kimoPaths.js'
import {
  ResourceSignatureVerificationError,
  verifyResourceSignature,
} from './resourceSignature.js'

export type UpdateResourceType = 'builtin-bundle' | 'marketplace-catalog'

export type UpdateManifest = {
  schemaVersion: 1
  source: 'local' | 'cache' | 'empty'
  generatedAt?: string
  currentVersion: string
  latestVersion?: string
  channel?: string
  notes?: string
  packageUrl?: string
  sha256?: string
  signature?: string
  bundledDataVersion?: string
  resources?: Array<{
    id: string
    type: UpdateResourceType
    version: string
    packageUrl?: string
    sha256?: string
    signature?: string
  }>
}

export type ResourceUpdateStatus = {
  schemaVersion: 1
  state: 'idle' | 'refreshed' | 'applying' | 'applied' | 'rolled-back' | 'error'
  updatedAt?: string
  manifest?: UpdateManifest
  appliedResources?: Array<{
    id: string
    type: UpdateResourceType
    version: string
  }>
  error?: string
}

export class UpdateServiceError extends Error {
  constructor(
    public code: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'UNSUPPORTED',
    message: string,
  ) {
    super(message)
    this.name = 'UpdateServiceError'
  }
}

const EMPTY_STATUS: ResourceUpdateStatus = {
  schemaVersion: 1,
  state: 'idle',
}

const DEFAULT_UPDATE_MANIFEST_URL = 'http://8.134.211.101/updates/update.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function getCurrentVersion(): string {
  return process.env.APP_VERSION || '999.0.0-local'
}

function getStatusFile(): string {
  return path.join(getUpdatesDir(), 'status.json')
}

function getStagingDir(): string {
  return path.join(getUpdatesDir(), 'staging')
}

function getBackupDir(): string {
  return path.join(getUpdatesDir(), 'backup')
}

function getBundledDataBackupDir(): string {
  return path.join(getBackupDir(), 'bundled-data')
}

function getMarketplaceCatalogBackupFile(): string {
  return path.join(getBackupDir(), 'marketplace-catalog-cache.json')
}

function getMarketplaceCatalogBackupMetaFile(): string {
  return path.join(getBackupDir(), 'marketplace-catalog-cache.meta.json')
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    if (!raw.trim()) return null
    return JSON.parse(raw) as unknown
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
    await fs.rename(tempPath, filePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function backupGeneratedFile(sourcePath: string, backupPath: string, metaPath: string): Promise<void> {
  await fs.mkdir(path.dirname(backupPath), { recursive: true })
  await fs.rm(backupPath, { recursive: true, force: true })
  const existed = await fileExists(sourcePath)
  if (existed) {
    await fs.cp(sourcePath, backupPath, { recursive: true })
  }
  await writeJsonFile(metaPath, {
    schemaVersion: 1,
    existed,
  })
}

async function restoreGeneratedFileBackup(
  targetPath: string,
  backupPath: string,
  metaPath: string,
): Promise<boolean> {
  const rawMeta = await readJsonFile(metaPath)
  if (!isRecord(rawMeta) || rawMeta.schemaVersion !== 1 || typeof rawMeta.existed !== 'boolean') {
    return false
  }

  await fs.rm(targetPath, { recursive: true, force: true })
  if (rawMeta.existed) {
    if (!(await fileExists(backupPath))) {
      throw new UpdateServiceError('NOT_FOUND', `Rollback backup is missing: ${backupPath}`)
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.cp(backupPath, targetPath, { recursive: true })
  }
  return true
}

function normalizeResources(value: unknown): UpdateManifest['resources'] {
  if (!Array.isArray(value)) return undefined
  const resources = value.flatMap((item) => {
    if (!isRecord(item)) return []
    const id = asString(item.id)
    const type = item.type
    const version = asString(item.version)
    if (!id || !version || (type !== 'builtin-bundle' && type !== 'marketplace-catalog')) {
      return []
    }
    return [{
      id,
      type,
      version,
      packageUrl: asString(item.packageUrl),
      sha256: asString(item.sha256),
      signature: asString(item.signature),
    }]
  })
  return resources.length > 0 ? resources : undefined
}

function normalizeManifest(value: unknown, source: UpdateManifest['source']): UpdateManifest {
  if (!isRecord(value)) {
    return {
      schemaVersion: 1,
      source: 'empty',
      currentVersion: getCurrentVersion(),
    }
  }

  return {
    schemaVersion: 1,
    source,
    generatedAt: asString(value.generatedAt),
    currentVersion: getCurrentVersion(),
    latestVersion: asString(value.latestVersion),
    channel: asString(value.channel),
    notes: asString(value.notes),
    packageUrl: asString(value.packageUrl),
    sha256: asString(value.sha256),
    signature: asString(value.signature),
    bundledDataVersion: asString(value.bundledDataVersion),
    resources: normalizeResources(value.resources),
  }
}

function normalizeStatus(value: unknown): ResourceUpdateStatus {
  if (!isRecord(value) || value.schemaVersion !== 1) return { ...EMPTY_STATUS }
  const state = value.state
  if (
    state !== 'idle'
    && state !== 'refreshed'
    && state !== 'applying'
    && state !== 'applied'
    && state !== 'rolled-back'
    && state !== 'error'
  ) {
    return { ...EMPTY_STATUS }
  }
  return {
    schemaVersion: 1,
    state,
    updatedAt: asString(value.updatedAt),
    manifest: isRecord(value.manifest) ? normalizeManifest(value.manifest, value.manifest.source === 'cache' ? 'cache' : 'local') : undefined,
    appliedResources: Array.isArray(value.appliedResources)
      ? value.appliedResources.flatMap((item) => {
          if (!isRecord(item)) return []
          const id = asString(item.id)
          const type = item.type
          const version = asString(item.version)
          if (!id || !version || (type !== 'builtin-bundle' && type !== 'marketplace-catalog')) return []
          return [{ id, type, version }]
        })
      : undefined,
    error: asString(value.error),
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

function resolveHttpUrl(raw: string, label: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new UpdateServiceError('BAD_REQUEST', `Invalid ${label} URL: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UpdateServiceError('BAD_REQUEST', `Unsupported ${label} URL protocol: ${parsed.protocol}`)
  }
  return parsed
}

function normalizeSha256(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new UpdateServiceError('BAD_REQUEST', `Invalid sha256: ${value}`)
  }
  return normalized
}

function hashSha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

async function fetchJson(url: URL): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new UpdateServiceError('BAD_REQUEST', `Unable to reach resource update endpoint ${url}: ${detail}`)
  }
  if (!response.ok) {
    throw new UpdateServiceError('BAD_REQUEST', `Request failed for ${url}: ${response.status} ${response.statusText}`)
  }
  return response.json().catch(() => {
    throw new UpdateServiceError('BAD_REQUEST', `Response is not valid JSON: ${url}`)
  })
}

async function fetchFile(url: URL): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new UpdateServiceError('BAD_REQUEST', `Unable to download resource package ${url}: ${detail}`)
  }
  if (!response.ok) {
    throw new UpdateServiceError('BAD_REQUEST', `File request failed for ${url}: ${response.status} ${response.statusText}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

function assertInside(parent: string, child: string): void {
  const relativePath = path.relative(parent, child)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new UpdateServiceError('BAD_REQUEST', `Update package path escapes target directory: ${child}`)
  }
}

function assertBundledDataTargetAllowed(): string {
  const bundledDir = path.resolve(getBundledDataDir())
  const dataDir = path.resolve(getDataDir())
  if (bundledDir === dataDir || path.relative(dataDir, bundledDir).startsWith('..') === false) {
    throw new UpdateServiceError(
      'CONFLICT',
      `Refusing to update bundled-data because it resolves inside the user data root: ${bundledDir}`,
    )
  }
  return bundledDir
}

async function writeZipToDirectory(zipData: Uint8Array, targetDir: string): Promise<void> {
  const files = await unzipFile(Buffer.from(zipData))
  await fs.mkdir(targetDir, { recursive: true })
  for (const [entryPath, content] of Object.entries(files)) {
    if (entryPath.endsWith('/')) continue
    const targetPath = path.join(targetDir, entryPath)
    assertInside(targetDir, targetPath)
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, content)
  }
}

async function writeStatus(status: ResourceUpdateStatus): Promise<ResourceUpdateStatus> {
  const next = {
    ...status,
    schemaVersion: 1 as const,
    updatedAt: new Date().toISOString(),
  }
  await writeJsonFile(getStatusFile(), next)
  return next
}

export async function checkLocalUpdateManifest(): Promise<UpdateManifest> {
  const localFile = getLocalUpdateManifestFile()
  if (await fileExists(localFile)) {
    return normalizeManifest(await readJsonFile(localFile), 'local')
  }

  const cacheFile = getUpdateManifestCacheFile()
  if (await fileExists(cacheFile)) {
    return normalizeManifest(await readJsonFile(cacheFile), 'cache')
  }

  return {
    schemaVersion: 1,
    source: 'empty',
    currentVersion: getCurrentVersion(),
  }
}

export async function getResourceUpdateStatus(): Promise<ResourceUpdateStatus> {
  const raw = await readJsonFile(getStatusFile())
  if (raw === null) return { ...EMPTY_STATUS, manifest: await checkLocalUpdateManifest() }
  return normalizeStatus(raw)
}

export async function refreshUpdateManifest(manifestUrl?: string): Promise<UpdateManifest> {
  const rawUrl = manifestUrl?.trim() || process.env.KIMO_UPDATE_MANIFEST_URL?.trim() || DEFAULT_UPDATE_MANIFEST_URL
  const manifest = normalizeManifest(await fetchJson(resolveHttpUrl(rawUrl, 'update manifest')), 'cache')
  await writeJsonFile(getUpdateManifestCacheFile(), {
    ...manifest,
    source: 'cache',
  })
  await writeStatus({
    schemaVersion: 1,
    state: 'refreshed',
    manifest,
  })
  return manifest
}

async function applyMarketplaceCatalogResource(resource: NonNullable<UpdateManifest['resources']>[number]): Promise<void> {
  if (!resource.packageUrl) {
    throw new UpdateServiceError('BAD_REQUEST', `marketplace-catalog resource ${resource.id} is missing packageUrl`)
  }
  const catalog = await fetchJson(resolveHttpUrl(resource.packageUrl, 'marketplace catalog'))
  if (!isRecord(catalog) || !Array.isArray(catalog.resources)) {
    throw new UpdateServiceError('BAD_REQUEST', `marketplace-catalog resource ${resource.id} did not return a valid catalog`)
  }
  await backupGeneratedFile(
    getMarketplaceCatalogCacheFile(),
    getMarketplaceCatalogBackupFile(),
    getMarketplaceCatalogBackupMetaFile(),
  )
  await writeJsonFile(getMarketplaceCatalogCacheFile(), {
    ...catalog,
    schemaVersion: 1,
    source: 'cache',
  })
}

async function applyBuiltinBundleResource(resource: NonNullable<UpdateManifest['resources']>[number]): Promise<void> {
  if (!resource.packageUrl) {
    throw new UpdateServiceError('BAD_REQUEST', `builtin-bundle resource ${resource.id} is missing packageUrl`)
  }

  const bundledDir = assertBundledDataTargetAllowed()
  const zipData = await fetchFile(resolveHttpUrl(resource.packageUrl, 'builtin bundle package'))
  const expectedHash = normalizeSha256(resource.sha256)
  if (expectedHash && hashSha256(zipData) !== expectedHash) {
    throw new UpdateServiceError('BAD_REQUEST', `sha256 mismatch for builtin-bundle resource ${resource.id}`)
  }
  try {
    verifyResourceSignature(zipData, resource.signature, `builtin-bundle resource ${resource.id}`)
  } catch (error) {
    if (error instanceof ResourceSignatureVerificationError) {
      throw new UpdateServiceError('BAD_REQUEST', error.message)
    }
    throw error
  }

  const stagingDir = path.join(getStagingDir(), `bundled-data-${Date.now()}-${randomUUID()}`)
  await fs.rm(stagingDir, { recursive: true, force: true })
  try {
    await writeZipToDirectory(zipData, stagingDir)
    await fs.rm(getBundledDataBackupDir(), { recursive: true, force: true })
    if (await fileExists(bundledDir)) {
      await fs.mkdir(getBackupDir(), { recursive: true })
      await fs.cp(bundledDir, getBundledDataBackupDir(), { recursive: true })
    }
    await fs.rm(bundledDir, { recursive: true, force: true })
    await fs.mkdir(path.dirname(bundledDir), { recursive: true })
    await fs.cp(stagingDir, bundledDir, { recursive: true })
  } catch (error) {
    await fs.rm(bundledDir, { recursive: true, force: true }).catch(() => undefined)
    if (await fileExists(getBundledDataBackupDir())) {
      await fs.cp(getBundledDataBackupDir(), bundledDir, { recursive: true }).catch(() => undefined)
    }
    throw error
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function applyResourceUpdates(resourceIds?: string[]): Promise<ResourceUpdateStatus> {
  const manifest = await checkLocalUpdateManifest()
  const resources = manifest.resources ?? []
  const requestedIds = resourceIds?.map((id) => id.trim()).filter(Boolean)
  const selected = requestedIds && requestedIds.length > 0
    ? resources.filter((resource) => requestedIds.includes(resource.id))
    : resources

  if (manifest.source === 'empty') {
    throw new UpdateServiceError('NOT_FOUND', 'Update manifest is not available')
  }
  if (selected.length === 0) {
    throw new UpdateServiceError('NOT_FOUND', 'No update resources matched the request')
  }

  await writeStatus({
    schemaVersion: 1,
    state: 'applying',
    manifest,
  })

  const appliedResources: NonNullable<ResourceUpdateStatus['appliedResources']> = []
  try {
    for (const resource of selected) {
      if (resource.type === 'marketplace-catalog') {
        await applyMarketplaceCatalogResource(resource)
      } else if (resource.type === 'builtin-bundle') {
        await applyBuiltinBundleResource(resource)
      } else {
        throw new UpdateServiceError('UNSUPPORTED', `Unsupported update resource type: ${resource.type}`)
      }
      appliedResources.push({
        id: resource.id,
        type: resource.type,
        version: resource.version,
      })
    }

    return await writeStatus({
      schemaVersion: 1,
      state: 'applied',
      manifest,
      appliedResources,
    })
  } catch (error) {
    await writeStatus({
      schemaVersion: 1,
      state: 'error',
      manifest,
      appliedResources,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export async function rollbackResourceUpdates(): Promise<ResourceUpdateStatus> {
  const status = await getResourceUpdateStatus()
  const appliedResources = status.appliedResources ?? []
  const shouldRollbackMarketplaceCatalog = appliedResources.some((resource) => resource.type === 'marketplace-catalog')
  const shouldRollbackBundledData = appliedResources.some((resource) => resource.type === 'builtin-bundle')
  const rolledBackResources: NonNullable<ResourceUpdateStatus['appliedResources']> = []

  if (shouldRollbackMarketplaceCatalog) {
    const restored = await restoreGeneratedFileBackup(
      getMarketplaceCatalogCacheFile(),
      getMarketplaceCatalogBackupFile(),
      getMarketplaceCatalogBackupMetaFile(),
    )

    if (restored) {
      rolledBackResources.push(...appliedResources.filter((resource) => resource.type === 'marketplace-catalog'))
    } else if (await fileExists(getMarketplaceCatalogCacheFile())) {
      // Older builds did not create a catalog backup. The cache is generated
      // state, so removing it safely falls back to the local/bundled catalog.
      await fs.rm(getMarketplaceCatalogCacheFile(), { recursive: true, force: true })
      rolledBackResources.push(...appliedResources.filter((resource) => resource.type === 'marketplace-catalog'))
    }
  }

  if (shouldRollbackBundledData) {
    const bundledDir = assertBundledDataTargetAllowed()
    if (!(await fileExists(getBundledDataBackupDir()))) {
      throw new UpdateServiceError('NOT_FOUND', 'No bundled-data backup is available for rollback')
    }

    await fs.rm(bundledDir, { recursive: true, force: true })
    await fs.mkdir(path.dirname(bundledDir), { recursive: true })
    await fs.cp(getBundledDataBackupDir(), bundledDir, { recursive: true })
    rolledBackResources.push(...appliedResources.filter((resource) => resource.type === 'builtin-bundle'))
  }

  if (rolledBackResources.length === 0) {
    throw new UpdateServiceError('NOT_FOUND', 'No resource update backup is available for rollback')
  }

  return writeStatus({
    schemaVersion: 1,
    state: 'rolled-back',
    manifest: await checkLocalUpdateManifest(),
    appliedResources: rolledBackResources,
  })
}
