import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createZipFromDirectory } from '../src/utils/plugins/zipCache.js'
import { canonicalizeSignedJson, signResourceData } from '../src/services/resourceSignature.js'

type ResourceType = 'skill' | 'mcp' | 'tool' | 'agent'

type SourceResource = {
  id: string
  type: ResourceType
  name: string
  version: string
  category?: string
  description?: string
  packagePath?: string
  minMikoVersion?: string
  permissions?: string[]
  publisher?: string
  sourceRepository?: string
  sourceCommit?: string
  license?: string
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  requiresExplicitAuthorization?: boolean
}

type SourceCatalog = {
  schemaVersion: 1
  generatedAt?: string
  resources: SourceResource[]
}

type PublishedResource = Omit<SourceResource, 'packagePath'> & {
  packageUrl: string
  sha256: string
  signature: string
  publishedAt: string
  reviewStatus: 'approved'
}

type PublishedCatalog = {
  schemaVersion: 1
  generatedAt: string
  source: 'signed-local-marketplace'
  resources: PublishedResource[]
  signature?: string
}

type Options = {
  source: string
  out: string
  baseUrl: string
  privateKeyFile?: string
}

function usage(): never {
  throw new Error([
    'Usage:',
    '  bun run scripts/sign-marketplace-catalog.ts --private-key-file <key.pem> [--source data/marketplace] [--out ../miko/runtime/resource-marketplace/signed] [--base-url http://127.0.0.1:8788]',
    '',
    'Environment alternative:',
    '  KIMO_RESOURCE_SIGNATURE_PRIVATE_KEY=<pem-or-base64-pkcs8> bun run scripts/sign-marketplace-catalog.ts',
  ].join('\n'))
}

function readOptions(argv: string[]): Options {
  const options: Options = {
    source: 'data/marketplace',
    out: '../miko/runtime/resource-marketplace/signed',
    baseUrl: 'http://127.0.0.1:8788',
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--source' && next) {
      options.source = next
      index++
      continue
    }
    if (arg === '--out' && next) {
      options.out = next
      index++
      continue
    }
    if (arg === '--base-url' && next) {
      options.baseUrl = next
      index++
      continue
    }
    if (arg === '--private-key-file' && next) {
      options.privateKeyFile = next
      index++
      continue
    }
    if (arg === '--help' || arg === '-h') usage()
    throw new Error(`Unknown or incomplete argument: ${arg}`)
  }

  return {
    ...options,
    source: resolve(options.source),
    out: resolve(options.out),
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    privateKeyFile: options.privateKeyFile ? resolve(options.privateKeyFile) : undefined,
  }
}

function hashSha256(data: Uint8Array) {
  return createHash('sha256').update(data).digest('hex')
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function assertResourceType(value: unknown): ResourceType {
  if (value === 'skill' || value === 'mcp' || value === 'tool' || value === 'agent') return value
  throw new Error(`Unsupported resource type: ${String(value)}`)
}

function sanitizePathSegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return value
}

function normalizeSourceResource(value: unknown): SourceResource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Catalog resource must be an object')
  }
  const record = value as Record<string, unknown>
  const id = sanitizePathSegment(assertString(record.id, 'resource id'), 'resource id')
  const version = sanitizePathSegment(assertString(record.version, 'resource version'), 'resource version')
  const permissions = Array.isArray(record.permissions)
    ? record.permissions.filter((entry): entry is string => typeof entry === 'string')
    : undefined

  return {
    id,
    type: assertResourceType(record.type),
    name: assertString(record.name, 'resource name'),
    version,
    category: typeof record.category === 'string' ? record.category : undefined,
    description: typeof record.description === 'string' ? record.description : undefined,
    packagePath: typeof record.packagePath === 'string' ? record.packagePath : undefined,
    minMikoVersion: typeof record.minMikoVersion === 'string' ? record.minMikoVersion : undefined,
    permissions,
    publisher: typeof record.publisher === 'string' ? record.publisher : undefined,
    sourceRepository: typeof record.sourceRepository === 'string' ? record.sourceRepository : undefined,
    sourceCommit: typeof record.sourceCommit === 'string' ? record.sourceCommit : undefined,
    license: typeof record.license === 'string' ? record.license : undefined,
    riskLevel: record.riskLevel === 'low' || record.riskLevel === 'medium' || record.riskLevel === 'high' || record.riskLevel === 'critical'
      ? record.riskLevel
      : undefined,
    requiresExplicitAuthorization: record.requiresExplicitAuthorization === true,
  }
}

async function readSourceCatalog(sourceRoot: string): Promise<SourceCatalog> {
  const raw = JSON.parse(await readFile(join(sourceRoot, 'catalog.local.json'), 'utf-8')) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('catalog.local.json must be an object')
  }
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.resources)) {
    throw new Error('catalog.local.json resources must be an array')
  }
  return {
    schemaVersion: 1,
    generatedAt: typeof record.generatedAt === 'string' ? record.generatedAt : undefined,
    resources: record.resources.map(normalizeSourceResource),
  }
}

async function configurePrivateKey(privateKeyFile?: string) {
  if (privateKeyFile) {
    process.env.KIMO_RESOURCE_SIGNATURE_PRIVATE_KEY = await readFile(privateKeyFile, 'utf-8')
  }
  if (!process.env.KIMO_RESOURCE_SIGNATURE_PRIVATE_KEY?.trim() && !process.env.MIKO_RESOURCE_SIGNATURE_PRIVATE_KEY?.trim()) {
    throw new Error('A signing private key is required. Use --private-key-file or KIMO_RESOURCE_SIGNATURE_PRIVATE_KEY.')
  }
}

function signOrThrow(data: Uint8Array, label: string): string {
  const signature = signResourceData(data)
  if (!signature) throw new Error(`Failed to sign ${label}`)
  return signature
}

async function writePublishedPackage(
  sourceRoot: string,
  outputRoot: string,
  baseUrl: string,
  resource: SourceResource,
  publishedAt: string,
): Promise<PublishedResource | null> {
  if (!resource.packagePath) return null
  const packageSource = resolve(sourceRoot, resource.packagePath)
  if (!existsSync(packageSource)) {
    throw new Error(`Package path does not exist for ${resource.id}: ${packageSource}`)
  }

  const zipData = await createZipFromDirectory(packageSource)
  const packageDir = join(outputRoot, 'packages', resource.id, resource.version)
  const packageFile = join(packageDir, 'package.zip')
  await mkdir(packageDir, { recursive: true })
  await writeFile(packageFile, zipData)

  return {
    id: resource.id,
    type: resource.type,
    name: resource.name,
    version: resource.version,
    category: resource.category,
    description: resource.description,
    packageUrl: `${baseUrl}/packages/${encodeURIComponent(resource.id)}/${encodeURIComponent(resource.version)}/package.zip`,
    sha256: hashSha256(zipData),
    signature: signOrThrow(zipData, `package ${resource.id}@${resource.version}`),
    minMikoVersion: resource.minMikoVersion,
    permissions: resource.permissions,
    publisher: resource.publisher,
    sourceRepository: resource.sourceRepository,
    sourceCommit: resource.sourceCommit,
    license: resource.license,
    riskLevel: resource.riskLevel,
    requiresExplicitAuthorization: resource.requiresExplicitAuthorization,
    publishedAt,
    reviewStatus: 'approved',
  }
}

export async function signMarketplaceCatalog(options: Options): Promise<PublishedCatalog> {
  await configurePrivateKey(options.privateKeyFile)
  const catalog = await readSourceCatalog(options.source)
  const publishedAt = new Date().toISOString()

  await rm(options.out, { recursive: true, force: true })
  await mkdir(options.out, { recursive: true })

  const resources: PublishedResource[] = []
  for (const resource of catalog.resources) {
    const published = await writePublishedPackage(options.source, options.out, options.baseUrl, resource, publishedAt)
    if (published) resources.push(published)
  }

  const publishedCatalog: PublishedCatalog = {
    schemaVersion: 1,
    generatedAt: publishedAt,
    source: 'signed-local-marketplace',
    resources,
  }
  publishedCatalog.signature = signOrThrow(
    new TextEncoder().encode(canonicalizeSignedJson(publishedCatalog)),
    'catalog.json',
  )
  await writeFile(join(options.out, 'catalog.json'), `${JSON.stringify(publishedCatalog, null, 2)}\n`, 'utf-8')
  await writeFile(
    join(options.out, 'README.md'),
    [
      '# Signed Miko Marketplace',
      '',
      `Generated at: ${publishedAt}`,
      `Resources: ${resources.length}`,
      '',
      'Serve this directory from the configured base URL. The client verifies catalog and package signatures before caching/installing remote resources.',
      '',
    ].join('\n'),
    'utf-8',
  )
  return publishedCatalog
}

if (import.meta.main) {
  try {
    const result = await signMarketplaceCatalog(readOptions(process.argv.slice(2)))
    console.log(`[marketplace:sign] wrote ${result.resources.length} resources`)
    console.log(`[marketplace:sign] catalog signature = ${result.signature ? 'present' : 'missing'}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
