import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { unzipFile } from '../utils/dxt/zip.js'
import {
  getMarketplaceCatalogCacheFile,
  getBundledMarketplaceLocalCatalogFile,
  getMarketplaceInstalledFile,
  getMarketplaceLocalCatalogFile,
  getMarketplacePackagesDir,
  getMcpFile,
} from '../utils/kimoPaths.js'
import {
  McpJsonConfigSchema,
  McpServerConfigSchema,
  type McpServerConfig,
} from './mcp/types.js'
import {
  canonicalizeSignedJson,
  ResourceSignatureVerificationError,
  verifyResourceSignature,
  verifyResourceSignatureWithPublicKeys,
} from './resourceSignature.js'
import {
  getMarketplacePublicKeysForTrust,
  resolveMarketplaceTrustSource,
  type MarketplaceTrustSourceType,
} from './marketplaceTrust.js'

export type MarketplaceResourceType = 'skill' | 'mcp' | 'tool' | 'agent'
export type MarketplaceRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export type MarketplaceResource = {
  id: string
  type: MarketplaceResourceType
  name: string
  version: string
  category?: string
  description?: string
  packagePath?: string
  packageUrl?: string
  sha256?: string
  signature?: string
  minMikoVersion?: string
  publisher?: string
  sourceRepository?: string
  sourceCommit?: string
  license?: string
  riskLevel?: MarketplaceRiskLevel
  requiresExplicitAuthorization?: boolean
  permissions?: string[]
}

export type MarketplaceCatalog = {
  schemaVersion: 1
  source: 'local' | 'cache' | 'bundled' | 'empty'
  generatedAt?: string
  verification?: {
    signature: 'missing' | 'verified'
  }
  trust?: {
    sourceType: MarketplaceTrustSourceType
    label: string
    url?: string
    requiresSignature: boolean
    publicKeySource: 'official' | 'configured' | 'none'
  }
  resources: MarketplaceResource[]
}

export type InstalledMarketplaceResource = {
  id: string
  type: MarketplaceResourceType
  name: string
  version: string
  enabled: boolean
  origin: 'marketplace'
  packagePath: string
  installedAt: string
  updatedAt?: string
  userModified?: boolean
  mcpServers?: string[]
  mcpServerHashes?: Record<string, string>
  [key: string]: unknown
}

export type MarketplaceInstalledState = {
  schemaVersion: 1
  installed: Record<string, InstalledMarketplaceResource>
  [key: string]: unknown
}

export type MarketplaceSkillPackageLocation = {
  packageId: string
  name: string
  version: string
  skillDir: string
}

export type MarketplaceInstallPreview = {
  resource: MarketplaceResource
  operation: 'install' | 'update'
  targetPackagePath: string
  writes: string[]
  permissions: string[]
  verification: {
    sha256: 'present' | 'missing'
    signature: 'present' | 'missing'
  }
  mcpServers?: Array<{
    name: string
    type: McpServerConfig['type']
    command?: string
    args?: string[]
    envKeys?: string[]
    url?: string
  }>
}

export class MarketplaceServiceError extends Error {
  constructor(
    public code: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'UNSUPPORTED',
    message: string,
  ) {
    super(message)
    this.name = 'MarketplaceServiceError'
  }
}

const EMPTY_CATALOG: MarketplaceCatalog = {
  schemaVersion: 1,
  source: 'empty',
  resources: [],
}

const EMPTY_INSTALLED: MarketplaceInstalledState = {
  schemaVersion: 1,
  installed: {},
}

const DEFAULT_MARKETPLACE_CATALOG_URL = 'http://8.134.211.101/catalog.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value.filter((item): item is string => typeof item === 'string')
  return values.length > 0 ? values : undefined
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function isResourceType(value: unknown): value is MarketplaceResourceType {
  return value === 'skill' || value === 'mcp' || value === 'tool' || value === 'agent'
}

function isRiskLevel(value: unknown): value is MarketplaceRiskLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
}

function sanitizeResourceId(id: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new MarketplaceServiceError('BAD_REQUEST', `Invalid marketplace resource id: ${id}`)
  }
  return id
}

function normalizeCatalogResource(value: unknown): MarketplaceResource | null {
  if (!isRecord(value)) return null
  const id = asString(value.id)
  const type = value.type
  const name = asString(value.name)
  const version = asString(value.version)
  if (!id || !isResourceType(type) || !name || !version) return null

  return {
    id,
    type,
    name,
    version,
    category: asString(value.category),
    description: asString(value.description),
    packagePath: asString(value.packagePath),
    packageUrl: asString(value.packageUrl),
    sha256: asString(value.sha256),
    signature: asString(value.signature),
    minMikoVersion: asString(value.minMikoVersion),
    publisher: asString(value.publisher),
    sourceRepository: asString(value.sourceRepository),
    sourceCommit: asString(value.sourceCommit),
    license: asString(value.license),
    riskLevel: isRiskLevel(value.riskLevel) ? value.riskLevel : undefined,
    requiresExplicitAuthorization: value.requiresExplicitAuthorization === true,
    permissions: asStringArray(value.permissions),
  }
}

function normalizeCatalog(value: unknown, source: MarketplaceCatalog['source']): MarketplaceCatalog {
  if (!isRecord(value) || !Array.isArray(value.resources)) {
    return { ...EMPTY_CATALOG }
  }

  const rawVerification = isRecord(value.verification) ? value.verification : undefined
  const rawTrust = isRecord(value.trust) ? value.trust : undefined
  const signatureVerification = rawVerification?.signature === 'verified'
    ? 'verified'
    : rawVerification?.signature === 'missing'
      ? 'missing'
      : undefined
  const sourceType = rawTrust?.sourceType === 'official'
    || rawTrust?.sourceType === 'local-dev'
    || rawTrust?.sourceType === 'custom'
    ? rawTrust.sourceType
    : undefined
  const publicKeySource = rawTrust?.publicKeySource === 'official'
    || rawTrust?.publicKeySource === 'configured'
    || rawTrust?.publicKeySource === 'none'
    ? rawTrust.publicKeySource
    : undefined

  return {
    schemaVersion: 1,
    source,
    generatedAt: asString(value.generatedAt),
    verification: signatureVerification ? { signature: signatureVerification } : undefined,
    trust: sourceType ? {
      sourceType,
      label: asString(rawTrust?.label) || sourceType,
      url: asString(rawTrust?.url),
      requiresSignature: rawTrust?.requiresSignature === true,
      publicKeySource: publicKeySource || 'none',
    } : undefined,
    resources: value.resources
      .map(normalizeCatalogResource)
      .filter((resource): resource is MarketplaceResource => resource !== null),
  }
}

function normalizeRemoteCatalog(value: unknown): MarketplaceCatalog {
  const catalog = normalizeCatalog(value, 'cache')
  return {
    ...catalog,
    resources: catalog.resources.map(resource => ({
      ...resource,
      packagePath: resource.packageUrl ? undefined : resource.packagePath,
    })),
  }
}

function verifyRemoteCatalogSignature(
  rawBytes: Uint8Array,
  rawCatalog: unknown,
  response: Response,
  label: string,
  publicKeys: string[],
): 'missing' | 'verified' {
  const headerSignature = response.headers.get('x-miko-catalog-signature')
    || response.headers.get('x-kimo-catalog-signature')
  const bodySignature = isRecord(rawCatalog) ? asString(rawCatalog.signature) : undefined
  const signature = headerSignature || bodySignature
  const signedBytes = headerSignature
    ? rawBytes
    : new TextEncoder().encode(canonicalizeSignedJson(stripCatalogSignature(rawCatalog)))

  try {
    return verifyResourceSignatureWithPublicKeys(signedBytes, signature, label, publicKeys)
  } catch (error) {
    if (error instanceof ResourceSignatureVerificationError) {
      throw new MarketplaceServiceError('BAD_REQUEST', error.message)
    }
    throw error
  }
}

function stripCatalogSignature(value: unknown): unknown {
  if (!isRecord(value)) return value
  const { signature: _signature, verification: _verification, trust: _trust, source: _source, ...rest } = value
  return rest
}

function normalizeInstalledResource(id: string, value: unknown): InstalledMarketplaceResource | null {
  if (!isRecord(value)) return null
  const type = value.type
  const name = asString(value.name)
  const version = asString(value.version)
  const packagePathValue = asString(value.packagePath)
  const installedAt = asString(value.installedAt)
  if (!isResourceType(type) || !name || !version || !packagePathValue || !installedAt) {
    return null
  }

  return {
    ...value,
    id,
    type,
    name,
    version,
    enabled: value.enabled !== false,
    origin: 'marketplace',
    packagePath: packagePathValue,
    installedAt,
    updatedAt: asString(value.updatedAt),
    userModified: value.userModified === true,
    mcpServers: asStringArray(value.mcpServers),
    mcpServerHashes: asStringRecord(value.mcpServerHashes),
  }
}

function normalizeInstalled(value: unknown): MarketplaceInstalledState {
  if (!isRecord(value) || !isRecord(value.installed)) {
    return { ...EMPTY_INSTALLED, installed: {} }
  }

  const installed: Record<string, InstalledMarketplaceResource> = {}
  for (const [id, entry] of Object.entries(value.installed)) {
    const normalized = normalizeInstalledResource(id, entry)
    if (normalized) installed[id] = normalized
  }

  return {
    ...value,
    schemaVersion: 1,
    installed,
  }
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
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
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

function resolveRemoteCatalogUrl(catalogUrl?: string): string {
  const raw = catalogUrl?.trim() || process.env.KIMO_MARKETPLACE_CATALOG_URL?.trim() || DEFAULT_MARKETPLACE_CATALOG_URL
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new MarketplaceServiceError('BAD_REQUEST', `Invalid marketplace catalog URL: ${raw}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MarketplaceServiceError('BAD_REQUEST', `Unsupported marketplace catalog URL protocol: ${parsed.protocol}`)
  }

  return parsed.toString()
}

export async function refreshMarketplaceCatalog(catalogUrl?: string): Promise<MarketplaceCatalog> {
  const url = resolveRemoteCatalogUrl(catalogUrl)
  const trustSource = resolveMarketplaceTrustSource(url)
  let response: Response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } })
  } catch (error) {
    throw new MarketplaceServiceError(
      'BAD_REQUEST',
      `Unable to reach marketplace catalog ${url}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!response.ok) {
    throw new MarketplaceServiceError(
      'BAD_REQUEST',
      `Marketplace catalog request failed: ${response.status} ${response.statusText}`,
    )
  }

  const rawBytes = new Uint8Array(await response.arrayBuffer())
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(rawBytes)) as unknown
  } catch {
    throw new MarketplaceServiceError('BAD_REQUEST', 'Marketplace catalog response is not valid JSON')
  }

  const signatureVerification = verifyRemoteCatalogSignature(
    rawBytes,
    raw,
    response,
    `marketplace catalog ${url}`,
    trustSource.publicKeys,
  )
  if (signatureVerification === 'missing' && !trustSource.allowUnsigned) {
    throw new MarketplaceServiceError(
      'BAD_REQUEST',
      `Marketplace catalog signature is required for non-local source: ${url}`,
    )
  }
  const catalog = {
    ...normalizeRemoteCatalog(stripCatalogSignature(raw)),
    verification: { signature: signatureVerification },
    trust: {
      sourceType: trustSource.type,
      label: trustSource.label,
      url: trustSource.url,
      requiresSignature: trustSource.requiresSignature,
      publicKeySource: trustSource.publicKeySource,
    },
  }
  await writeMarketplaceCatalogCache(catalog)
  return catalog
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

function resolveCatalogPackagePath(resource: MarketplaceResource, catalogFilePath: string): string {
  if (!resource.packagePath) {
    throw new MarketplaceServiceError(
      'UNSUPPORTED',
      `Local install requires packagePath for ${resource.id}`,
    )
  }

  return path.isAbsolute(resource.packagePath)
    ? resource.packagePath
    : path.resolve(path.dirname(catalogFilePath), resource.packagePath)
}

function getInstalledPackagePath(resource: MarketplaceResource): string {
  sanitizeResourceId(resource.id)
  return path.join(getMarketplacePackagesDir(), resource.id, resource.version)
}

function isSamePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

async function copyPackageDirectory(source: string, target: string): Promise<void> {
  if (!(await pathExists(source))) {
    throw new MarketplaceServiceError('NOT_FOUND', `Package path does not exist: ${source}`)
  }

  if (isSamePath(source, target)) return

  await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.cp(source, target, { recursive: true })
}

function assertInside(parent: string, child: string): void {
  const relativePath = path.relative(parent, child)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new MarketplaceServiceError('BAD_REQUEST', `Package path escapes target directory: ${child}`)
  }
}

function safeEntryName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) {
    throw new MarketplaceServiceError('BAD_REQUEST', 'Remote package entry is missing a valid name')
  }
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new MarketplaceServiceError('BAD_REQUEST', `Unsafe remote package entry name: ${name}`)
  }
  return name
}

function resolvePackageUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new MarketplaceServiceError('BAD_REQUEST', `Invalid package URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MarketplaceServiceError('BAD_REQUEST', `Unsupported package URL protocol: ${url.protocol}`)
  }
  return url
}

function normalizeSha256(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new MarketplaceServiceError('BAD_REQUEST', `Invalid package sha256: ${value}`)
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
    throw new MarketplaceServiceError(
      'BAD_REQUEST',
      `Unable to reach remote package metadata ${url}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!response.ok) {
    throw new MarketplaceServiceError(
      'BAD_REQUEST',
      `Remote package metadata request failed: ${response.status} ${response.statusText}`,
    )
  }
  return response.json().catch(() => {
    throw new MarketplaceServiceError('BAD_REQUEST', `Remote package metadata is not valid JSON: ${url}`)
  })
}

async function fetchFile(url: URL): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new MarketplaceServiceError(
      'BAD_REQUEST',
      `Unable to download marketplace package ${url}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!response.ok) {
    throw new MarketplaceServiceError(
      'BAD_REQUEST',
      `Remote package file request failed: ${response.status} ${response.statusText}`,
    )
  }
  return new Uint8Array(await response.arrayBuffer())
}

async function fetchVerifiedPackageZip(
  sourceUrl: string,
  expectedSha256?: string,
  signature?: string,
  publicKeys?: string[],
): Promise<{ url: URL; zipData: Uint8Array }> {
  const url = resolvePackageUrl(sourceUrl)
  const expectedHash = normalizeSha256(expectedSha256)
  const zipData = await fetchFile(url)
  const actualHash = hashSha256(zipData)
  if (expectedHash && actualHash !== expectedHash) {
    throw new MarketplaceServiceError(
      'BAD_REQUEST',
      `Package sha256 mismatch for ${url}: expected ${expectedHash}, got ${actualHash}`,
    )
  }
  try {
    if (publicKeys) {
      verifyResourceSignatureWithPublicKeys(zipData, signature, `marketplace package ${url}`, publicKeys)
    } else {
      verifyResourceSignature(zipData, signature, `marketplace package ${url}`)
    }
  } catch (error) {
    if (error instanceof ResourceSignatureVerificationError) {
      throw new MarketplaceServiceError('BAD_REQUEST', error.message)
    }
    throw error
  }
  return { url, zipData }
}

function isRemoteDirectoryListing(value: unknown): value is {
  type: 'directory'
  entries: Array<{ name: unknown; type: unknown; url: unknown }>
} {
  return isRecord(value) && value.type === 'directory' && Array.isArray(value.entries)
}

async function downloadRemoteDirectory(url: URL, targetDir: string): Promise<void> {
  const listing = await fetchJson(url)
  if (!isRemoteDirectoryListing(listing)) {
    throw new MarketplaceServiceError('BAD_REQUEST', `Remote package URL must return a directory listing: ${url}`)
  }

  await fs.mkdir(targetDir, { recursive: true })
  for (const entry of listing.entries) {
    const name = safeEntryName(entry.name)
    const entryUrlValue = typeof entry.url === 'string' ? entry.url : ''
    if (!entryUrlValue) {
      throw new MarketplaceServiceError('BAD_REQUEST', `Remote package entry is missing url: ${name}`)
    }

    const entryUrl = new URL(entryUrlValue, url)
    const targetPath = path.join(targetDir, name)
    assertInside(targetDir, targetPath)

    if (entry.type === 'directory') {
      await downloadRemoteDirectory(entryUrl, targetPath)
      continue
    }

    if (entry.type !== 'file') {
      throw new MarketplaceServiceError('BAD_REQUEST', `Unsupported remote package entry type for ${name}`)
    }

    await fs.writeFile(targetPath, await fetchFile(entryUrl))
  }
}

async function downloadPackageDirectory(sourceUrl: string, target: string): Promise<void> {
  const url = resolvePackageUrl(sourceUrl)
  const staging = path.join(
    path.dirname(getMarketplaceInstalledFile()),
    'staging',
    `${Date.now()}-${randomUUID()}`,
  )

  await fs.rm(staging, { recursive: true, force: true })
  try {
    await downloadRemoteDirectory(url, staging)
    await fs.rm(target, { recursive: true, force: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.rename(staging, target)
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function downloadPackageZip(
  sourceUrl: string,
  target: string,
  expectedSha256?: string,
  signature?: string,
  publicKeys?: string[],
): Promise<void> {
  const staging = path.join(
    path.dirname(getMarketplaceInstalledFile()),
    'staging',
    `${Date.now()}-${randomUUID()}`,
  )

  await fs.rm(staging, { recursive: true, force: true })
  try {
    const { zipData } = await fetchVerifiedPackageZip(sourceUrl, expectedSha256, signature, publicKeys)

    const files = await unzipFile(Buffer.from(zipData))
    await fs.mkdir(staging, { recursive: true })
    for (const [entryPath, content] of Object.entries(files)) {
      if (entryPath.endsWith('/')) continue
      const targetPath = path.join(staging, entryPath)
      assertInside(staging, targetPath)
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.writeFile(targetPath, content)
    }

    await fs.rm(target, { recursive: true, force: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.rename(staging, target)
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function assertSupportedLocalPackage(resource: MarketplaceResource, packagePathValue: string): Promise<void> {
  if (resource.type !== 'skill') {
    return
  }

  const directSkillFile = path.join(packagePathValue, 'SKILL.md')
  const nestedSkillFile = path.join(packagePathValue, resource.name, 'SKILL.md')
  if (!(await pathExists(directSkillFile)) && !(await pathExists(nestedSkillFile))) {
    throw new MarketplaceServiceError(
      'BAD_REQUEST',
      `Skill package ${resource.id} must contain SKILL.md or ${resource.name}/SKILL.md`,
    )
  }
}

function sanitizeMcpServerName(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new MarketplaceServiceError(
      'BAD_REQUEST',
      `Invalid MCP server name: ${name}. Names can only contain letters, numbers, hyphens, and underscores.`,
    )
  }
  return name
}

function substitutePackageDir(value: unknown, packageRoot: string): unknown {
  if (typeof value === 'string') {
    if (!value.includes('${PACKAGE_DIR}')) return value
    return path.normalize(value.replaceAll('${PACKAGE_DIR}', packageRoot))
  }
  if (Array.isArray(value)) {
    return value.map(entry => substitutePackageDir(entry, packageRoot))
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substitutePackageDir(entry, packageRoot)]),
    )
  }
  return value
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJson(value[key])]),
  )
}

function hashJson(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeJson(value)))
    .digest('hex')
}

function hashMcpServers(servers: Record<string, McpServerConfig>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(servers).map(([serverName, serverConfig]) => [serverName, hashJson(serverConfig)]),
  )
}

function assertMarketplaceMcpServerUnmodified(
  serverName: string,
  currentConfig: unknown,
  expectedHash: string | undefined,
  action: 'update' | 'uninstall',
): void {
  if (currentConfig === undefined || !expectedHash) return
  const currentHash = hashJson(currentConfig)
  if (currentHash === expectedHash) return

  throw new MarketplaceServiceError(
    'CONFLICT',
    `MCP server ${serverName} was modified in data/mcp.json; ${action} refused to avoid overwriting user changes`,
  )
}

async function readMarketplaceMcpPackage(
  resource: MarketplaceResource,
  packagePathValue: string,
): Promise<Record<string, McpServerConfig>> {
  const mcpFile = path.join(packagePathValue, 'mcp.json')
  if (!(await pathExists(mcpFile))) {
    throw new MarketplaceServiceError('BAD_REQUEST', `MCP package ${resource.id} must contain mcp.json`)
  }

  const rawText = (await fs.readFile(mcpFile, 'utf-8')).replace(/^\uFEFF/, '')
  return parseMarketplaceMcpPackage(resource, rawText, packagePathValue)
}

function parseMarketplaceMcpPackage(
  resource: MarketplaceResource,
  rawText: string,
  packagePathValue: string,
): Record<string, McpServerConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(rawText)
  } catch {
    throw new MarketplaceServiceError('BAD_REQUEST', `MCP package ${resource.id} has invalid mcp.json`)
  }

  const parsed = McpJsonConfigSchema().safeParse(raw)
  if (!parsed.success) {
    const message = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', ')
    throw new MarketplaceServiceError('BAD_REQUEST', `MCP package ${resource.id} mcp.json is invalid: ${message}`)
  }

  const entries = Object.entries(parsed.data.mcpServers)
  if (entries.length === 0) {
    throw new MarketplaceServiceError('BAD_REQUEST', `MCP package ${resource.id} must define at least one server`)
  }

  const servers: Record<string, McpServerConfig> = {}
  for (const [serverName, serverConfig] of entries) {
    sanitizeMcpServerName(serverName)
    const substituted = substitutePackageDir(serverConfig, packagePathValue)
    const validated = McpServerConfigSchema().safeParse(substituted)
    if (!validated.success) {
      const message = validated.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', ')
      throw new MarketplaceServiceError('BAD_REQUEST', `MCP server ${serverName} is invalid after install: ${message}`)
    }
    servers[serverName] = validated.data
  }

  return servers
}

function summarizeMcpServers(servers: Record<string, McpServerConfig>): NonNullable<MarketplaceInstallPreview['mcpServers']> {
  return Object.entries(servers).map(([name, server]) => {
    const env = 'env' in server && isRecord(server.env) ? server.env : undefined
    const args = 'args' in server && Array.isArray(server.args)
      ? server.args.filter((arg): arg is string => typeof arg === 'string')
      : undefined
    return {
      name,
      type: server.type,
      command: 'command' in server && typeof server.command === 'string' ? server.command : undefined,
      args,
      envKeys: env ? Object.keys(env).sort() : undefined,
      url: 'url' in server && typeof server.url === 'string' ? server.url : undefined,
    }
  })
}

async function readMarketplaceMcpZipPreview(
  resource: MarketplaceResource,
  targetPackagePath: string,
  publicKeys: string[],
): Promise<Record<string, McpServerConfig> | undefined> {
  if (!resource.packageUrl) return undefined
  const packageUrl = resolvePackageUrl(resource.packageUrl)
  if (!packageUrl.pathname.toLowerCase().endsWith('.zip')) return undefined

  const { zipData } = await fetchVerifiedPackageZip(resource.packageUrl, resource.sha256, resource.signature, publicKeys)
  const files = await unzipFile(Buffer.from(zipData))
  const rawManifest = files['resource.json']
  if (rawManifest) {
    assertPackageManifestObject(
      resource,
      JSON.parse(Buffer.from(rawManifest).toString('utf-8').replace(/^\uFEFF/, '')) as unknown,
    )
  }
  const rawMcp = files['mcp.json']
  if (!rawMcp) return undefined

  return parseMarketplaceMcpPackage(resource, Buffer.from(rawMcp).toString('utf-8').replace(/^\uFEFF/, ''), targetPackagePath)
}

async function readUserMcpJson(): Promise<Record<string, unknown>> {
  const raw = await readJsonFile(getMcpFile())
  if (raw === null) return { mcpServers: {} }
  if (!isRecord(raw)) {
    throw new MarketplaceServiceError('BAD_REQUEST', 'data/mcp.json must be a JSON object')
  }
  const mcpServers = raw.mcpServers
  if (mcpServers !== undefined && !isRecord(mcpServers)) {
    throw new MarketplaceServiceError('BAD_REQUEST', 'data/mcp.json mcpServers must be an object')
  }
  return {
    ...raw,
    mcpServers: mcpServers ?? {},
  }
}

async function installMarketplaceMcpServers(
  resource: MarketplaceResource,
  packagePathValue: string,
  previous?: InstalledMarketplaceResource,
): Promise<{ serverNames: string[]; serverHashes: Record<string, string> }> {
  const packageServers = await readMarketplaceMcpPackage(resource, packagePathValue)
  const existing = await readUserMcpJson()
  const existingServers = existing.mcpServers as Record<string, unknown>
  const previousServers = new Set(previous?.mcpServers ?? [])
  const previousServerHashes = previous?.mcpServerHashes ?? {}

  for (const serverName of previousServers) {
    assertMarketplaceMcpServerUnmodified(
      serverName,
      existingServers[serverName],
      previousServerHashes[serverName],
      'update',
    )
  }

  for (const serverName of Object.keys(packageServers)) {
    if (existingServers[serverName] !== undefined && !previousServers.has(serverName)) {
      throw new MarketplaceServiceError(
        'CONFLICT',
        `MCP server ${serverName} already exists in data/mcp.json`,
      )
    }
  }

  const nextServers = { ...existingServers }
  for (const serverName of previousServers) {
    if (packageServers[serverName] === undefined) {
      delete nextServers[serverName]
    }
  }
  for (const [serverName, serverConfig] of Object.entries(packageServers)) {
    nextServers[serverName] = serverConfig
  }

  await writeJsonFileAtomic(getMcpFile(), {
    ...existing,
    mcpServers: nextServers,
  })
  return {
    serverNames: Object.keys(packageServers),
    serverHashes: hashMcpServers(packageServers),
  }
}

async function uninstallMarketplaceMcpServers(resource: InstalledMarketplaceResource): Promise<void> {
  const serverNames = resource.mcpServers ?? []
  if (resource.type !== 'mcp' || serverNames.length === 0) return

  const existing = await readUserMcpJson()
  const existingServers = existing.mcpServers as Record<string, unknown>
  const serverHashes = resource.mcpServerHashes ?? {}

  for (const serverName of serverNames) {
    assertMarketplaceMcpServerUnmodified(
      serverName,
      existingServers[serverName],
      serverHashes[serverName],
      'uninstall',
    )
  }

  const nextServers = { ...existingServers }
  for (const serverName of serverNames) {
    delete nextServers[serverName]
  }

  await writeJsonFileAtomic(getMcpFile(), {
    ...existing,
    mcpServers: nextServers,
  })
}

async function assertPackageManifest(resource: MarketplaceResource, packagePathValue: string): Promise<void> {
  const manifestFile = path.join(packagePathValue, 'resource.json')
  if (!(await pathExists(manifestFile))) {
    throw new MarketplaceServiceError('BAD_REQUEST', `Package ${resource.id} must contain resource.json`)
  }

  const rawText = (await fs.readFile(manifestFile, 'utf-8')).replace(/^\uFEFF/, '')
  const raw = JSON.parse(rawText) as unknown
  assertPackageManifestObject(resource, raw)
}

function assertPackageManifestObject(resource: MarketplaceResource, raw: unknown): void {
  if (!isRecord(raw)) {
    throw new MarketplaceServiceError('BAD_REQUEST', `Package ${resource.id} has invalid resource.json`)
  }

  const manifestId = asString(raw.id)
  const manifestType = raw.type
  const manifestVersion = asString(raw.version)
  if (manifestId !== resource.id || manifestType !== resource.type || manifestVersion !== resource.version) {
    throw new MarketplaceServiceError(
      'BAD_REQUEST',
      `Package manifest does not match catalog entry for ${resource.id}`,
    )
  }
}

async function getCatalogResourceById(id: string): Promise<{
  resource: MarketplaceResource
  catalog: MarketplaceCatalog
  catalogFile: { source: 'local' | 'cache' | 'bundled'; filePath: string }
}> {
  sanitizeResourceId(id)
  const catalogFile = await findCatalogFile()
  if (!catalogFile) {
    throw new MarketplaceServiceError('NOT_FOUND', 'Marketplace catalog is not available')
  }

  const catalog = normalizeCatalog(await readJsonFile(catalogFile.filePath), catalogFile.source)
  const resource = catalog.resources.find((entry) => entry.id === id)
  if (!resource) {
    throw new MarketplaceServiceError('NOT_FOUND', `Marketplace resource not found: ${id}`)
  }

  return { resource, catalog, catalogFile }
}

async function getMcpPreviewServers(
  resource: MarketplaceResource,
  catalogFile: { source: 'local' | 'cache' | 'bundled'; filePath: string },
  targetPackagePath: string,
  publicKeys: string[],
): Promise<Record<string, McpServerConfig> | undefined> {
  if (resource.type !== 'mcp') return undefined
  if (resource.packageUrl) {
    return readMarketplaceMcpZipPreview(resource, targetPackagePath, publicKeys)
  }

  const sourcePackagePath = resolveCatalogPackagePath(resource, catalogFile.filePath)
  const mcpFile = path.join(sourcePackagePath, 'mcp.json')
  if (!(await pathExists(mcpFile))) {
    throw new MarketplaceServiceError('BAD_REQUEST', `MCP package ${resource.id} must contain mcp.json`)
  }
  const rawText = (await fs.readFile(mcpFile, 'utf-8')).replace(/^\uFEFF/, '')
  return parseMarketplaceMcpPackage(resource, rawText, targetPackagePath)
}

export async function getMarketplaceInstallPreview(id: string): Promise<MarketplaceInstallPreview> {
  const { resource, catalog, catalogFile } = await getCatalogResourceById(id)
  const state = await getMarketplaceInstalled()
  const previous = state.installed[id]
  const targetPackagePath = getInstalledPackagePath(resource)
  const publicKeys = getMarketplacePublicKeysForTrust(catalog.trust)
  const writes = [
    path.relative(path.dirname(getMarketplaceInstalledFile()), targetPackagePath),
    'installed.json',
  ]

  const mcpServers = await getMcpPreviewServers(resource, catalogFile, targetPackagePath, publicKeys)
  if (resource.type === 'mcp') {
    writes.push('mcp.json')
  }

  return {
    resource,
    operation: previous ? 'update' : 'install',
    targetPackagePath,
    writes,
    permissions: resource.permissions ?? [],
    verification: {
      sha256: resource.sha256 ? 'present' : 'missing',
      signature: resource.signature ? 'present' : 'missing',
    },
    mcpServers: mcpServers ? summarizeMcpServers(mcpServers) : undefined,
  }
}

async function findCatalogFile(): Promise<{ source: 'local' | 'cache' | 'bundled'; filePath: string } | null> {
  const local = getMarketplaceLocalCatalogFile()
  if (await pathExists(local)) return { source: 'local', filePath: local }

  const cache = getMarketplaceCatalogCacheFile()
  if (await pathExists(cache)) return { source: 'cache', filePath: cache }

  const bundled = getBundledMarketplaceLocalCatalogFile()
  if (await pathExists(bundled)) return { source: 'bundled', filePath: bundled }

  return null
}

export async function getMarketplaceCatalog(): Promise<MarketplaceCatalog> {
  const catalogFile = await findCatalogFile()
  if (!catalogFile) return { ...EMPTY_CATALOG, resources: [] }

  const raw = await readJsonFile(catalogFile.filePath)
  if (raw === null) return { ...EMPTY_CATALOG, resources: [] }
  return normalizeCatalog(raw, catalogFile.source)
}

export async function writeMarketplaceCatalogCache(catalog: MarketplaceCatalog): Promise<void> {
  await writeJsonFile(getMarketplaceCatalogCacheFile(), {
    ...catalog,
    schemaVersion: 1,
    source: 'cache',
  })
}

export async function getMarketplaceInstalled(): Promise<MarketplaceInstalledState> {
  const raw = await readJsonFile(getMarketplaceInstalledFile())
  if (raw === null) return { ...EMPTY_INSTALLED, installed: {} }
  return normalizeInstalled(raw)
}

async function saveMarketplaceInstalled(state: MarketplaceInstalledState): Promise<void> {
  await writeJsonFile(getMarketplaceInstalledFile(), {
    ...state,
    schemaVersion: 1,
    installed: state.installed,
  })
}

async function removeOldMarketplacePackage(
  previous: InstalledMarketplaceResource | undefined,
  nextPackagePath: string,
): Promise<void> {
  if (!previous) return
  const previousPackagePath = resolveInstalledPackagePath(previous.packagePath)
  if (isSamePath(previousPackagePath, nextPackagePath)) return

  const packagesDir = getMarketplacePackagesDir()
  const relativePath = path.relative(packagesDir, previousPackagePath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return

  await fs.rm(previousPackagePath, { recursive: true, force: true })
}

export async function installMarketplaceResource(id: string): Promise<InstalledMarketplaceResource> {
  sanitizeResourceId(id)
  const catalogFile = await findCatalogFile()
  if (!catalogFile) {
    throw new MarketplaceServiceError('NOT_FOUND', 'Marketplace catalog is not available')
  }

  const catalog = normalizeCatalog(await readJsonFile(catalogFile.filePath), catalogFile.source)
  const publicKeys = getMarketplacePublicKeysForTrust(catalog.trust)
  const resource = catalog.resources.find((entry) => entry.id === id)
  if (!resource) {
    throw new MarketplaceServiceError('NOT_FOUND', `Marketplace resource not found: ${id}`)
  }

  const targetPackagePath = getInstalledPackagePath(resource)
  let requiresManifest = false

  if (resource.packageUrl) {
    const packageUrl = resolvePackageUrl(resource.packageUrl)
    if (packageUrl.pathname.toLowerCase().endsWith('.zip')) {
      await downloadPackageZip(resource.packageUrl, targetPackagePath, resource.sha256, resource.signature, publicKeys)
      requiresManifest = true
    } else {
      await downloadPackageDirectory(resource.packageUrl, targetPackagePath)
    }
  } else {
    const sourcePackagePath = resolveCatalogPackagePath(resource, catalogFile.filePath)
    await copyPackageDirectory(sourcePackagePath, targetPackagePath)
  }

  if (requiresManifest) {
    await assertPackageManifest(resource, targetPackagePath)
  }
  await assertSupportedLocalPackage(resource, targetPackagePath)

  const state = await getMarketplaceInstalled()
  const previous = state.installed[id]
  const mcpInstall = resource.type === 'mcp'
    ? await installMarketplaceMcpServers(resource, targetPackagePath, previous)
    : null
  const now = new Date().toISOString()
  const installed: InstalledMarketplaceResource = {
    ...(previous ?? {}),
    id,
    type: resource.type,
    name: resource.name,
    version: resource.version,
    enabled: previous?.enabled ?? true,
    origin: 'marketplace',
    packagePath: path.relative(path.dirname(getMarketplaceInstalledFile()), targetPackagePath),
    installedAt: previous?.installedAt ?? now,
    updatedAt: previous ? now : undefined,
    userModified: previous?.userModified ?? false,
    mcpServers: mcpInstall?.serverNames ?? previous?.mcpServers,
    mcpServerHashes: mcpInstall?.serverHashes ?? previous?.mcpServerHashes,
  }

  state.installed[id] = installed
  await saveMarketplaceInstalled(state)
  await removeOldMarketplacePackage(previous, targetPackagePath)
  return installed
}

export async function uninstallMarketplaceResource(id: string): Promise<void> {
  sanitizeResourceId(id)
  const state = await getMarketplaceInstalled()
  if (!state.installed[id]) {
    throw new MarketplaceServiceError('NOT_FOUND', `Marketplace resource is not installed: ${id}`)
  }

  await uninstallMarketplaceMcpServers(state.installed[id])
  delete state.installed[id]
  await saveMarketplaceInstalled(state)
}

export async function setMarketplaceResourceEnabled(
  id: string,
  enabled: boolean,
): Promise<InstalledMarketplaceResource> {
  sanitizeResourceId(id)
  const state = await getMarketplaceInstalled()
  const resource = state.installed[id]
  if (!resource) {
    throw new MarketplaceServiceError('NOT_FOUND', `Marketplace resource is not installed: ${id}`)
  }

  const next = {
    ...resource,
    enabled,
    updatedAt: new Date().toISOString(),
  }
  state.installed[id] = next
  await saveMarketplaceInstalled(state)
  return next
}

function resolveInstalledPackagePath(packagePathValue: string): string {
  return path.isAbsolute(packagePathValue)
    ? packagePathValue
    : path.resolve(path.dirname(getMarketplaceInstalledFile()), packagePathValue)
}

export async function getInstalledMarketplaceSkillLocations(): Promise<MarketplaceSkillPackageLocation[]> {
  const state = await getMarketplaceInstalled()
  const locations: MarketplaceSkillPackageLocation[] = []

  for (const resource of Object.values(state.installed)) {
    if (resource.type !== 'skill' || resource.enabled === false) continue

    const packageRoot = resolveInstalledPackagePath(resource.packagePath)
    const directSkillFile = path.join(packageRoot, 'SKILL.md')
    const nestedSkillDir = path.join(packageRoot, resource.name)
    const nestedSkillFile = path.join(nestedSkillDir, 'SKILL.md')

    if (await pathExists(directSkillFile)) {
      locations.push({
        packageId: resource.id,
        name: resource.name,
        version: resource.version,
        skillDir: packageRoot,
      })
      continue
    }

    if (await pathExists(nestedSkillFile)) {
      locations.push({
        packageId: resource.id,
        name: resource.name,
        version: resource.version,
        skillDir: nestedSkillDir,
      })
    }
  }

  return locations
}
