import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createZipFromDirectory } from '../src/utils/plugins/zipCache.js'
import { unzipFile } from '../src/utils/dxt/zip.js'
import { McpJsonConfigSchema } from '../src/services/mcp/types.js'
import { signResourceData } from '../src/services/resourceSignature.js'
import { renderUnifiedHomePage, renderUnifiedMarketplacePage } from './local-marketplace-ui.ts'
import {
  createMarketplaceAuthStore,
  type MarketplaceActor,
  type MarketplaceRole,
} from './marketplace-auth.ts'

type ResourceType = 'skill' | 'mcp' | 'tool' | 'agent'
type ReviewStatus = 'pending_review' | 'approved' | 'rejected'
type PublishedStatus = 'published' | 'taken_down'

type CatalogResource = {
  id: string
  type: ResourceType
  name: string
  version: string
  category?: string
  description?: string
  packagePath?: string
  packageUrl?: string
  sha256?: string
  signature?: string
  minMikoVersion?: string
  permissions?: string[]
  publisher?: string
  sourceRepository?: string
  sourceCommit?: string
  license?: string
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  requiresExplicitAuthorization?: boolean
  publishedAt?: string
  reviewStatus?: 'approved'
}

type Catalog = {
  schemaVersion: 1
  generatedAt?: string
  source?: 'local-marketplace'
  resources: CatalogResource[]
}

type ResourceManifest = {
  schemaVersion: 1
  id: string
  type: ResourceType
  name: string
  version: string
  category?: string
  description?: string
  minMikoVersion?: string
  permissions?: string[]
  publisher?: string
  sourceRepository?: string
  sourceCommit?: string
  license?: string
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  requiresExplicitAuthorization?: boolean
}

type SubmissionRecord = {
  schemaVersion: 1
  id: string
  status: ReviewStatus
  resource: ResourceManifest
  fileName: string
  packagePath: string
  sha256: string
  size: number
  submittedAt: string
  submittedBy?: string
  reviewedAt?: string
  reviewer?: string
  reviewNotes?: string
  scan: {
    status: 'passed'
    checkedAt: string
    findings: string[]
  }
}

type PublishedRecord = {
  schemaVersion: 1
  resource: ResourceManifest
  status?: PublishedStatus
  packagePath: string
  sha256: string
  signature?: string
  size: number
  submissionId: string
  publishedAt: string
  reviewedAt: string
  reviewer?: string
  takenDownAt?: string
  takenDownBy?: string
  restoredAt?: string
  restoredBy?: string
}

type PublishedIndex = {
  schemaVersion: 1
  generatedAt?: string
  resources: PublishedRecord[]
}

const repoRoot = resolve(import.meta.dir, '..')
const bundledMarketplaceRoot = resolve(process.env.MARKETPLACE_ROOT || join(repoRoot, 'data', 'marketplace'))
const storageRoot = resolve(
  process.env.MARKETPLACE_STORAGE_ROOT || join(repoRoot, '..', 'miko', 'runtime', 'resource-marketplace'),
)
const host = process.env.MARKETPLACE_HOST || '127.0.0.1'
const port = Number.parseInt(process.env.MARKETPLACE_PORT || '8788', 10)
const allowedOrigin = process.env.MARKETPLACE_ALLOWED_ORIGIN?.trim()
const maxUploadBytes = Number.parseInt(process.env.MARKETPLACE_MAX_UPLOAD_BYTES || `${20 * 1024 * 1024}`, 10)

const submissionsDir = join(storageRoot, 'submissions')
const publishedPackagesDir = join(storageRoot, 'packages')
const catalogDir = join(storageRoot, 'catalog')
const publishedIndexFile = join(catalogDir, 'published.json')
const auditLogFile = join(storageRoot, 'audit', 'audit.log')
const authStore = createMarketplaceAuthStore(join(storageRoot, 'auth', 'marketplace.db'))

function json(value: unknown, status = 200) {
  const corsHeaders = allowedOrigin
    ? { 'access-control-allow-origin': allowedOrigin, 'access-control-allow-credentials': 'true', vary: 'Origin' }
    : {}
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders,
    },
  })
}

function jsonWithHeaders(value: unknown, headers: Headers, status = 200) {
  const response = json(value, status)
  for (const [name, headerValue] of headers) response.headers.append(name, headerValue)
  return response
}

function canAccess(actor: MarketplaceActor, allowed: MarketplaceRole[]) {
  return actor.roles.some(role => allowed.includes(role))
}

function requireRole(req: Request, allowed: MarketplaceRole[]) {
  const auth = authStore.authenticate(req)
  if (!auth) {
    return {
      response: json({ error: 'Authentication required', requiredRoles: allowed }, 401),
    }
  }
  const actor = auth.actor
  if (canAccess(actor, allowed)) return { actor }
  return {
    actor,
    response: json({
      error: 'Forbidden',
      requiredRoles: allowed,
      roles: actor.roles,
    }, 403),
  }
}

function requireCsrf(req: Request, actor: MarketplaceActor) {
  if (authStore.csrfValid(req, { actor })) return null
  return json({ error: 'Invalid or missing CSRF token' }, 403)
}

function text(value: string, status = 200, contentType = 'text/plain; charset=utf-8') {
  const corsHeaders = allowedOrigin
    ? { 'access-control-allow-origin': allowedOrigin, 'access-control-allow-credentials': 'true', vary: 'Origin' }
    : {}
  return new Response(value, {
    status,
    headers: {
      'content-type': contentType,
      ...corsHeaders,
    },
  })
}

function badRequest(message: string) {
  return json({ error: message }, 400)
}

function parseMarketplaceRoles(value: unknown): MarketplaceRole[] {
  if (!Array.isArray(value)) return []
  return value.filter((role): role is MarketplaceRole => role === 'publisher' || role === 'reviewer' || role === 'admin')
}

function nowIso() {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim())
  return values.length ? values : undefined
}

function isResourceType(value: unknown): value is ResourceType {
  return value === 'skill' || value === 'mcp' || value === 'tool' || value === 'agent'
}

function sanitizeId(id: string, label = 'id') {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error(`Invalid ${label}: ${id}`)
  }
  return id
}

function safeRelative(root: string, target: string) {
  const rel = relative(root, target)
  if (rel === '' || (!rel.startsWith('..') && !resolve(rel).startsWith('..'))) return rel
  throw new Error(`Path escapes storage root: ${target}`)
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as T
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

async function appendAudit(event: string, payload: Record<string, unknown>) {
  await mkdir(dirname(auditLogFile), { recursive: true })
  await writeFile(
    auditLogFile,
    `${JSON.stringify({ at: nowIso(), event, ...payload })}\n`,
    { encoding: 'utf-8', flag: 'a' },
  )
}

function hashSha256(data: Uint8Array) {
  return createHash('sha256').update(data).digest('hex')
}

function normalizeManifest(value: unknown): ResourceManifest {
  if (!isRecord(value)) throw new Error('resource.json must be an object')
  const id = asString(value.id)
  const type = value.type
  const name = asString(value.name)
  const version = asString(value.version)
  if (!id || !isResourceType(type) || !name || !version) {
    throw new Error('resource.json must include id, type, name, and version')
  }

  return {
    schemaVersion: 1,
    id: sanitizeId(id, 'resource id'),
    type,
    name,
    version: sanitizeId(version, 'version'),
    category: asString(value.category),
    description: asString(value.description),
    minMikoVersion: asString(value.minMikoVersion),
    permissions: asStringArray(value.permissions),
    publisher: asString(value.publisher),
    sourceRepository: asString(value.sourceRepository),
    sourceCommit: asString(value.sourceCommit),
    license: asString(value.license),
    riskLevel: value.riskLevel === 'low' || value.riskLevel === 'medium' || value.riskLevel === 'high' || value.riskLevel === 'critical'
      ? value.riskLevel
      : undefined,
    requiresExplicitAuthorization: value.requiresExplicitAuthorization === true,
  }
}

function manifestToCatalogResource(record: PublishedRecord, origin: string): CatalogResource {
  const resource = record.resource
  return {
    id: resource.id,
    type: resource.type,
    name: resource.name,
    version: resource.version,
    category: resource.category,
    description: resource.description,
    packageUrl: `${origin}/packages/${encodeURIComponent(resource.id)}/${encodeURIComponent(resource.version)}/package.zip`,
    sha256: record.sha256,
    signature: record.signature,
    minMikoVersion: resource.minMikoVersion,
    permissions: resource.permissions,
    publisher: resource.publisher,
    sourceRepository: resource.sourceRepository,
    sourceCommit: resource.sourceCommit,
    license: resource.license,
    riskLevel: resource.riskLevel,
    requiresExplicitAuthorization: resource.requiresExplicitAuthorization,
    publishedAt: record.publishedAt,
    reviewStatus: 'approved',
  }
}

function isPublishedRecordVisible(record: PublishedRecord) {
  return (record.status || 'published') === 'published'
}

function findResourceManifestInZip(files: Record<string, Uint8Array>): ResourceManifest {
  const entry = files['resource.json']
  if (!entry) {
    throw new Error('Package must contain resource.json at the archive root')
  }
  const raw = JSON.parse(Buffer.from(entry).toString('utf-8').replace(/^\uFEFF/, '')) as unknown
  const manifest = normalizeManifest(raw)

  if (manifest.type === 'skill' && !files['SKILL.md'] && !files[`${manifest.name}/SKILL.md`]) {
    throw new Error('Skill package must contain SKILL.md or <name>/SKILL.md')
  }
  if (manifest.type === 'mcp') {
    const mcpEntry = files['mcp.json']
    if (!mcpEntry) {
      throw new Error('MCP package must contain mcp.json at the archive root')
    }
    const mcpRaw = JSON.parse(Buffer.from(mcpEntry).toString('utf-8').replace(/^\uFEFF/, '')) as unknown
    const parsed = McpJsonConfigSchema().safeParse(mcpRaw)
    if (!parsed.success) {
      const message = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', ')
      throw new Error(`MCP package mcp.json is invalid: ${message}`)
    }
    if (Object.keys(parsed.data.mcpServers).length === 0) {
      throw new Error('MCP package must define at least one server')
    }
  }
  if (manifest.type === 'tool' && !files['tool.json']) {
    throw new Error('Tool package must contain tool.json at the archive root')
  }

  return manifest
}

async function readPublishedIndex(): Promise<PublishedIndex> {
  return readJsonFile<PublishedIndex>(publishedIndexFile, {
    schemaVersion: 1,
    resources: [],
  })
}

async function writePublishedIndex(index: PublishedIndex) {
  await writeJsonFile(publishedIndexFile, {
    schemaVersion: 1,
    generatedAt: nowIso(),
    resources: index.resources,
  })
}

function submissionFile(id: string) {
  return join(submissionsDir, sanitizeId(id, 'submission id'), 'submission.json')
}

async function readSubmission(id: string): Promise<SubmissionRecord | null> {
  const filePath = submissionFile(id)
  if (!existsSync(filePath)) return null
  return JSON.parse(await readFile(filePath, 'utf-8')) as SubmissionRecord
}

async function writeSubmission(record: SubmissionRecord) {
  await writeJsonFile(submissionFile(record.id), record)
}

async function listSubmissions(): Promise<SubmissionRecord[]> {
  if (!existsSync(submissionsDir)) return []
  const entries = await readdir(submissionsDir, { withFileTypes: true })
  const records: SubmissionRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const record = await readSubmission(entry.name)
    if (record) records.push(record)
  }
  return records.sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))
}

function contentTypeFor(filePath: string) {
  switch (extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.md':
      return 'text/markdown; charset=utf-8'
    case '.zip':
      return 'application/zip'
    default:
      return 'application/octet-stream'
  }
}

async function createSeedPackage(resource: CatalogResource, sourceDir: string): Promise<Uint8Array> {
  const tempDir = join(tmpdir(), `miko-marketplace-seed-${Date.now()}-${randomUUID()}`)
  await rm(tempDir, { recursive: true, force: true })
  try {
    await mkdir(tempDir, { recursive: true })
    await cp(sourceDir, tempDir, { recursive: true })
    const resourceJson = join(tempDir, 'resource.json')
    if (!existsSync(resourceJson)) {
      await writeJsonFile(resourceJson, {
        schemaVersion: 1,
        id: resource.id,
        type: resource.type,
        name: resource.name,
        version: resource.version,
        category: resource.category,
        description: resource.description,
        permissions: resource.permissions,
        publisher: resource.publisher,
        sourceRepository: resource.sourceRepository,
        sourceCommit: resource.sourceCommit,
        license: resource.license,
        riskLevel: resource.riskLevel,
        requiresExplicitAuthorization: resource.requiresExplicitAuthorization,
      })
    }
    return await createZipFromDirectory(tempDir)
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function ensureSeedPublished() {
  await mkdir(storageRoot, { recursive: true })
  const index = await readPublishedIndex()

  const seedCatalogFile = join(bundledMarketplaceRoot, 'catalog.local.json')
  if (!existsSync(seedCatalogFile)) return

  const seed = JSON.parse(await readFile(seedCatalogFile, 'utf-8')) as Catalog
  const existingKeys = new Set(index.resources.map(record => `${record.resource.id}@${record.resource.version}`))
  let added = 0

  for (const resource of seed.resources || []) {
    if (!resource.packagePath) continue
    const key = `${resource.id}@${resource.version}`
    if (existingKeys.has(key)) continue

    const sourceDir = resolve(bundledMarketplaceRoot, resource.packagePath)
    if (!existsSync(sourceDir)) continue

    const zipData = await createSeedPackage(resource, sourceDir)
    const manifest = findResourceManifestInZip(await unzipFile(Buffer.from(zipData)))
    const packageDir = join(publishedPackagesDir, manifest.id, manifest.version)
    const packageFile = join(packageDir, 'package.zip')
    await mkdir(packageDir, { recursive: true })
    await writeFile(packageFile, zipData)

    const publishedAt = nowIso()
    index.resources.push({
      schemaVersion: 1,
      resource: manifest,
      status: 'published',
      packagePath: safeRelative(storageRoot, packageFile),
      sha256: hashSha256(zipData),
      signature: signResourceData(zipData),
      size: zipData.length,
      submissionId: 'seed',
      publishedAt,
      reviewedAt: publishedAt,
      reviewer: 'system',
    })
    existingKeys.add(key)
    added++
  }

  if (added > 0) {
    await writePublishedIndex(index)
    await appendAudit('seed.published', { count: added })
  }
}

async function readCatalog(origin: string): Promise<Catalog> {
  await ensureSeedPublished()
  const index = await readPublishedIndex()
  return {
    schemaVersion: 1,
    source: 'local-marketplace',
    generatedAt: index.generatedAt,
    resources: index.resources
      .filter(isPublishedRecordVisible)
      .map(record => manifestToCatalogResource(record, origin)),
  }
}

async function readResourceUpdateManifest(origin: string) {
  const catalog = await readCatalog(origin)
  const version = catalog.generatedAt || 'local'
  return {
    schemaVersion: 1,
    generatedAt: catalog.generatedAt || new Date().toISOString(),
    currentVersion: 'local',
    latestVersion: version,
    channel: 'local',
    notes: 'Local official resource update manifest',
    resources: [
      {
        id: 'marketplace-catalog',
        type: 'marketplace-catalog',
        version,
        packageUrl: `${origin}/catalog.json`,
      },
    ],
  }
}

function signedJson(value: unknown, status = 200) {
  const body = `${JSON.stringify(value, null, 2)}\n`
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  }
  const signature = signResourceData(new TextEncoder().encode(body))
  if (signature) headers['x-miko-catalog-signature'] = signature
  return new Response(body, { status, headers })
}

async function servePackage(pathname: string) {
  const match = pathname.match(/^\/packages\/([^/]+)\/([^/]+)\/package\.zip$/)
  if (!match) return json({ error: 'Package path not found' }, 404)
  const [, rawId, rawVersion] = match
  const id = sanitizeId(decodeURIComponent(rawId), 'resource id')
  const version = sanitizeId(decodeURIComponent(rawVersion), 'version')
  const index = await readPublishedIndex()
  const record = index.resources.find(entry => entry.resource.id === id && entry.resource.version === version)
  if (!record || !isPublishedRecordVisible(record)) {
    return json({ error: 'Package path not found' }, 404)
  }
  const target = join(publishedPackagesDir, id, version, 'package.zip')
  safeRelative(storageRoot, target)

  if (!existsSync(target)) {
    return json({ error: 'Package path not found' }, 404)
  }

  return new Response(await readFile(target), {
    headers: {
      'content-type': contentTypeFor(target),
      'access-control-allow-origin': '*',
      'content-disposition': `attachment; filename="${basename(id)}-${version}.zip"`,
    },
  })
}

async function createSubmissionFromZip(
  zipData: Uint8Array,
  fileName: string,
  submittedBy?: string,
  actor?: MarketplaceActor,
) {
  const files = await unzipFile(Buffer.from(zipData))
  const manifest = findResourceManifestInZip(files)
  const id = randomUUID()
  const packageFile = join(submissionsDir, id, 'package.zip')
  const submittedAt = nowIso()
  const record: SubmissionRecord = {
    schemaVersion: 1,
    id,
    status: 'pending_review',
    resource: manifest,
    fileName,
    packagePath: safeRelative(storageRoot, packageFile),
    sha256: hashSha256(zipData),
    size: zipData.length,
    submittedAt,
    submittedBy,
    scan: {
      status: 'passed',
      checkedAt: submittedAt,
      findings: [],
    },
  }

  await mkdir(dirname(packageFile), { recursive: true })
  await writeFile(packageFile, zipData)
  await writeSubmission(record)
  await appendAudit('submission.created', {
    submissionId: id,
    resourceId: manifest.id,
    version: manifest.version,
    submittedBy,
    actorId: actor?.actorId,
    roles: actor?.roles,
  })
  return record
}

async function handleCreateSubmission(req: Request, actor: MarketplaceActor) {
  const contentType = req.headers.get('content-type') || ''
  if (!contentType.includes('multipart/form-data')) {
    return badRequest('Upload must use multipart/form-data with a "package" zip file')
  }

  const form = await req.formData()
  const file = form.get('package')
  if (!(file instanceof File)) {
    return badRequest('Missing package file')
  }
  if (file.size > maxUploadBytes) {
    return badRequest(`Package file exceeds the ${Math.floor(maxUploadBytes / 1024 / 1024)} MB upload limit`)
  }
  if (!file.name.toLowerCase().endsWith('.zip')) {
    return badRequest('Package file must be a .zip archive')
  }

  const zipData = new Uint8Array(await file.arrayBuffer())
  const record = await createSubmissionFromZip(zipData, file.name, actor.actorId, actor)
  return json({ submission: record }, 201)
}

async function approveSubmission(id: string, reviewer?: string, notes?: string, actor?: MarketplaceActor) {
  const record = await readSubmission(id)
  if (!record) return null
  if (actor?.actorId && record.submittedBy === actor.actorId) {
    throw new Error('A publisher cannot review their own submission')
  }
  if (record.status !== 'pending_review') {
    throw new Error(`Submission is already ${record.status}`)
  }

  const packageSource = resolve(storageRoot, record.packagePath)
  safeRelative(storageRoot, packageSource)
  const reviewedAt = nowIso()
  const index = await readPublishedIndex()
  if (index.resources.some(entry => (
    entry.resource.id === record.resource.id && entry.resource.version === record.resource.version
  ))) {
    throw new Error(`Resource version already published: ${record.resource.id}@${record.resource.version}`)
  }
  const packageTarget = join(publishedPackagesDir, record.resource.id, record.resource.version, 'package.zip')
  await mkdir(dirname(packageTarget), { recursive: true })
  await copyFile(packageSource, packageTarget)

  const nextPublished: PublishedRecord = {
    schemaVersion: 1,
    resource: record.resource,
    status: 'published',
    packagePath: safeRelative(storageRoot, packageTarget),
    sha256: record.sha256,
    signature: signResourceData(await readFile(packageTarget)),
    size: record.size,
    submissionId: record.id,
    publishedAt: reviewedAt,
    reviewedAt,
    reviewer,
  }
  index.resources = [nextPublished, ...index.resources]
  await writePublishedIndex(index)

  record.status = 'approved'
  record.reviewedAt = reviewedAt
  record.reviewer = reviewer
  record.reviewNotes = notes
  await writeSubmission(record)
  await appendAudit('submission.approved', {
    submissionId: id,
    resourceId: record.resource.id,
    version: record.resource.version,
    reviewer,
    actorId: actor?.actorId,
    roles: actor?.roles,
  })
  return record
}

async function rejectSubmission(id: string, reviewer?: string, notes?: string, actor?: MarketplaceActor) {
  const record = await readSubmission(id)
  if (!record) return null
  if (actor?.actorId && record.submittedBy === actor.actorId) {
    throw new Error('A publisher cannot review their own submission')
  }
  if (record.status !== 'pending_review') {
    throw new Error(`Submission is already ${record.status}`)
  }

  record.status = 'rejected'
  record.reviewedAt = nowIso()
  record.reviewer = reviewer
  record.reviewNotes = notes
  await writeSubmission(record)
  await appendAudit('submission.rejected', {
    submissionId: id,
    resourceId: record.resource.id,
    version: record.resource.version,
    reviewer,
    actorId: actor?.actorId,
    roles: actor?.roles,
  })
  return record
}

async function updatePublishedResourceStatus(
  id: string,
  version: string,
  status: PublishedStatus,
  actor: MarketplaceActor,
  notes?: string,
) {
  const index = await readPublishedIndex()
  const record = index.resources.find(entry => entry.resource.id === id && entry.resource.version === version)
  if (!record) return null

  const previousStatus = record.status || 'published'
  const changedAt = nowIso()
  record.status = status
  if (status === 'taken_down') {
    record.takenDownAt = changedAt
    record.takenDownBy = actor.actorId
  } else {
    record.restoredAt = changedAt
    record.restoredBy = actor.actorId
  }
  await writePublishedIndex(index)
  await appendAudit(status === 'taken_down' ? 'resource.taken_down' : 'resource.restored', {
    resourceId: id,
    version,
    previousStatus,
    nextStatus: status,
    actorId: actor.actorId,
    roles: actor.roles,
    notes,
  })
  return record
}

async function readReviewBody(req: Request) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  return {
    reviewer: asString(body.reviewer) || 'local-reviewer',
    notes: asString(body.notes),
  }
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch] || ch))
}

type ShellAudience = 'public' | 'admin'

function renderShell(title: string, body: string, script = '', options: { audience?: ShellAudience } = {}) {
  const audience = options.audience ?? 'public'
  const publicBackendNavStyle = ''
  const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; --bg:#f5f7fb; --panel:#fff; --soft:#f9fafc; --text:#172033; --muted:#667085; --line:#dbe1ea; --brand:#2454d6; --green:#0f8a5f; --amber:#a15c00; --rose:#b42343; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 Inter,"Segoe UI",system-ui,sans-serif; }
    a { color:inherit; text-decoration:none; }
    button,input,textarea { font:inherit; }
    .topbar { position:sticky; top:0; z-index:3; border-bottom:1px solid var(--line); background:rgba(255,255,255,.94); backdrop-filter:blur(10px); }
    .topbar-inner { max-width:1240px; margin:0 auto; padding:14px 24px; display:flex; gap:12px; align-items:center; justify-content:space-between; }
    .brand { display:flex; gap:10px; align-items:center; font-weight:850; }
    .logo { display:grid; place-items:center; width:34px; height:34px; border-radius:8px; background:#e8eeff; color:var(--brand); border:1px solid #c8d5ff; }
    .nav { display:flex; gap:8px; flex-wrap:wrap; }
    .page { max-width:1240px; margin:0 auto; padding:28px 24px 44px; }
    .button,.ghost { display:inline-flex; min-height:36px; align-items:center; justify-content:center; border-radius:8px; padding:0 12px; font-weight:750; cursor:pointer; }
    .button { border:1px solid var(--brand); background:var(--brand); color:white; }
    .ghost { border:1px solid var(--line); background:white; color:var(--text); }
    .danger { border-color:#f6bdca; color:var(--rose); }
    h1 { margin:0 0 10px; font-size:30px; letter-spacing:0; line-height:1.18; }
    .lead { max-width:760px; color:var(--muted); margin:0 0 22px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:14px; }
    .card,.panel { border:1px solid var(--line); border-radius:8px; background:var(--panel); padding:16px; }
    .panel { margin-bottom:18px; }
    .card-head { display:flex; gap:10px; align-items:flex-start; justify-content:space-between; }
    .name { font-size:15px; font-weight:850; overflow-wrap:anywhere; }
    .desc { min-height:42px; margin:10px 0; color:var(--muted); }
    .badge { display:inline-flex; min-height:22px; align-items:center; border-radius:999px; padding:0 8px; background:#eef1f6; color:#4d596c; font-size:11px; font-weight:800; }
    .approved { background:#e7f6ef; color:var(--green); }
    .pending { background:#fff3da; color:var(--amber); }
    .rejected { background:#ffe9ee; color:var(--rose); }
    .meta { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; align-items:center; }
    .form-grid { display:grid; grid-template-columns:minmax(240px,1fr) minmax(180px,240px) auto; gap:10px; align-items:end; }
    label { display:grid; gap:6px; color:var(--muted); font-size:12px; font-weight:800; }
    input,textarea,select { width:100%; border:1px solid var(--line); border-radius:8px; background:white; color:var(--text); padding:8px 10px; outline:none; }
    input:focus,textarea:focus,select:focus { border-color:#8aa4ff; box-shadow:0 0 0 3px rgba(36,84,214,.12); }
    .empty { border:1px dashed var(--line); border-radius:8px; background:white; color:var(--muted); padding:36px; text-align:center; }
    .toast { display:none; margin-bottom:14px; border:1px solid var(--line); border-radius:8px; background:white; padding:12px; }
    .toast.show { display:block; }
    code { border-radius:5px; background:#eef1f6; padding:2px 5px; }
    @media (max-width:780px) { .topbar-inner,.form-grid { display:block; } .nav,.form-grid > * { margin-top:10px; } h1 { font-size:26px; } }
  </style>
  ${publicBackendNavStyle}
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="/"><span class="logo">M</span><span>Miko</span></a>
      <nav class="nav">
        <a class="ghost" href="/">主页</a>
        <a class="ghost" href="/marketplace">资源市场</a>
        <a class="ghost" href="/publish">发布中心</a>
        <a class="ghost" href="/reviews">审核后台</a>
        <a class="ghost" href="/catalog.json" target="_blank" rel="noreferrer">Catalog API</a>
      </nav>
    </div>
  </header>
  <main class="page">${body}</main>
  <script>
    window.mikoWriteHeaders = function(headers) {
      const match = document.cookie.match(/(?:^|; )miko_csrf=([^;]*)/)
      const csrf = match ? decodeURIComponent(match[1]) : ''
      return Object.assign({}, headers || {}, csrf ? { 'x-csrf-token': csrf } : {})
    }
  </script>
  ${script}
</body>
</html>`
  return audience === 'public'
    ? page
      .replace(/\s*<a class="ghost" href="\/publish">[^<]*<\/a>/g, '')
      .replace(/\s*<a class="ghost" href="\/reviews">[^<]*<\/a>/g, '')
      .replace(/\s*<a class="ghost" href="\/catalog\.json"[^>]*>[^<]*<\/a>/g, '')
    : page
}

function resourceCard(resource: CatalogResource) {
  return `<article class="card">
    <div class="card-head">
      <div>
        <div class="name">${escapeHtml(resource.name)}</div>
        <div class="meta">
          <span class="badge">${escapeHtml(resource.type)}</span>
          <span class="badge">v${escapeHtml(resource.version)}</span>
          <span class="badge approved">approved</span>
        </div>
      </div>
    </div>
    <div class="desc">${escapeHtml(resource.description || 'No description provided.')}</div>
    <div class="meta">
      <span class="badge">${escapeHtml(resource.category || 'uncategorized')}</span>
      ${(resource.permissions || []).map(item => `<span class="badge">${escapeHtml(item)}</span>`).join('')}
    </div>
    <div class="actions">
      <a class="button" href="${escapeHtml(resource.packageUrl)}">下载包</a>
      <span><code>${escapeHtml(resource.id)}</code></span>
    </div>
  </article>`
}

const resourceTypeOrder: ResourceType[] = ['skill', 'mcp', 'tool', 'agent']
const resourceTypeLabel: Record<ResourceType, string> = {
  skill: 'Skills',
  mcp: 'MCP',
  tool: 'Tools',
  agent: 'Agents',
}

const resourceTypeDescription: Record<ResourceType, string> = {
  skill: '面向 Agent 的能力包，包含 SKILL.md、参考资料、脚本或资源文件。',
  mcp: '面向 MCP client 的服务包，安装后按 mcp.json 增量写入 data/mcp.json。',
  tool: '面向原生工具、工作流模板或命令封装的资源包，当前用于发布和展示。',
  agent: '面向 Agent 预设、角色和能力组合的资源类型，作为生态扩展预留。',
}

async function renderMarketplacePage(origin: string) {
  const catalog = await readCatalog(origin)
  const grouped = new Map<ResourceType, CatalogResource[]>()
  for (const resource of catalog.resources) {
    const resources = grouped.get(resource.type) ?? []
    resources.push(resource)
    grouped.set(resource.type, resources)
  }
  const sections = resourceTypeOrder
    .map(type => {
      const resources = grouped.get(type) ?? []
      if (resources.length === 0) return ''
      return `<section class="panel">
        <div class="card-head">
          <div>
            <h2 style="margin:0;font-size:18px;line-height:1.3">${escapeHtml(resourceTypeLabel[type])}</h2>
            <p class="desc" style="min-height:0;margin:6px 0 0">${escapeHtml(resourceTypeDescription[type])}</p>
          </div>
          <span class="badge approved">${resources.length} 个已发布</span>
        </div>
        <div class="grid" style="margin-top:14px">${resources.map(resourceCard).join('')}</div>
      </section>`
    })
    .filter(Boolean)
    .join('')
  const body = `<h1>资源市场</h1>
    <p class="lead">浏览已审核发布的 Skills、MCP、工具和 Agent 资源。Miko Desktop 从 Catalog API 同步资源，并按包校验后安装。</p>
    ${sections
      ? sections
      : '<div class="empty">当前没有已发布资源。</div>'}`
  return text(renderShell('资源市场', body), 200, 'text/html; charset=utf-8')
}

function submissionCard(record: SubmissionRecord) {
  const statusClass = record.status === 'approved' ? 'approved' : record.status === 'rejected' ? 'rejected' : 'pending'
  return `<article class="card">
    <div class="card-head">
      <div>
        <div class="name">${escapeHtml(record.resource.name)}</div>
        <div class="meta">
          <span class="badge">${escapeHtml(record.resource.type)}</span>
          <span class="badge">v${escapeHtml(record.resource.version)}</span>
          <span class="badge ${statusClass}">${escapeHtml(record.status)}</span>
        </div>
      </div>
    </div>
    <div class="desc">${escapeHtml(record.resource.description || 'No description provided.')}</div>
    <div class="meta">
      <span class="badge">${escapeHtml(record.resource.id)}</span>
      <span class="badge">${Math.round(record.size / 1024)} KB</span>
      <span class="badge">${escapeHtml(record.submittedAt.slice(0, 19).replace('T', ' '))}</span>
    </div>
    <div class="actions">
      ${record.status === 'pending_review'
        ? `<button class="button" data-action="approve" data-id="${escapeHtml(record.id)}">通过并发布</button>
           <button class="ghost danger" data-action="reject" data-id="${escapeHtml(record.id)}">拒绝</button>`
        : `<span class="badge ${statusClass}">${escapeHtml(record.reviewedAt || '')}</span>`}
    </div>
  </article>`
}

function renderPublisherPage() {
  const body = `<style>
      .publisher-layout { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:16px; align-items:start; }
      .rules-list { display:grid; gap:10px; }
      .rule-item { border:1px solid var(--line); border-radius:8px; background:var(--soft); padding:12px; }
      .rule-title { font-weight:850; margin-bottom:4px; }
      @media (max-width:900px) { .publisher-layout { display:block; } .publisher-side { margin-top:16px; } }
    </style>
    <h1>Publish Resource</h1>
    <p class="lead">Upload a Skill, MCP, Tool or Agent package for review. Submitted packages enter the review queue and do not appear in the public catalog until approved.</p>
    <div class="toast" id="toast"></div>
    <div class="publisher-layout">
      <section class="panel">
        <form id="upload-form" class="rules-list">
          <label>Package zip
            <input name="package" type="file" accept=".zip,application/zip" required />
          </label>
          <button class="button" type="submit">Submit for review</button>
        </form>
      </section>
      <aside class="panel publisher-side">
        <h2 style="margin:0 0 12px;font-size:18px">Package rules</h2>
        <div class="rules-list">
          <div class="rule-item"><div class="rule-title">Skill</div>Must include <code>resource.json</code> and <code>SKILL.md</code> or <code>&lt;name&gt;/SKILL.md</code>.</div>
          <div class="rule-item"><div class="rule-title">MCP</div>Must include <code>resource.json</code> and <code>mcp.json</code>. Install merges declared servers without overwriting user servers.</div>
          <div class="rule-item"><div class="rule-title">Tool</div>Must include <code>resource.json</code> and <code>tool.json</code>. Runtime install waits for the tool registry contract.</div>
          <div class="rule-item"><div class="rule-title">Agent</div>Reserved for future Agent presets after the <code>agent.json</code> contract is finalized.</div>
        </div>
      </aside>
    </div>
    <script>
      const toast = document.getElementById('toast')
      function showToast(message) {
        toast.textContent = message
        toast.classList.add('show')
      }
      document.getElementById('upload-form').addEventListener('submit', async event => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        const response = await fetch('/api/submissions', {
          method: 'POST',
          headers: window.mikoWriteHeaders(),
          body: form,
        })
        const result = await response.json().catch(() => ({}))
        if (!response.ok) {
          showToast(result.error || 'Submission failed')
          return
        }
        showToast('Submitted for review: ' + result.submission.resource.id + ' v' + result.submission.resource.version)
        event.currentTarget.reset()
      })
    </script>`
  return text(renderShell('Publish Resource', body), 200, 'text/html; charset=utf-8')
}

function renderRegistrationPage() {
  const body = `<h1>注册资源市场账号</h1>
    <p class="lead">注册后是普通用户，可以申请发布者资格。审核通过前不能上传资源。</p>
    <div class="toast" id="toast"></div>
    <section class="panel" style="max-width:520px"><form id="register" class="rules-list">
      <label>邮箱<input name="email" type="email" autocomplete="email" required /></label>
      <label>显示名称<input name="displayName" autocomplete="name" required /></label>
      <label>密码<input name="password" type="password" minlength="12" autocomplete="new-password" required /></label>
      <label>确认密码<input name="confirmPassword" type="password" minlength="12" autocomplete="new-password" required /></label>
      <button class="button" type="submit">注册账号</button>
      <a class="ghost" href="/login">已有账号，返回登录</a>
    </form></section>
    <script>
      const form=document.getElementById('register');const toast=document.getElementById('toast');
      form.addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(form));if(d.password!==d.confirmPassword){toast.textContent='两次输入的密码不一致';toast.classList.add('show');return}const r=await fetch('/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:d.email,displayName:d.displayName,password:d.password})});const v=await r.json().catch(()=>({}));if(!r.ok){toast.textContent=v.error||'注册失败';toast.classList.add('show');return}location.href='/login?registered=1'})
    </script>`
  return text(renderShell('注册资源市场账号', body), 200, 'text/html; charset=utf-8')
}

async function renderReviewPage() {
  const records = await listSubmissions()
  const packageRules = `<section class="panel">
      <div class="card-head">
        <div>
          <h2 style="margin:0;font-size:18px;line-height:1.3">上传包规范</h2>
          <p class="desc" style="min-height:0;margin:6px 0 0">所有资源必须上传 zip 包，根目录必须包含 resource.json，并按类型提供必要文件。</p>
        </div>
        <span class="badge">skill / mcp / tool / agent</span>
      </div>
      <div class="grid" style="margin-top:14px">
        <div class="card">
          <div class="name">Skill</div>
          <div class="desc">必须包含 SKILL.md 或 &lt;name&gt;/SKILL.md。安装后进入 marketplace packages，由运行时按启用状态加载，不写入用户 data/skills。</div>
        </div>
        <div class="card">
          <div class="name">MCP</div>
          <div class="desc">必须包含 mcp.json。安装时替换 \${PACKAGE_DIR}，并把 mcpServers 增量合并到 data/mcp.json，不覆盖用户同名 server。</div>
        </div>
        <div class="card">
          <div class="name">Tool</div>
          <div class="desc">必须包含 tool.json。当前支持上传、审核、发布和展示，运行时安装待工具注册契约完成后开放。</div>
        </div>
        <div class="card">
          <div class="name">Agent</div>
          <div class="desc">类型已预留。开放前需要冻结 agent.json、依赖声明、权限展示和用户修改保护策略。</div>
        </div>
      </div>
    </section>`
  const body = `<h1>资源审核后台</h1>
    <p class="lead">上传资源包后进入待审核队列。审核通过的资源会写入发布索引并出现在公开 Catalog；拒绝的资源只保留审核记录。</p>
    <div class="toast" id="toast"></div>
    ${packageRules}
    <section class="panel">
      <form id="upload-form" class="form-grid">
        <label>资源包 zip
          <input name="package" type="file" accept=".zip,application/zip" required />
        </label>
        <button class="button" type="submit">提交审核</button>
      </form>
    </section>
    ${records.length
      ? `<section class="grid">${records.map(submissionCard).join('')}</section>`
      : '<div class="empty">当前没有待处理或历史提交。</div>'}`
  const script = `<script>
    const toast = document.getElementById('toast')
    function showToast(message) {
      toast.textContent = message
      toast.classList.add('show')
    }
    document.getElementById('upload-form').addEventListener('submit', async event => {
      event.preventDefault()
      const form = new FormData(event.currentTarget)
      const response = await fetch('/api/submissions', { method: 'POST', headers: window.mikoWriteHeaders(), body: form })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        showToast(result.error || '提交失败')
        return
      }
      location.reload()
    })
    document.querySelectorAll('[data-action]').forEach(button => {
      button.addEventListener('click', async () => {
        const action = button.getAttribute('data-action')
        const id = button.getAttribute('data-id')
        const notes = prompt(action === 'reject' ? '拒绝原因' : '审核意见') || ''
        if (!notes) return
        const response = await fetch('/api/reviews/' + encodeURIComponent(id) + '/' + action, {
          method: 'POST',
          headers: window.mikoWriteHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ reviewer: 'local-reviewer', notes })
        })
        const result = await response.json().catch(() => ({}))
        if (!response.ok) {
          showToast(result.error || '审核操作失败')
          return
        }
        location.reload()
      })
    })
  </script>`
  return text(renderShell('资源审核后台', body, script, { audience: 'admin' }), 200, 'text/html; charset=utf-8')
}

function jsonForInlineScript(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function countResourcesByType(resources: CatalogResource[]): Record<ResourceType | 'all', number> {
  const counts: Record<ResourceType | 'all', number> = {
    all: resources.length,
    skill: 0,
    mcp: 0,
    tool: 0,
    agent: 0,
  }
  for (const resource of resources) {
    counts[resource.type]++
  }
  return counts
}

function sortCatalogResources(resources: CatalogResource[]) {
  return [...resources].sort((left, right) => {
    const typeDiff = resourceTypeOrder.indexOf(left.type) - resourceTypeOrder.indexOf(right.type)
    if (typeDiff !== 0) return typeDiff
    return left.name.localeCompare(right.name)
  })
}

async function renderMikoHomePage(origin: string) {
  const catalog = await readCatalog(origin)
  const resources = sortCatalogResources(catalog.resources)
  const counts = countResourcesByType(resources)
  const featured = resources.slice(0, 4).map(resource => `<a class="home-resource" href="/marketplace?resource=${encodeURIComponent(resource.id)}">
      <span class="badge">${escapeHtml(resource.type)}</span>
      <strong>${escapeHtml(resource.name)}</strong>
      <span>${escapeHtml(resource.description || '已发布资源')}</span>
    </a>`).join('')

  const body = `<style>
      .home-hero { min-height:calc(100vh - 86px); display:grid; grid-template-columns:minmax(0,0.92fr) minmax(420px,1.08fr); gap:34px; align-items:center; padding:10px 0 34px; }
      .home-kicker { display:inline-flex; align-items:center; min-height:28px; border:1px solid var(--line); border-radius:999px; background:white; color:var(--muted); padding:0 10px; font-size:12px; font-weight:850; margin-bottom:16px; }
      .home-title { margin:0; font-size:58px; line-height:1.02; letter-spacing:0; max-width:720px; }
      .home-lead { color:var(--muted); font-size:17px; line-height:1.75; max-width:690px; margin:18px 0 0; }
      .home-actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:26px; }
      .home-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-top:32px; }
      .home-metric { border:1px solid var(--line); border-radius:8px; background:white; padding:13px; }
      .home-metric strong { display:block; font-size:24px; line-height:1; }
      .home-metric span { display:block; color:var(--muted); font-size:12px; margin-top:6px; }
      .product-preview { border:1px solid var(--line); border-radius:8px; background:#101828; color:white; box-shadow:0 24px 60px rgba(23,32,51,.18); overflow:hidden; }
      .preview-top { display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid rgba(255,255,255,.12); padding:12px 14px; background:#182235; }
      .preview-dots { display:flex; gap:6px; }
      .preview-dots span { width:9px; height:9px; border-radius:999px; background:#667085; }
      .preview-body { display:grid; grid-template-columns:170px minmax(0,1fr); min-height:430px; }
      .preview-sidebar { border-right:1px solid rgba(255,255,255,.1); padding:14px; background:#111a2b; }
      .preview-main { padding:18px; background:#0f1728; }
      .preview-nav { display:grid; gap:8px; }
      .preview-nav span { display:flex; align-items:center; justify-content:space-between; border-radius:8px; padding:8px 10px; color:#d0d5dd; background:rgba(255,255,255,.04); font-size:12px; }
      .preview-nav span:first-child { background:#2454d6; color:white; }
      .preview-message { border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:14px; background:rgba(255,255,255,.04); margin-bottom:12px; }
      .preview-message strong { display:block; margin-bottom:8px; }
      .preview-line { height:8px; border-radius:999px; background:#344054; margin:8px 0; }
      .preview-line.short { width:58%; }
      .preview-tools { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin-top:16px; }
      .preview-tool { border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:12px; background:rgba(255,255,255,.05); }
      .preview-tool b { display:block; color:white; margin-bottom:5px; }
      .preview-tool span { color:#98a2b3; font-size:12px; }
      .home-section { padding:36px 0 0; }
      .section-head { display:flex; align-items:end; justify-content:space-between; gap:16px; margin-bottom:14px; }
      .section-head h2 { margin:0; font-size:24px; }
      .home-resource-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
      .home-resource { display:grid; gap:8px; min-height:132px; border:1px solid var(--line); border-radius:8px; background:white; padding:14px; }
      .home-resource strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .home-resource span:last-child { color:var(--muted); font-size:12px; line-height:1.55; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      @media (max-width:1060px) { .home-hero { grid-template-columns:1fr; min-height:0; } .home-title { font-size:46px; } .home-resource-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
      @media (max-width:680px) { .home-title { font-size:38px; } .home-metrics,.preview-body,.preview-tools,.home-resource-grid { grid-template-columns:1fr; } .product-preview { margin-top:12px; } }
    </style>
    <section class="home-hero">
      <div>
        <div class="home-kicker">本地优先的 Agent 工作台</div>
        <h1 class="home-title">Miko 把会话、权限、Skills、MCP 和资源市场放进一个稳定工作流。</h1>
        <p class="home-lead">面向开发者和自动化工作流的桌面 Agent 平台。Miko 保护用户数据目录，分层管理内置资源和用户资源，并通过资源市场扩展 Skill、MCP、工具和 Agent 预设。</p>
        <div class="home-actions">
          <a class="button" href="/marketplace">进入资源市场</a>
          <a class="ghost" href="/publish">发布资源</a>
          <a class="ghost" href="/catalog.json" target="_blank" rel="noreferrer">查看 Catalog API</a>
        </div>
        <div class="home-metrics">
          <div class="home-metric"><strong>${counts.skill}</strong><span>Skills</span></div>
          <div class="home-metric"><strong>${counts.mcp}</strong><span>MCP servers</span></div>
          <div class="home-metric"><strong>${counts.tool}</strong><span>Tools</span></div>
          <div class="home-metric"><strong>${resources.length}</strong><span>已发布资源</span></div>
        </div>
      </div>
      <div class="product-preview" aria-label="Miko 产品界面预览">
        <div class="preview-top">
          <div class="preview-dots"><span></span><span></span><span></span></div>
          <strong>Miko Desktop</strong>
          <span class="badge approved">local first</span>
        </div>
        <div class="preview-body">
          <aside class="preview-sidebar">
            <div class="preview-nav">
              <span>会话 <b>active</b></span>
              <span>权限 <b>ask</b></span>
              <span>Skills <b>${counts.skill}</b></span>
              <span>MCP <b>${counts.mcp}</b></span>
              <span>资源市场 <b>${resources.length}</b></span>
            </div>
          </aside>
          <main class="preview-main">
            <div class="preview-message">
              <strong>Agent 正在整理资源市场安装影响</strong>
              <div class="preview-line"></div>
              <div class="preview-line"></div>
              <div class="preview-line short"></div>
            </div>
            <div class="preview-message">
              <strong>权限和数据边界</strong>
              <div class="preview-line"></div>
              <div class="preview-line short"></div>
            </div>
            <div class="preview-tools">
              <div class="preview-tool"><b>Skill</b><span>运行时加载，不覆盖用户 data/skills</span></div>
              <div class="preview-tool"><b>MCP</b><span>增量合并 data/mcp.json</span></div>
              <div class="preview-tool"><b>Market</b><span>zip + sha256 + 审核发布</span></div>
            </div>
          </main>
        </div>
      </div>
    </section>
    <section class="home-section">
      <div class="section-head">
        <h2>资源市场精选</h2>
        <a class="ghost" href="/marketplace">浏览全部</a>
      </div>
      <div class="home-resource-grid">${featured || '<div class="empty">当前没有已发布资源。</div>'}</div>
    </section>`
  return text(renderShell('Miko', body), 200, 'text/html; charset=utf-8')
}

function renderFeaturedResources(resources: CatalogResource[]) {
  return resources.slice(0, 4).map(resource => `<button class="featured-card" type="button" data-resource-id="${escapeHtml(resource.id)}">
    <span class="badge">${escapeHtml(resource.type)}</span>
    <strong>${escapeHtml(resource.name)}</strong>
    <span>${escapeHtml(resource.description || '已发布资源')}</span>
  </button>`).join('')
}

function renderMarketplaceTableRows(resources: CatalogResource[]) {
  return resources.map((resource) => `<button class="market-row" type="button" data-resource-id="${escapeHtml(resource.id)}">
    <span class="market-cell market-main">
      <span class="market-name">${escapeHtml(resource.name)}</span>
      <span class="market-id">${escapeHtml(resource.id)}</span>
    </span>
    <span class="market-cell"><span class="badge">${escapeHtml(resource.type)}</span></span>
    <span class="market-cell">${escapeHtml(resource.category || '未分类')}</span>
    <span class="market-cell">v${escapeHtml(resource.version)}</span>
    <span class="market-cell market-desc">${escapeHtml(resource.description || '暂无描述。')}</span>
    <span class="market-cell"><span class="badge approved">已发布</span></span>
  </button>`).join('')
}

async function renderMarketplacePageV2(origin: string, initialResourceId?: string | null) {
  const catalog = await readCatalog(origin)
  const resources = sortCatalogResources(catalog.resources)
  const counts = countResourcesByType(resources)
  const catalogData = { ...catalog, resources }
  const featured = renderFeaturedResources(resources)
  const sidebar = (['all', ...resourceTypeOrder] as const).map(type => {
    const label = type === 'all' ? '全部资源' : resourceTypeLabel[type]
    return `<button class="type-filter${type === 'all' ? ' active' : ''}" type="button" data-type="${type}">
      <span>${escapeHtml(label)}</span>
      <strong>${counts[type]}</strong>
    </button>`
  }).join('')

  const body = `<style>
      .market-layout { display:grid; grid-template-columns:220px minmax(0,1fr) 360px; gap:16px; align-items:start; }
      .market-hero { border:1px solid var(--line); border-radius:8px; background:white; padding:22px; margin-bottom:16px; }
      .market-hero-grid { display:grid; grid-template-columns:minmax(0,1fr) 360px; gap:18px; align-items:end; }
      .market-hero h1 { font-size:38px; margin:0 0 10px; }
      .market-hero .lead { margin-bottom:0; }
      .market-stat-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
      .market-stat { border:1px solid var(--line); border-radius:8px; background:var(--soft); padding:12px; }
      .market-stat strong { display:block; font-size:24px; line-height:1; }
      .market-stat span { display:block; color:var(--muted); font-size:12px; margin-top:5px; }
      .featured-strip { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin:0 0 16px; }
      .featured-card { min-height:116px; display:grid; gap:8px; border:1px solid var(--line); border-radius:8px; background:white; color:var(--text); text-align:left; padding:13px; cursor:pointer; }
      .featured-card:hover { border-color:#b8c7ff; background:#f7faff; }
      .featured-card strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .featured-card span:last-child { color:var(--muted); font-size:12px; line-height:1.5; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .market-toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; margin:0 0 16px; }
      .market-search { min-width:260px; flex:1; }
      .market-summary { display:flex; flex-wrap:wrap; gap:8px; color:var(--muted); font-size:12px; }
      .market-sidebar,.market-list,.market-detail { border:1px solid var(--line); border-radius:8px; background:var(--panel); }
      .market-sidebar { padding:10px; position:sticky; top:82px; }
      .type-filter { width:100%; min-height:38px; border:0; border-radius:8px; background:transparent; color:var(--text); display:flex; align-items:center; justify-content:space-between; padding:0 10px; cursor:pointer; font-weight:750; }
      .type-filter:hover,.type-filter.active { background:#eef3ff; color:var(--brand); }
      .market-list { overflow:hidden; }
      .market-header,.market-row { display:grid; grid-template-columns:minmax(180px,1.5fr) 90px 110px 80px minmax(220px,2fr) 86px; gap:10px; align-items:center; width:100%; border:0; border-bottom:1px solid var(--line); background:white; text-align:left; padding:12px 14px; }
      .market-header { background:var(--soft); color:var(--muted); font-size:11px; font-weight:850; text-transform:uppercase; letter-spacing:.04em; }
      .market-row { cursor:pointer; color:var(--text); }
      .market-row:hover,.market-row.active { background:#f7faff; }
      .market-row:last-child { border-bottom:0; }
      .market-cell { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .market-main { display:grid; gap:2px; }
      .market-name { font-weight:850; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .market-id { color:var(--muted); font:12px ui-monospace,SFMono-Regular,Consolas,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .market-desc { color:var(--muted); }
      .market-detail { position:sticky; top:82px; padding:16px; min-height:360px; }
      .detail-title { margin:0; font-size:20px; line-height:1.25; overflow-wrap:anywhere; }
      .detail-section { border-top:1px solid var(--line); margin-top:14px; padding-top:14px; }
      .detail-label { color:var(--muted); font-size:11px; font-weight:850; text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px; }
      .detail-text { color:var(--text); overflow-wrap:anywhere; }
      .detail-list { display:flex; flex-wrap:wrap; gap:6px; }
      .empty-inline { padding:36px; text-align:center; color:var(--muted); }
      @media (max-width:1120px) { .market-layout { grid-template-columns:190px minmax(0,1fr); } .market-detail { grid-column:1 / -1; position:static; } .market-hero-grid { grid-template-columns:1fr; } .featured-strip { grid-template-columns:repeat(2,minmax(0,1fr)); } }
      @media (max-width:760px) { .market-layout { display:block; } .market-sidebar,.market-detail { position:static; margin-bottom:14px; } .market-header { display:none; } .market-row { grid-template-columns:1fr; gap:6px; } .market-cell { white-space:normal; } .market-stat-grid,.featured-strip { grid-template-columns:1fr; } .market-hero h1 { font-size:30px; } }
    </style>
    <section class="market-hero">
      <div class="market-hero-grid">
        <div>
          <span class="badge approved">Resource Marketplace</span>
          <h1>资源市场</h1>
          <p class="lead">浏览已审核发布的 Skills、MCP、工具和 Agent 资源。资源按类型管理，支持搜索、筛选和安装影响预览。</p>
        </div>
        <div class="market-stat-grid">
          <div class="market-stat"><strong>${counts.skill}</strong><span>Skills</span></div>
          <div class="market-stat"><strong>${counts.mcp}</strong><span>MCP</span></div>
          <div class="market-stat"><strong>${counts.tool}</strong><span>Tools</span></div>
          <div class="market-stat"><strong>${resources.length}</strong><span>已发布资源</span></div>
        </div>
      </div>
    </section>
    ${featured ? `<section class="featured-strip">${featured}</section>` : ''}
    <div class="market-toolbar">
      <input id="market-search" class="market-search" type="search" placeholder="搜索名称、ID、分类或描述" />
      <div class="market-summary">
        <span class="badge approved">${resources.length} 个已发布</span>
        <span class="badge">Catalog: ${escapeHtml(catalog.source || 'local-marketplace')}</span>
        <span class="badge">更新时间: ${escapeHtml(catalog.generatedAt || 'local')}</span>
      </div>
    </div>
    ${resources.length === 0
      ? '<div class="empty">当前没有已发布资源。</div>'
      : `<div class="market-layout">
          <aside class="market-sidebar">${sidebar}</aside>
          <section class="market-list" aria-label="资源列表">
            <div class="market-header">
              <span>资源</span><span>类型</span><span>分类</span><span>版本</span><span>描述</span><span>状态</span>
            </div>
            <div id="market-rows">${renderMarketplaceTableRows(resources)}</div>
            <div id="market-empty" class="empty-inline" style="display:none">没有匹配的资源。</div>
          </section>
          <aside id="market-detail" class="market-detail" aria-label="资源详情"></aside>
        </div>`}
    <script type="application/json" id="market-data">${jsonForInlineScript(catalogData)}</script>
    <script>
      const marketData = JSON.parse(document.getElementById('market-data').textContent)
      const resources = marketData.resources || []
      let activeType = 'all'
      let activeId = ${JSON.stringify(initialResourceId || '')} || (resources[0] && resources[0].id)
      const rows = Array.from(document.querySelectorAll('.market-row'))
      const featuredCards = Array.from(document.querySelectorAll('.featured-card'))
      const detail = document.getElementById('market-detail')
      const empty = document.getElementById('market-empty')
      const search = document.getElementById('market-search')
      const filters = Array.from(document.querySelectorAll('.type-filter'))

      function text(value) {
        return value === undefined || value === null || value === '' ? '未提供' : String(value)
      }
      function badges(values) {
        const list = values && values.length ? values : ['无额外声明']
        return list.map(value => '<span class="badge">' + text(value) + '</span>').join('')
      }
      function installImpact(resource) {
        if (resource.type === 'skill') return '安装到 data/marketplace/packages，由 Skill 运行时按启用状态加载，不写入用户 data/skills。'
        if (resource.type === 'mcp') return '安装后读取 mcp.json，替换 \${PACKAGE_DIR}，并把 mcpServers 增量合并到 data/mcp.json；同名用户 server 不会被覆盖。'
        if (resource.type === 'tool') return '当前支持展示、上传审核和发布；运行时安装待工具注册契约完成后开放。'
        if (resource.type === 'agent') return '类型已预留；需要冻结 agent.json、依赖声明和权限策略后开放安装。'
        return '未定义安装影响。'
      }
      function renderDetail(resource) {
        if (!detail || !resource) return
        const packageLink = resource.packageUrl
          ? '<a class="button" href="' + resource.packageUrl + '">下载包</a>'
          : '<span class="badge">无 packageUrl</span>'
        detail.innerHTML = '<h2 class="detail-title">' + text(resource.name) + '</h2>' +
          '<div class="meta"><span class="badge">' + text(resource.type) + '</span><span class="badge">v' + text(resource.version) + '</span><span class="badge approved">已发布</span></div>' +
          '<div class="detail-section"><div class="detail-label">资源 ID</div><div class="detail-text"><code>' + text(resource.id) + '</code></div></div>' +
          '<div class="detail-section"><div class="detail-label">描述</div><div class="detail-text">' + text(resource.description || '暂无描述。') + '</div></div>' +
          '<div class="detail-section"><div class="detail-label">安装影响</div><div class="detail-text">' + installImpact(resource) + '</div></div>' +
          '<div class="detail-section"><div class="detail-label">权限声明</div><div class="detail-list">' + badges(resource.permissions) + '</div></div>' +
          '<div class="detail-section"><div class="detail-label">包校验</div><div class="detail-text"><code>' + text(resource.sha256) + '</code></div></div>' +
          '<div class="actions">' + packageLink + '<a class="ghost" href="/catalog.json" target="_blank" rel="noreferrer">查看 Catalog</a></div>'
      }
      function applyFilters() {
        const term = (search && search.value || '').trim().toLowerCase()
        let visibleCount = 0
        rows.forEach(row => {
          const resource = resources.find(item => item.id === row.dataset.resourceId)
          const haystack = [resource.id, resource.name, resource.type, resource.category, resource.description].join(' ').toLowerCase()
          const visible = resource && (activeType === 'all' || resource.type === activeType) && (!term || haystack.includes(term))
          row.style.display = visible ? '' : 'none'
          row.classList.toggle('active', resource && resource.id === activeId)
          if (visible) visibleCount++
        })
        if (empty) empty.style.display = visibleCount === 0 ? '' : 'none'
        const selected = resources.find(item => item.id === activeId) || resources.find(item => activeType === 'all' || item.type === activeType) || resources[0]
        activeId = selected && selected.id
        renderDetail(selected)
      }
      rows.forEach(row => {
        row.addEventListener('click', () => {
          activeId = row.dataset.resourceId
          applyFilters()
        })
      })
      featuredCards.forEach(card => {
        card.addEventListener('click', () => {
          activeId = card.dataset.resourceId
          activeType = 'all'
          filters.forEach(item => item.classList.toggle('active', item.dataset.type === 'all'))
          applyFilters()
          document.getElementById('market-rows')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
      })
      filters.forEach(button => {
        button.addEventListener('click', () => {
          activeType = button.dataset.type || 'all'
          filters.forEach(item => item.classList.toggle('active', item === button))
          const firstVisible = resources.find(resource => activeType === 'all' || resource.type === activeType)
          activeId = firstVisible && firstVisible.id
          applyFilters()
        })
      })
      if (search) search.addEventListener('input', applyFilters)
      applyFilters()
    </script>`
  return text(renderShell('资源市场', body), 200, 'text/html; charset=utf-8')
}

function renderSubmissionRows(records: SubmissionRecord[]) {
  return records.map(record => {
    const statusClass = record.status === 'approved' ? 'approved' : record.status === 'rejected' ? 'rejected' : 'pending'
    const actions = record.status === 'pending_review'
      ? `<button class="button" data-action="approve" data-id="${escapeHtml(record.id)}">通过并发布</button>
         <button class="ghost danger" data-action="reject" data-id="${escapeHtml(record.id)}">拒绝</button>`
      : `<span class="badge ${statusClass}">${escapeHtml(record.reviewedAt || '')}</span>`
    return `<tr>
      <td><strong>${escapeHtml(record.resource.name)}</strong><br><code>${escapeHtml(record.resource.id)}</code></td>
      <td><span class="badge">${escapeHtml(record.resource.type)}</span></td>
      <td>v${escapeHtml(record.resource.version)}</td>
      <td><span class="badge ${statusClass}">${escapeHtml(record.status)}</span></td>
      <td>${Math.round(record.size / 1024)} KB<br><code>${escapeHtml(record.sha256.slice(0, 12))}...</code></td>
      <td>${escapeHtml(record.submittedBy || 'unknown')}<br>${escapeHtml(record.submittedAt.slice(0, 19).replace('T', ' '))}</td>
      <td><div class="actions">${actions}</div></td>
    </tr>`
  }).join('')
}

async function renderReviewPageV2() {
  const records = await listSubmissions()
  const pendingCount = records.filter(record => record.status === 'pending_review').length
  const body = `<style>
      .review-layout { display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:16px; align-items:start; }
      .rules-list { display:grid; gap:10px; }
      .rule-item { border:1px solid var(--line); border-radius:8px; background:var(--soft); padding:12px; }
      .rule-title { font-weight:850; margin-bottom:4px; }
      .review-table-wrap { overflow:auto; border:1px solid var(--line); border-radius:8px; background:white; }
      .review-table { width:100%; border-collapse:collapse; min-width:860px; }
      .review-table th,.review-table td { border-bottom:1px solid var(--line); padding:12px; vertical-align:top; text-align:left; }
      .review-table th { background:var(--soft); color:var(--muted); font-size:11px; font-weight:850; text-transform:uppercase; letter-spacing:.04em; }
      .review-table tr:last-child td { border-bottom:0; }
      .upload-panel { position:sticky; top:82px; }
      @media (max-width:980px) { .review-layout { display:block; } .upload-panel { position:static; margin-top:16px; } }
    </style>
    <h1>资源审核后台</h1>
    <p class="lead">上传资源包后进入待审核队列。审核通过后写入发布索引并出现在 Catalog；拒绝的资源只保留审核记录。</p>
    <div class="market-summary" style="margin-bottom:16px">
      <span class="badge pending">${pendingCount} 个待审核</span>
      <span class="badge">${records.length} 个提交记录</span>
      <span class="badge">zip + resource.json + 类型专属文件</span>
    </div>
    <div class="toast" id="toast"></div>
    <div class="review-layout">
      <section>
        ${records.length
          ? `<div class="review-table-wrap">
              <table class="review-table">
                <thead><tr><th>资源</th><th>类型</th><th>版本</th><th>状态</th><th>包</th><th>提交</th><th>操作</th></tr></thead>
                <tbody>${renderSubmissionRows(records)}</tbody>
              </table>
            </div>`
          : '<div class="empty">当前没有待处理或历史提交。</div>'}
      </section>
      <aside class="panel upload-panel">
        <h2 style="margin:0 0 12px;font-size:18px">提交资源</h2>
        <form id="upload-form" class="rules-list">
          <label>资源包 zip
            <input name="package" type="file" accept=".zip,application/zip" required />
          </label>
          <button class="button" type="submit">提交审核</button>
        </form>
        <div class="detail-section">
          <div class="detail-label">上传规范</div>
          <div class="rules-list">
            <div class="rule-item"><div class="rule-title">Skill</div>包含 SKILL.md 或 &lt;name&gt;/SKILL.md。</div>
            <div class="rule-item"><div class="rule-title">MCP</div>包含 mcp.json，安装时增量合并 data/mcp.json。</div>
            <div class="rule-item"><div class="rule-title">Tool</div>包含 tool.json，当前仅审核发布和展示。</div>
            <div class="rule-item"><div class="rule-title">Agent</div>类型预留，等待 agent.json 契约冻结。</div>
          </div>
        </div>
      </aside>
    </div>
    <script>
      const toast = document.getElementById('toast')
      function showToast(message) {
        toast.textContent = message
        toast.classList.add('show')
      }
      document.getElementById('upload-form').addEventListener('submit', async event => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        const response = await fetch('/api/submissions', { method: 'POST', headers: window.mikoWriteHeaders(), body: form })
        const result = await response.json().catch(() => ({}))
        if (!response.ok) {
          showToast(result.error || '提交失败')
          return
        }
        location.reload()
      })
      document.querySelectorAll('[data-action]').forEach(button => {
        button.addEventListener('click', async () => {
          const action = button.getAttribute('data-action')
          const id = button.getAttribute('data-id')
          const notes = prompt(action === 'reject' ? '拒绝原因' : '审核意见') || ''
          if (!notes) return
          const response = await fetch('/api/reviews/' + encodeURIComponent(id) + '/' + action, {
            method: 'POST',
            headers: window.mikoWriteHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ reviewer: 'local-reviewer', notes })
          })
          const result = await response.json().catch(() => ({}))
          if (!response.ok) {
            showToast(result.error || '审核操作失败')
            return
          }
          location.reload()
        })
      })
    </script>`
  return text(renderShell('资源审核后台', body, '', { audience: 'admin' }), 200, 'text/html; charset=utf-8')
}

function renderPublisherApplicationPage(application: Record<string, unknown> | null, isPublisher: boolean) {
  const status = asString(application?.status)
  const statusText = isPublisher
    ? 'Your account is already approved as a publisher.'
    : status === 'pending'
      ? 'Your publisher application is pending administrator review.'
      : status === 'rejected'
        ? `Your previous application was rejected: ${escapeHtml(application?.review_notes || 'No reason provided.')}`
        : 'Apply for publisher access to submit Skills, MCPs, Tools or Agents.'
  const disabled = isPublisher || status === 'pending' ? 'disabled' : ''
  const body = `<h1>申请发布者资格</h1>
    <p class="lead">普通账号不能直接上传资源。提交发布者申请后，管理员会审核你的发布者信息。</p>
    <div class="toast show">${statusText}</div>
    <section class="panel" style="max-width:760px"><form id="publisher-application" class="rules-list">
      <label>发布者名称<input name="publisherName" required ${disabled} value="${escapeHtml(application?.publisher_name || '')}" /></label>
      <label>简介<textarea name="description" rows="5" required ${disabled}>${escapeHtml(application?.description || '')}</textarea></label>
      <label>主页或组织地址<input name="websiteUrl" type="url" ${disabled} value="${escapeHtml(application?.website_url || '')}" placeholder="https://" /></label>
      <label>资源方向<input name="resourceFocus" required ${disabled} value="${escapeHtml(application?.resource_focus || '')}" placeholder="例如：安全审计、浏览器自动化" /></label>
      <button class="button" type="submit" ${disabled}>提交申请</button>
    </form></section>
    <script>
      const form=document.getElementById('publisher-application');
      const csrf=()=>decodeURIComponent((document.cookie.match(/(?:^|; )miko_csrf=([^;]*)/)||[])[1]||'');
      form.addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(form));const r=await fetch('/api/publisher/application',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf()},body:JSON.stringify(d)});const v=await r.json().catch(()=>({}));if(!r.ok){alert(v.error||'申请提交失败');return}location.reload()})
    </script>`
  return text(renderShell('申请发布者资格', body), 200, 'text/html; charset=utf-8')
}

async function renderAdminPage() {
  const users = authStore.listUsers()
  const published = (await readPublishedIndex()).resources
  const applications = authStore.listPublisherApplications()
  const rawAudit = await readFile(auditLogFile, 'utf-8').catch(() => '')
  const auditEvents = rawAudit.trim().split('\n').filter(Boolean).slice(-50).reverse().map(line => JSON.parse(line) as Record<string, unknown>)
  const userCards = users.map(user => `<article class="card"><strong>${escapeHtml(user.email)}</strong><div class="desc">${escapeHtml(user.display_name)}<br>${escapeHtml(user.roles.join(', '))}<br>${escapeHtml(user.status)}</div><label>角色<select data-role-select="${escapeHtml(user.id)}"><option value="publisher" ${user.roles.includes('publisher') ? 'selected' : ''}>发布者</option><option value="reviewer" ${user.roles.includes('reviewer') ? 'selected' : ''}>审核员</option><option value="admin" ${user.roles.includes('admin') ? 'selected' : ''}>管理员</option></select></label><div class="actions"><button class="ghost" data-role-user-id="${escapeHtml(user.id)}">更新角色</button>${user.status === 'active' ? `<button class="ghost danger" data-status="disable" data-user-id="${escapeHtml(user.id)}">禁用账号</button>` : `<button class="ghost" data-status="enable" data-user-id="${escapeHtml(user.id)}">启用账号</button>`}</div></article>`).join('')
  const resourceCards = published.map(record => `<article class="card"><strong>${escapeHtml(record.resource.name)}</strong><div class="desc"><code>${escapeHtml(record.resource.id)}</code><br>v${escapeHtml(record.resource.version)} · ${escapeHtml(record.status || 'published')}</div><button class="ghost ${record.status === 'taken_down' ? '' : 'danger'}" data-resource-id="${escapeHtml(record.resource.id)}" data-resource-version="${escapeHtml(record.resource.version)}" data-resource-action="${record.status === 'taken_down' ? 'restore' : 'take-down'}">${record.status === 'taken_down' ? '恢复发布' : '下架资源'}</button></article>`).join('')
  const applicationCards = applications.map(application => `<article class="card"><strong>${escapeHtml(application.publisher_name)}</strong><div class="desc">${escapeHtml(application.email)}<br>${escapeHtml(application.resource_focus)}<br>${escapeHtml(application.status)}</div><div class="actions">${application.status === 'pending' ? `<button class="button" data-application-action="approve" data-application-id="${escapeHtml(application.id)}">批准发布者</button><button class="ghost danger" data-application-action="reject" data-application-id="${escapeHtml(application.id)}">拒绝</button>` : `<span class="badge">${escapeHtml(application.review_notes || '')}</span>`}</div></article>`).join('')
  const auditRows = auditEvents.map(event => `<tr><td>${escapeHtml(event.at)}</td><td>${escapeHtml(event.event)}</td><td><code>${escapeHtml(event.actorId || '')}</code></td><td><code>${escapeHtml(event.targetUserId || event.resourceId || event.submissionId || '')}</code></td></tr>`).join('')
  const body = `<h1>市场管理</h1>
    <p class="lead">管理员负责账号、角色、审核和资源生命周期。所有敏感操作都由服务端鉴权并记录。</p>
    <div class="actions"><a class="button" href="/reviews">打开审核队列</a><button class="ghost" id="logout">退出登录</button></div>
    <div class="toast" id="toast"></div>
    <section class="panel"><h2 style="margin-top:0">新增后台账号</h2><form id="create-user" class="form-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
      <label>邮箱<input name="email" type="email" required /></label><label>显示名称<input name="displayName" required /></label>
      <label>初始密码<input name="password" type="password" minlength="12" required /></label><label>角色<select name="role"><option value="publisher">发布者</option><option value="reviewer">审核员</option><option value="admin">管理员</option></select></label>
      <button class="button" type="submit">创建账号</button></form></section>
    <section class="panel"><h2 style="margin-top:0">账号</h2><div id="users" class="grid">${userCards}</div></section>
    <section class="panel"><h2 style="margin-top:0">发布者申请</h2><div class="grid">${applicationCards || '<div class="empty">当前没有发布者申请。</div>'}</div></section>
    <section class="panel"><h2 style="margin-top:0">已发布资源</h2><div class="grid">${resourceCards || '<div class="empty">当前没有已发布资源。</div>'}</div></section>
    <section class="panel"><h2 style="margin-top:0">最近审计事件</h2><div style="overflow:auto"><table class="review-table"><thead><tr><th>时间</th><th>事件</th><th>操作者</th><th>目标</th></tr></thead><tbody>${auditRows}</tbody></table></div></section>
    <script>
      const toast=document.getElementById('toast'); const csrf=()=>decodeURIComponent((document.cookie.match(/(?:^|; )miko_csrf=([^;]*)/)||[])[1]||'');
      const api=(url,init={})=>fetch(url,{...init,headers:{...(init.headers||{}),'x-csrf-token':csrf()}});
      const show=m=>{toast.textContent=m;toast.classList.add('show')};
      document.querySelectorAll('[data-status]').forEach(b=>b.onclick=async()=>{const r=await api('/api/admin/users/'+encodeURIComponent(b.dataset.userId)+'/'+b.dataset.status,{method:'POST'});if(!r.ok){show((await r.json()).error||'操作失败');return}location.reload()});
      document.querySelectorAll('[data-role-user-id]').forEach(b=>b.onclick=async()=>{const id=b.dataset.roleUserId;const role=document.querySelector('[data-role-select="'+id+'"]').value;const r=await api('/api/admin/users/'+encodeURIComponent(id)+'/roles',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({roles:[role]})});if(!r.ok){show((await r.json()).error||'操作失败');return}location.reload()});
      document.querySelectorAll('[data-resource-action]').forEach(b=>b.onclick=async()=>{const notes=prompt(b.dataset.resourceAction==='take-down'?'下架原因':'恢复原因')||'';if(!notes)return;const r=await api('/api/admin/resources/'+encodeURIComponent(b.dataset.resourceId)+'/'+encodeURIComponent(b.dataset.resourceVersion)+'/'+b.dataset.resourceAction,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({notes})});if(!r.ok){show((await r.json()).error||'操作失败');return}location.reload()});
      document.querySelectorAll('[data-application-action]').forEach(b=>b.onclick=async()=>{const notes=prompt(b.dataset.applicationAction==='reject'?'拒绝原因':'批准说明')||'';if(!notes)return;const r=await api('/api/admin/publisher-applications/'+encodeURIComponent(b.dataset.applicationId)+'/'+b.dataset.applicationAction,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({notes})});if(!r.ok){show((await r.json()).error||'操作失败');return}location.reload()});
      document.getElementById('create-user').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget));const r=await api('/api/admin/users',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:d.email,displayName:d.displayName,password:d.password,roles:[d.role]})});if(!r.ok){show((await r.json()).error||'创建失败');return}location.reload()};
      document.getElementById('logout').onclick=async()=>{await api('/api/auth/logout',{method:'POST'});location.href='/'};
    </script>`
  return text(renderShell('市场管理', body, '', { audience: 'admin' }), 200, 'text/html; charset=utf-8')
}

async function renderMikoHomePageV3(origin: string) {
  const catalog = await readCatalog(origin)
  const resources = sortCatalogResources(catalog.resources)
  const counts = countResourcesByType(resources)
  const topResources = resources.slice(0, 3).map(resource => `<a class="home-mini-resource" href="/marketplace?resource=${encodeURIComponent(resource.id)}">
    <span class="badge">${escapeHtml(resource.type)}</span>
    <strong>${escapeHtml(resource.name)}</strong>
    <span>${escapeHtml(resource.description || '已发布资源')}</span>
  </a>`).join('')

  const body = `<style>
      .cursor-home { padding:22px 0 46px; }
      .cursor-hero { min-height:calc(100vh - 96px); display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }
      .cursor-kicker { display:inline-flex; min-height:30px; align-items:center; border:1px solid var(--line); border-radius:999px; background:white; color:var(--muted); padding:0 12px; font-size:12px; font-weight:850; margin-bottom:18px; }
      .cursor-title { max-width:1000px; margin:0 auto; font-size:72px; line-height:.98; letter-spacing:0; }
      .cursor-lead { max-width:760px; margin:20px auto 0; color:var(--muted); font-size:18px; line-height:1.75; }
      .cursor-actions { display:flex; flex-wrap:wrap; justify-content:center; gap:10px; margin-top:26px; }
      .command-bar { width:min(860px,100%); margin:30px auto 22px; border:1px solid var(--line); border-radius:8px; background:white; box-shadow:0 18px 48px rgba(23,32,51,.10); padding:10px; display:flex; align-items:center; gap:10px; text-align:left; }
      .command-icon { width:34px; height:34px; border-radius:8px; background:#eef3ff; color:var(--brand); display:grid; place-items:center; font-weight:900; flex:0 0 auto; }
      .command-text { min-width:0; flex:1; color:var(--muted); }
      .command-text strong { color:var(--text); }
      .workbench-shot { width:min(1120px,100%); border:1px solid var(--line); border-radius:8px; background:#0b1020; color:white; overflow:hidden; box-shadow:0 26px 70px rgba(23,32,51,.22); text-align:left; }
      .shot-bar { display:flex; align-items:center; justify-content:space-between; gap:12px; background:#121a2d; border-bottom:1px solid rgba(255,255,255,.10); padding:12px 14px; }
      .shot-tabs { display:flex; gap:8px; flex-wrap:wrap; }
      .shot-tab { border:1px solid rgba(255,255,255,.12); border-radius:999px; padding:5px 9px; color:#d0d5dd; font-size:12px; }
      .shot-tab.active { background:#2454d6; border-color:#2454d6; color:white; }
      .shot-body { display:grid; grid-template-columns:230px minmax(0,1fr) 280px; min-height:480px; }
      .shot-pane { border-right:1px solid rgba(255,255,255,.10); padding:16px; background:#101828; }
      .shot-main { padding:18px; background:#0e1526; }
      .shot-side { padding:16px; background:#111a2b; }
      .pane-item { display:flex; justify-content:space-between; align-items:center; gap:8px; border-radius:8px; padding:10px; color:#d0d5dd; margin-bottom:8px; background:rgba(255,255,255,.04); }
      .pane-item.active { background:#1b2f65; color:white; }
      .agent-card { border:1px solid rgba(255,255,255,.12); border-radius:8px; background:rgba(255,255,255,.04); padding:14px; margin-bottom:12px; }
      .agent-card strong { display:block; margin-bottom:8px; }
      .code-line { height:9px; border-radius:999px; background:#344054; margin:9px 0; }
      .code-line.short { width:62%; }
      .tool-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin-top:14px; }
      .tool-tile { border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:12px; background:rgba(255,255,255,.05); }
      .tool-tile b { display:block; margin-bottom:5px; }
      .tool-tile span,.shot-side p { color:#98a2b3; font-size:12px; line-height:1.55; }
      .capability-band { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin-top:28px; text-align:left; }
      .capability { border:1px solid var(--line); border-radius:8px; background:white; padding:18px; }
      .capability h3 { margin:0 0 8px; font-size:17px; }
      .capability p { margin:0; color:var(--muted); line-height:1.65; }
      .home-mini-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-top:14px; }
      .home-mini-resource { display:grid; gap:8px; min-height:128px; border:1px solid var(--line); border-radius:8px; background:white; padding:14px; text-align:left; }
      .home-mini-resource strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .home-mini-resource span:last-child { color:var(--muted); font-size:12px; line-height:1.55; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      @media (max-width:980px) { .cursor-title { font-size:52px; } .shot-body { grid-template-columns:1fr; } .shot-pane,.shot-side { border-right:0; border-bottom:1px solid rgba(255,255,255,.10); } .capability-band,.home-mini-grid { grid-template-columns:1fr; } }
      @media (max-width:640px) { .cursor-title { font-size:40px; } .command-bar { align-items:flex-start; } .tool-grid { grid-template-columns:1fr; } }
    </style>
    <div class="cursor-home">
      <section class="cursor-hero">
        <div class="cursor-kicker">Agent workspace for local-first development</div>
        <h1 class="cursor-title">Build with agents without losing control of your workspace.</h1>
        <p class="cursor-lead">Miko brings chat, terminal actions, permissions, Skills, MCP servers and a resource marketplace into one desktop workflow designed for repeatable engineering work.</p>
        <div class="cursor-actions">
          <a class="button" href="/marketplace">Explore resources</a>
          <a class="ghost" href="/marketplace">Browse reviewed packages</a>
        </div>
        <div class="command-bar" aria-label="Miko command prompt preview">
          <div class="command-icon">M</div>
          <div class="command-text"><strong>Ask Miko:</strong> install a browser MCP, review the permission impact, then keep user data untouched.</div>
          <span class="badge approved">ready</span>
        </div>
        <div class="workbench-shot" aria-label="Miko desktop workflow preview">
          <div class="shot-bar">
            <strong>Miko Desktop</strong>
            <div class="shot-tabs">
              <span class="shot-tab active">Agent</span>
              <span class="shot-tab">Permissions</span>
              <span class="shot-tab">MCP</span>
              <span class="shot-tab">Marketplace</span>
            </div>
          </div>
          <div class="shot-body">
            <aside class="shot-pane">
              <div class="pane-item active"><span>Current session</span><b>live</b></div>
              <div class="pane-item"><span>Ask permissions</span><b>on</b></div>
              <div class="pane-item"><span>Skills</span><b>${counts.skill}</b></div>
              <div class="pane-item"><span>MCP servers</span><b>${counts.mcp}</b></div>
              <div class="pane-item"><span>Resources</span><b>${resources.length}</b></div>
            </aside>
            <main class="shot-main">
              <div class="agent-card">
                <strong>Agent plan</strong>
                <div class="code-line"></div>
                <div class="code-line"></div>
                <div class="code-line short"></div>
              </div>
              <div class="agent-card">
                <strong>Install impact</strong>
                <div class="code-line"></div>
                <div class="code-line short"></div>
              </div>
              <div class="tool-grid">
                <div class="tool-tile"><b>Skill</b><span>Loaded from marketplace packages.</span></div>
                <div class="tool-tile"><b>MCP</b><span>Merged into data/mcp.json.</span></div>
                <div class="tool-tile"><b>Market</b><span>Reviewed zip packages with sha256.</span></div>
              </div>
            </main>
            <aside class="shot-side">
              <span class="badge approved">local boundary</span>
              <h3>Data stays separated</h3>
              <p>Built-in bundles, marketplace packages and user-owned data stay in separate roots, so updates do not overwrite user resources or history.</p>
            </aside>
          </div>
        </div>
      </section>
      <section class="capability-band">
        <div class="capability"><h3>Agent workflows</h3><p>Use conversations, terminal actions and permission modes as one operational surface.</p></div>
        <div class="capability"><h3>Resource marketplace</h3><p>Install Skills and MCP packages through a reviewed catalog instead of hand-copying folders.</p></div>
        <div class="capability"><h3>Clear boundaries</h3><p>User data, MCP config, Skills and history are protected from built-in bundle updates.</p></div>
      </section>
      <section class="home-section">
        <div class="section-head">
          <h2>Featured resources</h2>
          <a class="ghost" href="/marketplace">Browse marketplace</a>
        </div>
        <div class="home-mini-grid">${topResources || '<div class="empty">No published resources yet.</div>'}</div>
      </section>
    </div>`
  return text(renderShell('Miko', body), 200, 'text/html; charset=utf-8')
}

function renderMarketplaceCards(resources: CatalogResource[]) {
  return resources.map(resource => `<button class="smith-card" type="button" data-resource-id="${escapeHtml(resource.id)}">
    <span class="smith-card-top">
      <span class="resource-mark">${escapeHtml(resource.type.slice(0, 1).toUpperCase())}</span>
      <span class="badge">${escapeHtml(resource.type)}</span>
    </span>
    <strong>${escapeHtml(resource.name)}</strong>
    <span class="smith-card-desc">${escapeHtml(resource.description || '已发布资源')}</span>
    <span class="smith-card-meta">
      <span>${escapeHtml(resource.category || 'uncategorized')}</span>
      <span>v${escapeHtml(resource.version)}</span>
    </span>
  </button>`).join('')
}

async function renderMarketplacePageV3(origin: string, initialResourceId?: string | null) {
  const catalog = await readCatalog(origin)
  const resources = sortCatalogResources(catalog.resources)
  const counts = countResourcesByType(resources)
  const catalogData = { ...catalog, resources }
  const cards = renderMarketplaceCards(resources)
  const typePills = (['all', ...resourceTypeOrder] as const).map(type => {
    const label = type === 'all' ? 'All' : resourceTypeLabel[type]
    return `<button class="smith-filter${type === 'all' ? ' active' : ''}" type="button" data-type="${type}">
      <span>${escapeHtml(label)}</span><b>${counts[type]}</b>
    </button>`
  }).join('')

  const body = `<style>
      .smith-hero { padding:44px 0 28px; text-align:center; }
      .smith-kicker { display:inline-flex; min-height:30px; align-items:center; border:1px solid var(--line); border-radius:999px; background:white; color:var(--muted); padding:0 12px; font-size:12px; font-weight:850; margin-bottom:14px; }
      .smith-title { max-width:920px; margin:0 auto; font-size:56px; line-height:1.02; letter-spacing:0; }
      .smith-lead { max-width:760px; margin:18px auto 0; color:var(--muted); font-size:17px; line-height:1.7; }
      .smith-search-shell { max-width:820px; margin:24px auto 0; border:1px solid var(--line); border-radius:8px; background:white; box-shadow:0 18px 48px rgba(23,32,51,.10); padding:10px; display:flex; align-items:center; gap:10px; }
      .smith-search-icon { width:34px; height:34px; border-radius:8px; display:grid; place-items:center; background:#eef3ff; color:var(--brand); font-weight:900; }
      .smith-search { flex:1; border:0; box-shadow:none; min-height:38px; font-size:15px; }
      .smith-search:focus { border:0; box-shadow:none; }
      .smith-filters { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; margin-top:16px; }
      .smith-filter { min-height:34px; display:inline-flex; align-items:center; gap:8px; border:1px solid var(--line); border-radius:999px; background:white; color:var(--text); padding:0 12px; cursor:pointer; font-weight:800; }
      .smith-filter b { color:var(--muted); }
      .smith-filter:hover,.smith-filter.active { border-color:#b8c7ff; background:#eef3ff; color:var(--brand); }
      .smith-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin:24px auto 0; max-width:760px; }
      .smith-metric { border:1px solid var(--line); border-radius:8px; background:white; padding:12px; }
      .smith-metric strong { display:block; font-size:24px; line-height:1; }
      .smith-metric span { color:var(--muted); font-size:12px; display:block; margin-top:5px; }
      .smith-layout { display:grid; grid-template-columns:minmax(0,1fr) 360px; gap:16px; align-items:start; margin-top:22px; }
      .smith-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
      .smith-card { min-height:172px; display:grid; gap:10px; border:1px solid var(--line); border-radius:8px; background:white; color:var(--text); text-align:left; padding:15px; cursor:pointer; }
      .smith-card:hover,.smith-card.active { border-color:#a9bdff; background:#f7faff; }
      .smith-card-top,.smith-card-meta { display:flex; align-items:center; justify-content:space-between; gap:10px; }
      .resource-mark { width:34px; height:34px; border-radius:8px; display:grid; place-items:center; background:#172033; color:white; font-weight:900; }
      .smith-card strong { font-size:16px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .smith-card-desc { color:var(--muted); font-size:13px; line-height:1.55; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
      .smith-card-meta { color:var(--muted); font-size:12px; border-top:1px solid var(--line); padding-top:10px; }
      .smith-detail { border:1px solid var(--line); border-radius:8px; background:white; padding:16px; position:sticky; top:82px; min-height:420px; }
      .smith-detail h2 { margin:0; font-size:22px; overflow-wrap:anywhere; }
      .smith-detail-section { border-top:1px solid var(--line); margin-top:14px; padding-top:14px; }
      .smith-detail-label { color:var(--muted); font-size:11px; font-weight:850; text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px; }
      .smith-detail-text { color:var(--text); overflow-wrap:anywhere; line-height:1.6; }
      .smith-badges { display:flex; flex-wrap:wrap; gap:6px; }
      .smith-empty { border:1px dashed var(--line); border-radius:8px; background:white; color:var(--muted); padding:40px; text-align:center; }
      @media (max-width:1060px) { .smith-title { font-size:44px; } .smith-layout { grid-template-columns:1fr; } .smith-detail { position:static; } }
      @media (max-width:720px) { .smith-title { font-size:36px; } .smith-search-shell { align-items:flex-start; } .smith-grid,.smith-metrics { grid-template-columns:1fr; } }
    </style>
    <section class="smith-hero">
      <div class="smith-kicker">Connect Miko to capabilities</div>
      <h1 class="smith-title">Discover Skills, MCP servers and tools for your local agents.</h1>
      <p class="smith-lead">Browse reviewed resource packages, inspect their install impact, and connect Miko to local workflows without overwriting user-owned data.</p>
      <div class="smith-search-shell">
        <div class="smith-search-icon">/</div>
        <input id="market-search" class="smith-search" type="search" placeholder="Search resources, MCP servers, Skills or categories" />
        <span class="badge approved">${resources.length} published</span>
      </div>
      <div class="smith-filters">${typePills}</div>
      <div class="smith-metrics">
        <div class="smith-metric"><strong>${counts.skill}</strong><span>Skills</span></div>
        <div class="smith-metric"><strong>${counts.mcp}</strong><span>MCP</span></div>
        <div class="smith-metric"><strong>${counts.tool}</strong><span>Tools</span></div>
        <div class="smith-metric"><strong>${counts.agent}</strong><span>Agents</span></div>
      </div>
    </section>
    ${resources.length === 0
      ? '<div class="smith-empty">No published resources yet.</div>'
      : `<section class="smith-layout">
          <div>
            <div id="market-cards" class="smith-grid">${cards}</div>
            <div id="market-empty" class="smith-empty" style="display:none">No matching resources.</div>
          </div>
          <aside id="market-detail" class="smith-detail" aria-label="Resource detail"></aside>
        </section>`}
    <script type="application/json" id="market-data">${jsonForInlineScript(catalogData)}</script>
    <script>
      const marketData = JSON.parse(document.getElementById('market-data').textContent)
      const resources = marketData.resources || []
      let activeType = 'all'
      let activeId = ${JSON.stringify(initialResourceId || '')} || (resources[0] && resources[0].id)
      const cards = Array.from(document.querySelectorAll('.smith-card'))
      const detail = document.getElementById('market-detail')
      const empty = document.getElementById('market-empty')
      const search = document.getElementById('market-search')
      const filters = Array.from(document.querySelectorAll('.smith-filter'))
      function text(value) {
        return value === undefined || value === null || value === '' ? 'Not provided' : String(value)
      }
      function html(value) {
        return text(value).replace(/[&<>"']/g, char => ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[char])
      }
      function badges(values) {
        const list = values && values.length ? values : ['no extra permissions']
        return list.map(value => '<span class="badge">' + html(value) + '</span>').join('')
      }
      function packageHref(resource) {
        if (!resource.packageUrl) return ''
        try {
          const url = new URL(resource.packageUrl, window.location.origin)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
          return url.href
        } catch {
          return ''
        }
      }
      function installImpact(resource) {
        if (resource.type === 'skill') return 'Installs under data/marketplace/packages and is loaded by the Skill runtime when enabled. It does not write to user data/skills.'
        if (resource.type === 'mcp') return 'Installs package files, substitutes \${PACKAGE_DIR}, then merges mcpServers into data/mcp.json without overwriting user-owned servers.'
        if (resource.type === 'tool') return 'Available for discovery, upload review and catalog publishing. Runtime installation waits for the native tool registry contract.'
        if (resource.type === 'agent') return 'Reserved for Agent presets. Runtime installation waits for agent.json, dependency and permission contracts.'
        return 'No install impact is defined.'
      }
      function renderDetail(resource) {
        if (!detail || !resource) return
        const href = packageHref(resource)
        const packageLink = href
          ? '<a class="button" href="' + html(href) + '">Download package</a>'
          : '<span class="badge">No packageUrl</span>'
        detail.innerHTML = '<h2>' + html(resource.name) + '</h2>' +
          '<div class="meta"><span class="badge">' + html(resource.type) + '</span><span class="badge">v' + html(resource.version) + '</span><span class="badge approved">reviewed</span></div>' +
          '<div class="smith-detail-section"><div class="smith-detail-label">Resource ID</div><div class="smith-detail-text"><code>' + html(resource.id) + '</code></div></div>' +
          '<div class="smith-detail-section"><div class="smith-detail-label">Description</div><div class="smith-detail-text">' + html(resource.description || 'No description provided.') + '</div></div>' +
          '<div class="smith-detail-section"><div class="smith-detail-label">Install impact</div><div class="smith-detail-text">' + html(installImpact(resource)) + '</div></div>' +
          '<div class="smith-detail-section"><div class="smith-detail-label">Permissions</div><div class="smith-badges">' + badges(resource.permissions) + '</div></div>' +
          '<div class="smith-detail-section"><div class="smith-detail-label">Package sha256</div><div class="smith-detail-text"><code>' + html(resource.sha256) + '</code></div></div>' +
          '<div class="actions">' + packageLink + '</div>'
      }
      function applyFilters() {
        const term = (search && search.value || '').trim().toLowerCase()
        let visibleCount = 0
        cards.forEach(card => {
          const resource = resources.find(item => item.id === card.dataset.resourceId)
          const haystack = [resource.id, resource.name, resource.type, resource.category, resource.description].join(' ').toLowerCase()
          const visible = resource && (activeType === 'all' || resource.type === activeType) && (!term || haystack.includes(term))
          card.style.display = visible ? '' : 'none'
          card.classList.toggle('active', resource && resource.id === activeId)
          if (visible) visibleCount++
        })
        if (empty) empty.style.display = visibleCount === 0 ? '' : 'none'
        const selected = resources.find(item => item.id === activeId) || resources.find(item => activeType === 'all' || item.type === activeType) || resources[0]
        activeId = selected && selected.id
        renderDetail(selected)
      }
      cards.forEach(card => {
        card.addEventListener('click', () => {
          activeId = card.dataset.resourceId
          applyFilters()
        })
      })
      filters.forEach(button => {
        button.addEventListener('click', () => {
          activeType = button.dataset.type || 'all'
          filters.forEach(item => item.classList.toggle('active', item === button))
          const firstVisible = resources.find(resource => activeType === 'all' || resource.type === activeType)
          activeId = firstVisible && firstVisible.id
          applyFilters()
        })
      })
      if (search) search.addEventListener('input', applyFilters)
      applyFilters()
    </script>`
  return text(renderShell('资源市场', body), 200, 'text/html; charset=utf-8')
}

async function renderMikoHomePageV4(origin: string) {
  const catalog = await readCatalog(origin)
  const resources = sortCatalogResources(catalog.resources)
  const counts = countResourcesByType(resources)
  const featured = resources.slice(0, 4).map(resource => `<a class="v4-resource" href="/marketplace?resource=${encodeURIComponent(resource.id)}">
    <span class="v4-resource-icon">${escapeHtml(resource.type.slice(0, 1).toUpperCase())}</span>
    <span class="v4-resource-copy">
      <strong>${escapeHtml(resource.name)}</strong>
      <small>${escapeHtml(resource.type)} · v${escapeHtml(resource.version)}</small>
    </span>
  </a>`).join('')

  const body = `<style>
      body { background:#050506; color:#f4f4f5; }
      .topbar { border-bottom:1px solid rgba(255,255,255,.10); background:rgba(5,5,6,.86); }
      .logo { background:#f4f4f5; color:#050506; border-color:#f4f4f5; }
      .brand,.nav a { color:#f4f4f5; }
      .ghost { border-color:rgba(255,255,255,.16); background:rgba(255,255,255,.04); color:#f4f4f5; }
      .button { background:#f4f4f5; border-color:#f4f4f5; color:#050506; }
      .page { max-width:1320px; }
      .v4-home { padding:34px 0 68px; }
      .v4-hero { min-height:calc(100vh - 96px); display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }
      .v4-kicker { display:inline-flex; align-items:center; min-height:30px; border:1px solid rgba(255,255,255,.16); border-radius:999px; background:rgba(255,255,255,.06); color:#c7c7cc; padding:0 12px; font-size:12px; font-weight:850; }
      .v4-title { max-width:1080px; margin:18px auto 0; font-size:82px; line-height:.94; letter-spacing:0; font-weight:850; }
      .v4-lead { max-width:760px; margin:22px auto 0; color:#b5b5bd; font-size:18px; line-height:1.72; }
      .v4-actions { display:flex; flex-wrap:wrap; justify-content:center; gap:10px; margin-top:28px; }
      .v4-shell { width:min(1180px,100%); margin:34px auto 0; border:1px solid rgba(255,255,255,.12); border-radius:10px; background:#0d0d10; box-shadow:0 34px 90px rgba(0,0,0,.48); overflow:hidden; text-align:left; }
      .v4-window-bar { height:46px; display:flex; align-items:center; justify-content:space-between; gap:14px; border-bottom:1px solid rgba(255,255,255,.10); background:#111114; padding:0 16px; }
      .v4-dots { display:flex; gap:7px; }
      .v4-dots span { width:10px; height:10px; border-radius:999px; background:#3f3f46; }
      .v4-tabs { display:flex; flex-wrap:wrap; gap:7px; }
      .v4-tab { min-height:26px; display:inline-flex; align-items:center; border:1px solid rgba(255,255,255,.10); border-radius:7px; padding:0 9px; color:#a1a1aa; font-size:12px; }
      .v4-tab.active { background:#f4f4f5; color:#050506; border-color:#f4f4f5; }
      .v4-workbench { display:grid; grid-template-columns:230px minmax(0,1fr) 330px; min-height:560px; }
      .v4-left { background:#101014; border-right:1px solid rgba(255,255,255,.10); padding:14px; }
      .v4-center { background:#09090b; padding:16px; }
      .v4-right { background:#101014; border-left:1px solid rgba(255,255,255,.10); padding:16px; }
      .v4-nav-item { display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:40px; border-radius:8px; padding:0 11px; color:#c7c7cc; margin-bottom:7px; background:rgba(255,255,255,.035); }
      .v4-nav-item.active { background:#f4f4f5; color:#050506; }
      .v4-editor { border:1px solid rgba(255,255,255,.10); border-radius:8px; overflow:hidden; background:#111114; }
      .v4-editor-head { display:flex; align-items:center; justify-content:space-between; min-height:38px; border-bottom:1px solid rgba(255,255,255,.10); padding:0 12px; color:#a1a1aa; font-size:12px; }
      .v4-code { padding:18px; font:13px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace; color:#d4d4d8; }
      .v4-code div { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .v4-code .muted { color:#71717a; }
      .v4-code .accent { color:#8ab4ff; }
      .v4-code .ok { color:#89d185; }
      .v4-terminal { margin-top:14px; border:1px solid rgba(255,255,255,.10); border-radius:8px; background:#050506; padding:14px; font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace; color:#a1a1aa; }
      .v4-panel-title { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
      .v4-panel-title h3 { margin:0; font-size:15px; color:#f4f4f5; }
      .v4-agent-step { border:1px solid rgba(255,255,255,.10); border-radius:8px; padding:12px; margin-bottom:10px; background:rgba(255,255,255,.035); }
      .v4-agent-step strong { display:block; font-size:13px; margin-bottom:5px; }
      .v4-agent-step span { color:#a1a1aa; font-size:12px; line-height:1.55; }
      .v4-market-mini { display:grid; gap:8px; margin-top:14px; }
      .v4-resource { min-height:54px; display:flex; align-items:center; gap:10px; border:1px solid rgba(255,255,255,.10); border-radius:8px; background:rgba(255,255,255,.04); padding:9px; color:#f4f4f5; }
      .v4-resource-icon { width:34px; height:34px; border-radius:8px; display:grid; place-items:center; background:#f4f4f5; color:#050506; font-weight:900; flex:0 0 auto; }
      .v4-resource-copy { min-width:0; display:grid; gap:2px; }
      .v4-resource-copy strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .v4-resource-copy small { color:#a1a1aa; }
      .v4-below { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin-top:28px; text-align:left; }
      .v4-feature { border:1px solid rgba(255,255,255,.10); border-radius:10px; background:rgba(255,255,255,.045); padding:18px; }
      .v4-feature h3 { margin:0 0 8px; font-size:17px; }
      .v4-feature p { margin:0; color:#b5b5bd; line-height:1.65; }
      @media (max-width:1080px) { .v4-title { font-size:58px; } .v4-workbench { grid-template-columns:1fr; } .v4-left,.v4-right { border:0; border-bottom:1px solid rgba(255,255,255,.10); } .v4-below { grid-template-columns:1fr; } }
      @media (max-width:640px) { .v4-title { font-size:42px; } .v4-window-bar { height:auto; min-height:46px; align-items:flex-start; flex-direction:column; padding:12px; } .v4-code div { white-space:normal; } }
    </style>
    <main class="v4-home">
      <section class="v4-hero">
        <span class="v4-kicker">AI coding agent, local workspace control</span>
        <h1 class="v4-title">The agent workspace for shipping with your own tools.</h1>
        <p class="v4-lead">Miko combines chat, command execution, permission modes, Skills, MCP servers and a reviewed resource marketplace into a desktop workflow that keeps user data separated from built-in updates.</p>
        <div class="v4-actions">
          <a class="button" href="/marketplace">Open marketplace</a>
          <a class="ghost" href="/marketplace">Browse resources</a>
        </div>
        <section class="v4-shell" aria-label="Miko workspace product preview">
          <div class="v4-window-bar">
            <div class="v4-dots"><span></span><span></span><span></span></div>
            <div class="v4-tabs">
              <span class="v4-tab active">Agent</span>
              <span class="v4-tab">Terminal</span>
              <span class="v4-tab">Permissions</span>
              <span class="v4-tab">Marketplace</span>
            </div>
          </div>
          <div class="v4-workbench">
            <aside class="v4-left">
              <div class="v4-nav-item active"><span>Current task</span><b>live</b></div>
              <div class="v4-nav-item"><span>Ask permissions</span><b>on</b></div>
              <div class="v4-nav-item"><span>Skills</span><b>${counts.skill}</b></div>
              <div class="v4-nav-item"><span>MCP servers</span><b>${counts.mcp}</b></div>
              <div class="v4-nav-item"><span>Resources</span><b>${resources.length}</b></div>
            </aside>
            <section class="v4-center">
              <div class="v4-editor">
                <div class="v4-editor-head"><span>miko://workspace/agent-plan</span><span>reviewed</span></div>
                <div class="v4-code">
                  <div><span class="muted">01</span> <span class="accent">plan</span> install browser MCP from marketplace</div>
                  <div><span class="muted">02</span> verify package sha256 and resource manifest</div>
                  <div><span class="muted">03</span> merge mcpServers into data/mcp.json</div>
                  <div><span class="muted">04</span> preserve user Skills, tools and sessions</div>
                  <div><span class="muted">05</span> <span class="ok">ready</span> for agent use after restart</div>
                </div>
              </div>
              <div class="v4-terminal">
                <div>$ miko marketplace install skill.secskills</div>
                <div>package verified: sha256 matched</div>
                <div>data/mcp.json updated without overwriting user servers</div>
              </div>
            </section>
            <aside class="v4-right">
              <div class="v4-panel-title"><h3>Agent review</h3><span class="badge approved">safe</span></div>
              <div class="v4-agent-step"><strong>Permission boundary</strong><span>Marketplace packages install under data/marketplace/packages.</span></div>
              <div class="v4-agent-step"><strong>MCP impact</strong><span>Only declared server names are merged and tracked for uninstall.</span></div>
              <div class="v4-agent-step"><strong>User data</strong><span>History, manual Skills, tools and local MCP config stay user-owned.</span></div>
              <div class="v4-market-mini">${featured || '<div class="v4-agent-step"><strong>No resources</strong><span>Reviewed resources will appear here after publication.</span></div>'}</div>
            </aside>
          </div>
        </section>
      </section>
      <section class="v4-below">
        <div class="v4-feature"><h3>Use any workflow</h3><p>Run local agent sessions with terminal actions, file context and permission review in one place.</p></div>
        <div class="v4-feature"><h3>Connect capabilities</h3><p>Install Skills and MCP packages from a reviewed catalog instead of copying folders manually.</p></div>
        <div class="v4-feature"><h3>Keep boundaries clear</h3><p>Separate built-in bundles, marketplace packages and user-owned data for safer updates.</p></div>
      </section>
    </main>`
  return text(renderShell('Miko', body), 200, 'text/html; charset=utf-8')
}

function renderMarketplaceCardsV4(resources: CatalogResource[]) {
  return resources.map(resource => `<button class="v4m-card" type="button" data-resource-id="${escapeHtml(resource.id)}">
    <span class="v4m-card-head">
      <span class="v4m-icon">${escapeHtml(resource.type.slice(0, 1).toUpperCase())}</span>
      <span class="badge approved">verified</span>
    </span>
    <strong>${escapeHtml(resource.name)}</strong>
    <span class="v4m-desc">${escapeHtml(resource.description || 'Published marketplace resource')}</span>
    <span class="v4m-meta">
      <span>${escapeHtml(resource.type)}</span>
      <span>${escapeHtml(resource.category || 'uncategorized')}</span>
      <span>v${escapeHtml(resource.version)}</span>
    </span>
  </button>`).join('')
}

async function renderUnifiedHomeFromCatalog(origin: string) {
  const catalog = await readCatalog(origin)
  const resources = sortCatalogResources(catalog.resources)
  const counts = countResourcesByType(resources)
  return text(renderUnifiedHomePage(resources, counts), 200, 'text/html; charset=utf-8')
}

async function renderUnifiedMarketplaceFromCatalog(origin: string, initialResourceId?: string | null) {
  const catalog = await readCatalog(origin)
  const resources = sortCatalogResources(catalog.resources)
  const counts = countResourcesByType(resources)
  return text(
    renderUnifiedMarketplacePage(resources, counts, { ...catalog, resources }, initialResourceId),
    200,
    'text/html; charset=utf-8',
  )
}

async function renderMarketplacePageV4(origin: string, initialResourceId?: string | null) {
  const catalog = await readCatalog(origin)
  const resources = sortCatalogResources(catalog.resources)
  const counts = countResourcesByType(resources)
  const catalogData = { ...catalog, resources }
  const cards = renderMarketplaceCardsV4(resources)
  const filters = (['all', ...resourceTypeOrder] as const).map(type => {
    const label = type === 'all' ? 'All servers and skills' : resourceTypeLabel[type]
    return `<button class="v4m-filter${type === 'all' ? ' active' : ''}" type="button" data-type="${type}">
      <span>${escapeHtml(label)}</span><b>${counts[type]}</b>
    </button>`
  }).join('')

  const body = `<style>
      body { background:#07110d; color:#f5f7f2; }
      .topbar { border-bottom:1px solid rgba(255,255,255,.10); background:rgba(7,17,13,.88); }
      .logo { background:#d8ff7a; color:#07110d; border-color:#d8ff7a; }
      .brand,.nav a { color:#f5f7f2; }
      .ghost { border-color:rgba(255,255,255,.16); background:rgba(255,255,255,.045); color:#f5f7f2; }
      .button { background:#d8ff7a; border-color:#d8ff7a; color:#07110d; }
      .page { max-width:1320px; }
      .v4m-hero { padding:54px 0 30px; text-align:center; }
      .v4m-kicker { display:inline-flex; align-items:center; min-height:30px; border:1px solid rgba(216,255,122,.35); border-radius:999px; background:rgba(216,255,122,.10); color:#d8ff7a; padding:0 12px; font-size:12px; font-weight:850; }
      .v4m-title { max-width:980px; margin:16px auto 0; font-size:64px; line-height:.98; letter-spacing:0; }
      .v4m-lead { max-width:740px; margin:18px auto 0; color:#b9c3b4; font-size:17px; line-height:1.72; }
      .v4m-search { width:min(900px,100%); margin:28px auto 0; border:1px solid rgba(255,255,255,.12); border-radius:12px; background:#f8faf3; color:#07110d; box-shadow:0 26px 70px rgba(0,0,0,.30); padding:10px; display:grid; grid-template-columns:42px minmax(0,1fr) auto; gap:10px; align-items:center; text-align:left; }
      .v4m-search-mark { width:42px; height:42px; border-radius:10px; background:#07110d; color:#d8ff7a; display:grid; place-items:center; font-weight:900; }
      .v4m-search input { border:0; background:transparent; min-height:42px; font-size:16px; color:#07110d; }
      .v4m-search input:focus { border:0; box-shadow:none; }
      .v4m-filters { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; margin-top:18px; }
      .v4m-filter { min-height:36px; display:inline-flex; align-items:center; gap:8px; border:1px solid rgba(255,255,255,.14); border-radius:999px; background:rgba(255,255,255,.045); color:#f5f7f2; padding:0 13px; font-weight:850; cursor:pointer; }
      .v4m-filter b { color:#d8ff7a; }
      .v4m-filter:hover,.v4m-filter.active { background:#d8ff7a; border-color:#d8ff7a; color:#07110d; }
      .v4m-filter.active b,.v4m-filter:hover b { color:#07110d; }
      .v4m-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; width:min(760px,100%); margin:24px auto 0; }
      .v4m-metric { border:1px solid rgba(255,255,255,.10); border-radius:10px; background:rgba(255,255,255,.045); padding:13px; }
      .v4m-metric strong { display:block; font-size:25px; line-height:1; color:#f5f7f2; }
      .v4m-metric span { display:block; margin-top:5px; color:#b9c3b4; font-size:12px; }
      .v4m-layout { display:grid; grid-template-columns:minmax(0,1fr) 390px; gap:16px; align-items:start; margin-top:28px; }
      .v4m-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
      .v4m-card { min-height:198px; border:1px solid rgba(255,255,255,.10); border-radius:12px; background:#f8faf3; color:#07110d; padding:15px; text-align:left; display:grid; gap:10px; cursor:pointer; box-shadow:0 14px 34px rgba(0,0,0,.18); }
      .v4m-card:hover,.v4m-card.active { outline:2px solid #d8ff7a; outline-offset:2px; }
      .v4m-card-head,.v4m-meta { display:flex; align-items:center; justify-content:space-between; gap:10px; }
      .v4m-icon { width:42px; height:42px; border-radius:10px; background:#07110d; color:#d8ff7a; display:grid; place-items:center; font-weight:900; }
      .v4m-card strong { font-size:17px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .v4m-desc { color:#445047; font-size:13px; line-height:1.55; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
      .v4m-meta { border-top:1px solid #dfe5d9; padding-top:10px; color:#617064; font-size:12px; }
      .v4m-detail { position:sticky; top:82px; border:1px solid rgba(255,255,255,.10); border-radius:12px; background:#f8faf3; color:#07110d; padding:17px; min-height:460px; box-shadow:0 18px 44px rgba(0,0,0,.22); }
      .v4m-detail h2 { margin:0; font-size:24px; overflow-wrap:anywhere; }
      .v4m-detail .badge { background:#e7efd8; color:#07110d; }
      .v4m-section { border-top:1px solid #dfe5d9; margin-top:14px; padding-top:14px; }
      .v4m-label { color:#617064; font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px; }
      .v4m-text { line-height:1.62; overflow-wrap:anywhere; }
      .v4m-badges { display:flex; flex-wrap:wrap; gap:6px; }
      .v4m-empty { border:1px dashed rgba(255,255,255,.18); border-radius:12px; color:#b9c3b4; padding:42px; text-align:center; }
      @media (max-width:1120px) { .v4m-title { font-size:48px; } .v4m-layout { grid-template-columns:1fr; } .v4m-detail { position:static; } .v4m-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
      @media (max-width:720px) { .v4m-title { font-size:38px; } .v4m-search { grid-template-columns:42px minmax(0,1fr); } .v4m-search .badge { display:none; } .v4m-grid,.v4m-metrics { grid-template-columns:1fr; } }
    </style>
    <section class="v4m-hero">
      <span class="v4m-kicker">Connect local agents to reviewed capabilities</span>
      <h1 class="v4m-title">Tools and skills your Miko agents can actually use.</h1>
      <p class="v4m-lead">Search reviewed Skill and MCP packages, inspect what they change, and download signed catalog resources through a local-first marketplace flow.</p>
      <div class="v4m-search">
        <div class="v4m-search-mark">S</div>
        <input id="market-search" type="search" placeholder="Search MCP servers, Skills, tools or categories" />
        <span class="badge approved">${resources.length} published</span>
      </div>
      <div class="v4m-filters">${filters}</div>
      <div class="v4m-metrics">
        <div class="v4m-metric"><strong>${counts.skill}</strong><span>Skills</span></div>
        <div class="v4m-metric"><strong>${counts.mcp}</strong><span>MCP packages</span></div>
        <div class="v4m-metric"><strong>${counts.tool}</strong><span>Tools</span></div>
        <div class="v4m-metric"><strong>${counts.agent}</strong><span>Agents</span></div>
      </div>
    </section>
    ${resources.length === 0
      ? '<div class="v4m-empty">No published resources yet.</div>'
      : `<section class="v4m-layout">
          <div>
            <div id="market-cards" class="v4m-grid">${cards}</div>
            <div id="market-empty" class="v4m-empty" style="display:none">No matching resources.</div>
          </div>
          <aside id="market-detail" class="v4m-detail" aria-label="Resource detail"></aside>
        </section>`}
    <script type="application/json" id="market-data">${jsonForInlineScript(catalogData)}</script>
    <script>
      const marketData = JSON.parse(document.getElementById('market-data').textContent)
      const resources = marketData.resources || []
      let activeType = 'all'
      let activeId = ${JSON.stringify(initialResourceId || '')} || (resources[0] && resources[0].id)
      const cards = Array.from(document.querySelectorAll('.v4m-card'))
      const detail = document.getElementById('market-detail')
      const empty = document.getElementById('market-empty')
      const search = document.getElementById('market-search')
      const filters = Array.from(document.querySelectorAll('.v4m-filter'))
      function text(value) {
        return value === undefined || value === null || value === '' ? 'Not provided' : String(value)
      }
      function html(value) {
        return text(value).replace(/[&<>"']/g, char => ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[char])
      }
      function badges(values) {
        const list = values && values.length ? values : ['no extra permissions']
        return list.map(value => '<span class="badge">' + html(value) + '</span>').join('')
      }
      function packageHref(resource) {
        if (!resource.packageUrl) return ''
        try {
          const url = new URL(resource.packageUrl, window.location.origin)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
          return url.href
        } catch {
          return ''
        }
      }
      function installImpact(resource) {
        if (resource.type === 'skill') return 'Installs under data/marketplace/packages and is loaded by the Skill runtime when enabled. It does not write to user data/skills.'
        if (resource.type === 'mcp') return 'Installs package files, substitutes \${PACKAGE_DIR}, then merges mcpServers into data/mcp.json without overwriting user-owned servers.'
        if (resource.type === 'tool') return 'Available for discovery, upload review and catalog publishing. Runtime installation waits for the native tool registry contract.'
        if (resource.type === 'agent') return 'Reserved for Agent presets. Runtime installation waits for agent.json, dependency and permission contracts.'
        return 'No install impact is defined.'
      }
      function renderDetail(resource) {
        if (!detail || !resource) return
        const href = packageHref(resource)
        const packageLink = href
          ? '<a class="button" href="' + html(href) + '">Download package</a>'
          : '<span class="badge">No packageUrl</span>'
        detail.innerHTML = '<h2>' + html(resource.name) + '</h2>' +
          '<div class="meta"><span class="badge">' + html(resource.type) + '</span><span class="badge">v' + html(resource.version) + '</span><span class="badge approved">reviewed</span></div>' +
          '<div class="v4m-section"><div class="v4m-label">Resource ID</div><div class="v4m-text"><code>' + html(resource.id) + '</code></div></div>' +
          '<div class="v4m-section"><div class="v4m-label">Description</div><div class="v4m-text">' + html(resource.description || 'No description provided.') + '</div></div>' +
          '<div class="v4m-section"><div class="v4m-label">Install impact</div><div class="v4m-text">' + html(installImpact(resource)) + '</div></div>' +
          '<div class="v4m-section"><div class="v4m-label">Permissions</div><div class="v4m-badges">' + badges(resource.permissions) + '</div></div>' +
          '<div class="v4m-section"><div class="v4m-label">Package sha256</div><div class="v4m-text"><code>' + html(resource.sha256) + '</code></div></div>' +
          '<div class="actions">' + packageLink + '</div>'
      }
      function applyFilters() {
        const term = (search && search.value || '').trim().toLowerCase()
        let visibleCount = 0
        cards.forEach(card => {
          const resource = resources.find(item => item.id === card.dataset.resourceId)
          const haystack = [resource.id, resource.name, resource.type, resource.category, resource.description].join(' ').toLowerCase()
          const visible = resource && (activeType === 'all' || resource.type === activeType) && (!term || haystack.includes(term))
          card.style.display = visible ? '' : 'none'
          card.classList.toggle('active', resource && resource.id === activeId)
          if (visible) visibleCount++
        })
        if (empty) empty.style.display = visibleCount === 0 ? '' : 'none'
        const selected = resources.find(item => item.id === activeId) || resources.find(item => activeType === 'all' || item.type === activeType) || resources[0]
        activeId = selected && selected.id
        renderDetail(selected)
      }
      cards.forEach(card => {
        card.addEventListener('click', () => {
          activeId = card.dataset.resourceId
          applyFilters()
        })
      })
      filters.forEach(button => {
        button.addEventListener('click', () => {
          activeType = button.dataset.type || 'all'
          filters.forEach(item => item.classList.toggle('active', item === button))
          const firstVisible = resources.find(resource => activeType === 'all' || resource.type === activeType)
          activeId = firstVisible && firstVisible.id
          applyFilters()
        })
      })
      if (search) search.addEventListener('input', applyFilters)
      applyFilters()
    </script>`
  return text(renderShell('Resource Marketplace', body), 200, 'text/html; charset=utf-8')
}

export function startLocalMarketplaceServer() {
  const server = Bun.serve({
    host,
    port,
    async fetch(req) {
      try {
        if (req.method === 'OPTIONS') {
          if (!allowedOrigin || req.headers.get('origin') !== allowedOrigin) return new Response(null, { status: 403 })
          return new Response(null, {
            headers: {
              'access-control-allow-origin': allowedOrigin,
              'access-control-allow-credentials': 'true',
              'access-control-allow-methods': 'GET,POST,OPTIONS',
              'access-control-allow-headers': 'content-type,x-csrf-token',
              vary: 'Origin',
            },
          })
        }

        const url = new URL(req.url)
        if (req.method === 'GET' && url.pathname === '/register') {
          return renderRegistrationPage()
        }
        if (req.method === 'GET' && url.pathname === '/login') {
          return text(renderShell('登录资源市场', `<h1>登录</h1><p class="lead">登录后可以申请发布者资格、提交资源或进入审核后台。</p><section class="panel" style="max-width:440px"><div class="toast" id="toast"></div><form id="login" class="rules-list"><label>邮箱<input name="email" type="email" autocomplete="username" required /></label><label>密码<input name="password" type="password" autocomplete="current-password" required /></label><button class="button" type="submit">登录</button><a class="ghost" href="/register">注册普通账号</a></form></section><script>const f=document.getElementById('login');const t=document.getElementById('toast');f.addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(f));const r=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)});if(!r.ok){t.textContent='邮箱或密码错误，或登录尝试过于频繁';t.classList.add('show');return}const v=await r.json();location.href=v.user.roles.includes('admin')?'/admin':v.user.roles.includes('reviewer')?'/reviews':v.user.roles.includes('publisher')?'/publish':'/publisher/apply'})</script>`), 200, 'text/html; charset=utf-8')
        }
        if (req.method === 'POST' && url.pathname === '/api/auth/register') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const user = await authStore.registerUser({
            email: asString(body.email),
            displayName: asString(body.displayName),
            password: asString(body.password),
          })
          await appendAudit('auth.user.registered', { actorId: user?.id })
          return json({ user: { id: user?.id, email: user?.email, roles: user?.roles } }, 201)
        }
        if (req.method === 'POST' && url.pathname === '/api/auth/login') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const email = asString(body.email)
          const password = asString(body.password)
          if (!email || !password) return badRequest('Email and password are required')
          const login = await authStore.login(email, password)
          if (!login) return json({ error: 'Invalid credentials or too many attempts' }, 401)
          return jsonWithHeaders({ user: { id: login.actor.actorId, email: login.actor.email, roles: login.actor.roles }, csrfToken: login.csrfToken }, login.headers)
        }
        if (req.method === 'GET' && url.pathname === '/api/auth/me') {
          const auth = authStore.authenticate(req)
          if (!auth) return json({ error: 'Authentication required' }, 401)
          return json({ user: { id: auth.actor.actorId, email: auth.actor.email, roles: auth.actor.roles } })
        }
        if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
          const auth = authStore.authenticate(req)
          if (!auth) return json({ error: 'Authentication required' }, 401)
          const csrfError = requireCsrf(req, auth.actor)
          if (csrfError) return csrfError
          return jsonWithHeaders({ ok: true }, authStore.logout(req))
        }
        if (req.method === 'GET' && url.pathname === '/admin') {
          const auth = requireRole(req, ['admin'])
          if ('response' in auth) return auth.response
          return await renderAdminPage()
        }
        if (req.method === 'GET' && url.pathname === '/publisher/apply') {
          const auth = authStore.authenticate(req)
          if (!auth) return new Response(null, { status: 302, headers: { location: '/login' } })
          return renderPublisherApplicationPage(
            authStore.getPublisherApplication(auth.actor.actorId),
            auth.actor.roles.includes('publisher'),
          )
        }
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
          return await renderUnifiedHomeFromCatalog(url.origin)
        }
        if (req.method === 'GET' && url.pathname === '/marketplace') {
          return await renderUnifiedMarketplaceFromCatalog(url.origin, url.searchParams.get('resource'))
        }
        if (req.method === 'GET' && url.pathname === '/publish') {
          const auth = requireRole(req, ['publisher', 'admin'])
          if ('response' in auth) return auth.response
          return renderPublisherPage()
        }
        if (req.method === 'GET' && url.pathname === '/reviews') {
          const auth = requireRole(req, ['reviewer', 'admin'])
          if ('response' in auth) return auth.response
          return await renderReviewPageV2()
        }
        if (req.method === 'GET' && url.pathname === '/updates/update.json') {
          return signedJson(await readResourceUpdateManifest(url.origin))
        }
        if (req.method === 'GET' && (url.pathname === '/catalog.json' || url.pathname === '/api/catalog')) {
          return signedJson(await readCatalog(url.origin))
        }
        if (req.method === 'GET' && url.pathname === '/api/submissions/mine') {
          const auth = requireRole(req, ['publisher', 'admin'])
          if ('response' in auth) return auth.response
          const submissions = (await listSubmissions()).filter(record => record.submittedBy === auth.actor.actorId)
          return json({ submissions })
        }
        if (req.method === 'GET' && url.pathname === '/api/submissions') {
          const auth = requireRole(req, ['reviewer', 'admin'])
          if ('response' in auth) return auth.response
          return json({ submissions: await listSubmissions() })
        }
        if (req.method === 'GET' && url.pathname === '/api/publisher/application') {
          const auth = authStore.authenticate(req)
          if (!auth) return json({ error: 'Authentication required' }, 401)
          return json({ application: authStore.getPublisherApplication(auth.actor.actorId) })
        }
        if (req.method === 'POST' && url.pathname === '/api/publisher/application') {
          const auth = authStore.authenticate(req)
          if (!auth) return json({ error: 'Authentication required' }, 401)
          const csrfError = requireCsrf(req, auth.actor)
          if (csrfError) return csrfError
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const application = authStore.submitPublisherApplication({
            userId: auth.actor.actorId,
            publisherName: asString(body.publisherName),
            description: asString(body.description),
            websiteUrl: asString(body.websiteUrl),
            resourceFocus: asString(body.resourceFocus),
          })
          await appendAudit('publisher.application.submitted', { actorId: auth.actor.actorId, applicationId: (application as { id?: string } | null)?.id })
          return json({ application }, 201)
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/users') {
          const auth = requireRole(req, ['admin'])
          if ('response' in auth) return auth.response
          return json({ users: authStore.listUsers() })
        }
        if (req.method === 'POST' && url.pathname === '/api/admin/users') {
          const auth = requireRole(req, ['admin'])
          if ('response' in auth) return auth.response
          const csrfError = requireCsrf(req, auth.actor)
          if (csrfError) return csrfError
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const user = await authStore.createUser({
            email: asString(body.email),
            displayName: asString(body.displayName),
            password: asString(body.password),
            roles: parseMarketplaceRoles(body.roles),
          }, auth.actor.actorId)
          await appendAudit('admin.user.created', { actorId: auth.actor.actorId, targetUserId: user?.id, roles: user?.roles })
          return json({ user }, 201)
        }
        const adminUserStatusMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/(enable|disable)$/)
        if (req.method === 'POST' && adminUserStatusMatch) {
          const auth = requireRole(req, ['admin'])
          if ('response' in auth) return auth.response
          const csrfError = requireCsrf(req, auth.actor)
          if (csrfError) return csrfError
          const [, userId, action] = adminUserStatusMatch
          const user = authStore.updateUserStatus(decodeURIComponent(userId), action === 'enable' ? 'active' : 'disabled', auth.actor.actorId)
          if (!user) return json({ error: 'User not found' }, 404)
          await appendAudit(`admin.user.${action}d`, { actorId: auth.actor.actorId, targetUserId: userId })
          return json({ user })
        }
        const adminUserRolesMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/roles$/)
        if (req.method === 'POST' && adminUserRolesMatch) {
          const auth = requireRole(req, ['admin'])
          if ('response' in auth) return auth.response
          const csrfError = requireCsrf(req, auth.actor)
          if (csrfError) return csrfError
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const roles = parseMarketplaceRoles(body.roles)
          const userId = decodeURIComponent(adminUserRolesMatch[1])
          const user = authStore.updateUserRoles(userId, roles, auth.actor.actorId)
          if (!user) return json({ error: 'User not found' }, 404)
          await appendAudit('admin.user.roles_changed', { actorId: auth.actor.actorId, targetUserId: userId, roles })
          return json({ user })
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/audit') {
          const auth = requireRole(req, ['admin'])
          if ('response' in auth) return auth.response
          const raw = await readFile(auditLogFile, 'utf-8').catch(() => '')
          const events = raw.trim().split('\n').filter(Boolean).slice(-500).reverse().map(line => JSON.parse(line))
          return json({ events })
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/publisher-applications') {
          const auth = requireRole(req, ['admin'])
          if ('response' in auth) return auth.response
          return json({ applications: authStore.listPublisherApplications() })
        }
        const publisherApplicationReviewMatch = url.pathname.match(/^\/api\/admin\/publisher-applications\/([^/]+)\/(approve|reject)$/)
        if (req.method === 'POST' && publisherApplicationReviewMatch) {
          const auth = requireRole(req, ['admin'])
          if ('response' in auth) return auth.response
          const csrfError = requireCsrf(req, auth.actor)
          if (csrfError) return csrfError
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const [, applicationId, action] = publisherApplicationReviewMatch
          const application = authStore.reviewPublisherApplication(
            decodeURIComponent(applicationId),
            action === 'approve' ? 'approved' : 'rejected',
            auth.actor.actorId,
            asString(body.notes),
          )
          if (!application) return json({ error: 'Publisher application not found' }, 404)
          await appendAudit(`publisher.application.${action}d`, { actorId: auth.actor.actorId, applicationId })
          return json({ application })
        }
        if (req.method === 'GET' && url.pathname.startsWith('/packages/')) {
          return await servePackage(url.pathname)
        }
        if (req.method === 'POST' && url.pathname === '/api/submissions') {
          const auth = requireRole(req, ['publisher', 'admin'])
          if ('response' in auth) return auth.response
          const csrfError = requireCsrf(req, auth.actor)
          if (csrfError) return csrfError
          return await handleCreateSubmission(req, auth.actor)
        }
        const reviewMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/(approve|reject)$/)
        if (req.method === 'POST' && reviewMatch) {
          const auth = requireRole(req, ['reviewer', 'admin'])
          if ('response' in auth) return auth.response
          const csrfError = requireCsrf(req, auth.actor)
          if (csrfError) return csrfError
          const [, id, action] = reviewMatch
          const body = await readReviewBody(req)
          if (!body.notes) return badRequest('Review notes are required')
          const reviewer = auth.actor.actorId
          const record = action === 'approve'
            ? await approveSubmission(decodeURIComponent(id), reviewer, body.notes, auth.actor)
            : await rejectSubmission(decodeURIComponent(id), reviewer, body.notes, auth.actor)
          if (!record) return json({ error: 'Submission not found' }, 404)
          return json({ submission: record })
        }
        const adminResourceMatch = url.pathname.match(/^\/api\/admin\/resources\/([^/]+)\/([^/]+)\/(take-down|restore)$/)
        if (req.method === 'POST' && adminResourceMatch) {
          const auth = requireRole(req, ['admin'])
          if ('response' in auth) return auth.response
          const csrfError = requireCsrf(req, auth.actor)
          if (csrfError) return csrfError
          const [, rawId, rawVersion, action] = adminResourceMatch
          const body = await readReviewBody(req)
          if (!body.notes) return badRequest('Takedown and restore notes are required')
          const record = await updatePublishedResourceStatus(
            sanitizeId(decodeURIComponent(rawId), 'resource id'),
            sanitizeId(decodeURIComponent(rawVersion), 'version'),
            action === 'take-down' ? 'taken_down' : 'published',
            auth.actor,
            body.notes,
          )
          if (!record) return json({ error: 'Published resource version not found' }, 404)
          return json({ resource: record })
        }
        if (req.method === 'GET' && url.pathname === '/health') {
          await ensureSeedPublished()
          return json({ ok: true, storageRoot, bundledMarketplaceRoot })
        }
        return json({ error: 'Not found' }, 404)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: message }, 400)
      }
    },
  })

  console.log(`[marketplace] running at http://${host}:${port}`)
  console.log(`[marketplace] storage = ${storageRoot}`)
  console.log(`[marketplace] bundled = ${bundledMarketplaceRoot}`)
  return server
}

export function closeLocalMarketplaceAuthStoreForTests() {
  authStore.close()
}

if (import.meta.main) {
  startLocalMarketplaceServer()
}
