import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Buffer } from 'node:buffer'
import { getDataDir } from '../../utils/kimoPaths.js'
import { ApiError } from '../middleware/errorHandler.js'
import { readRecoverableJsonFile } from './recoverableJsonFile.js'
import { sessionService, type MessageEntry } from './sessionService.js'
import { sessionTaskService } from './sessionTaskService.js'

export type SecurityResourceKind =
  | 'asset_note'
  | 'scope_policy'
  | 'recon_result'
  | 'credential_note'
  | 'manual_note'
  | 'report_import'

export type SecurityResourceMeta = {
  id: string
  title: string
  kind: SecurityResourceKind
  tags: string[]
  summary: string
  projectIds: string[]
  sourceType?: SecurityResourceSourceType
  sourceRefs?: SecurityResourceSourceRef[]
  createdAt: number
  updatedAt: number
}

export type SecurityResource = {
  meta: SecurityResourceMeta
  content: string
  files: Array<{ name: string; path: string }>
}

export type SecurityResourceInput = {
  title: string
  kind?: SecurityResourceKind
  tags?: string[]
  summary?: string
  content?: string
  projectIds?: string[]
  sourceType?: SecurityResourceSourceType
  sourceRefs?: SecurityResourceSourceRef[]
}

export type SecurityResourceUploadFile = {
  name: string
  dataBase64: string
  mimeType?: string
  size?: number
}

export type SecurityResourceImportInput = {
  paths?: string[]
  files?: SecurityResourceUploadFile[]
  kind?: SecurityResourceKind
  tags?: string[]
  summary?: string
  projectIds?: string[]
}

export type SecurityResourceSourceType =
  | 'manual_text'
  | 'uploaded_file'
  | 'session_ref'
  | 'external_ref'

export type SecurityResourceSourceRef = {
  type: 'session' | 'file' | 'path' | 'url' | 'git' | 'manual'
  id?: string
  title?: string
  value?: string
}

export type SecurityResourceFromSessionInput = {
  sessionIds: string[]
  title?: string
  kind?: SecurityResourceKind
  tags?: string[]
  summary?: string
  projectIds?: string[]
}

export type ResourceReferencePermissionStatus =
  | 'not_required'
  | 'pending'
  | 'allowed'
  | 'denied'
  | 'failed'

export type ResourceExtractionStatus = 'idle' | 'queued' | 'running' | 'waiting_for_permission' | 'done' | 'failed'

export type ResourceExtractionRecord = {
  status: ResourceExtractionStatus
  phase?: string
  summary: string
  content: string
  items: Array<{ type: string; value: string; description?: string; source?: string }>
  warnings: string[]
  error?: string
  startedAt?: number
  updatedAt: number
  completedAt?: number | null
}

export type ResourceReferenceRecord = {
  id: string
  type: string
  value: string
  intent?: string
  permissionStatus: ResourceReferencePermissionStatus
  createdAt: number
  updatedAt: number
}

type ResourceIndex = {
  resources: SecurityResourceMeta[]
}

export type SecurityResourcePromptItem = {
  id: string
  title: string
  kind: SecurityResourceKind
  tags: string[]
  summary: string
  contentPreview: string
  files: string[]
  extractionStatus?: ResourceExtractionStatus
  extractionSummary?: string
  pendingReferenceCount?: number
}

const SECURITY_DIR = 'security'
const RESOURCES_DIR = 'resources'
const INDEX_FILE = 'index.json'
const EXTRACTION_FILE = 'extraction.json'
const REFERENCES_FILE = 'references.json'
const VALID_KINDS = new Set<SecurityResourceKind>([
  'asset_note',
  'scope_policy',
  'recon_result',
  'credential_note',
  'manual_note',
  'report_import',
])
const MAX_PROMPT_CONTENT_CHARS = 1600
const MAX_PROMPT_RESOURCES = 8
const MAX_TEXT_IMPORT_BYTES = 1_000_000
const MAX_IMPORT_FILES = 20
const MAX_UPLOAD_FILE_BYTES = 8_000_000
const MAX_SESSION_RESOURCE_MESSAGES = 80
const MAX_SESSION_RESOURCE_CHARS = 30_000
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
  '.csv',
  '.log',
  '.xml',
  '.html',
  '.htm',
  '.yaml',
  '.yml',
  '.ini',
  '.conf',
  '.config',
  '.nmap',
])

function resourcesRoot(): string {
  return path.join(getDataDir(), SECURITY_DIR, RESOURCES_DIR)
}

function resourceDir(resourceId: string): string {
  return path.join(resourcesRoot(), resourceId)
}

function isValidResourceId(resourceId: string): boolean {
  return /^res_[a-zA-Z0-9-]+$/.test(resourceId)
}

function normalizeKind(kind: unknown): SecurityResourceKind {
  return typeof kind === 'string' && VALID_KINDS.has(kind as SecurityResourceKind)
    ? kind as SecurityResourceKind
    : 'manual_note'
}

function normalizeSourceType(value: unknown): SecurityResourceSourceType {
  return typeof value === 'string' && ['manual_text', 'uploaded_file', 'session_ref', 'external_ref'].includes(value)
    ? value as SecurityResourceSourceType
    : 'manual_text'
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

function previewText(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_CONTENT_CHARS)
}

function normalizeSourceRefs(value: unknown): SecurityResourceSourceRef[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is SecurityResourceSourceRef => !!item && typeof item === 'object')
    .map((item) => ({
      type: ['session', 'file', 'path', 'url', 'git', 'manual'].includes((item as SecurityResourceSourceRef).type)
        ? (item as SecurityResourceSourceRef).type
        : 'manual',
      id: cleanText((item as SecurityResourceSourceRef).id, 160) || undefined,
      title: cleanText((item as SecurityResourceSourceRef).title, 200) || undefined,
      value: cleanText((item as SecurityResourceSourceRef).value, 1000) || undefined,
    }))
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return []
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') return [record.text]
      return []
    })
    .join('\n')
    .trim()
}

function roleLabel(type: MessageEntry['type']): string {
  if (type === 'user') return '用户'
  if (type === 'assistant') return '助手'
  if (type === 'system') return '系统'
  return type
}

function safeFileName(name: string): string {
  return path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || `file-${crypto.randomUUID().slice(0, 8)}`
}

function uniqueFileName(existing: Set<string>, name: string): string {
  const parsed = path.parse(safeFileName(name))
  let candidate = `${parsed.name}${parsed.ext}`
  let index = 2
  while (existing.has(candidate.toLowerCase())) {
    candidate = `${parsed.name}-${index}${parsed.ext}`
    index += 1
  }
  existing.add(candidate.toLowerCase())
  return candidate
}

function isTextImportPath(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function isTextUpload(file: SecurityResourceUploadFile): boolean {
  const mime = file.mimeType?.toLowerCase() ?? ''
  return mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || isTextImportPath(file.name)
}

function decodeUploadFile(file: SecurityResourceUploadFile): Buffer {
  if (typeof file.dataBase64 !== 'string' || !file.dataBase64.trim()) {
    throw ApiError.badRequest(`file data is required: ${file.name}`)
  }
  const base64 = file.dataBase64.includes(',') ? file.dataBase64.split(',').pop() ?? '' : file.dataBase64
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) {
    throw ApiError.badRequest(`empty file data: ${file.name}`)
  }
  if (buffer.length > MAX_UPLOAD_FILE_BYTES || (typeof file.size === 'number' && file.size > MAX_UPLOAD_FILE_BYTES)) {
    throw ApiError.badRequest(`file too large: ${file.name}`)
  }
  return buffer
}

export class SecurityResourceService {
  async listResources(): Promise<SecurityResourceMeta[]> {
    const index = await this.readIndex()
    return [...index.resources].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async getResource(resourceId: string): Promise<SecurityResource | null> {
    this.assertResourceId(resourceId)
    const dir = resourceDir(resourceId)
    try {
      await fs.stat(dir)
    } catch {
      return null
    }
    const [meta, content, files] = await Promise.all([
      this.readJson<SecurityResourceMeta>(dir, 'meta.json'),
      fs.readFile(path.join(dir, 'content.md'), 'utf-8').catch(() => ''),
      this.listFiles(resourceId),
    ])
    if (!meta) return null
    return { meta: this.normalizeMeta(meta), content, files }
  }

  async getResourceExtraction(resourceId: string): Promise<ResourceExtractionRecord | null> {
    this.assertResourceId(resourceId)
    return this.readJson<ResourceExtractionRecord>(resourceDir(resourceId), EXTRACTION_FILE)
  }

  async getResourceReferences(resourceId: string): Promise<ResourceReferenceRecord[]> {
    this.assertResourceId(resourceId)
    const result = await this.readJson<{ references?: ResourceReferenceRecord[] }>(resourceDir(resourceId), REFERENCES_FILE)
    return Array.isArray(result?.references) ? result.references : []
  }

  async createResource(input: SecurityResourceInput): Promise<SecurityResource> {
    const title = cleanText(input.title, 120)
    if (!title) throw ApiError.badRequest('title is required')
    const now = Date.now()
    const id = `res_${crypto.randomUUID()}`
    const dir = resourceDir(id)
    const meta: SecurityResourceMeta = {
      id,
      title,
      kind: normalizeKind(input.kind),
      tags: normalizeStringArray(input.tags),
      summary: cleanText(input.summary, 500),
      projectIds: normalizeStringArray(input.projectIds),
      sourceType: normalizeSourceType(input.sourceType),
      sourceRefs: normalizeSourceRefs(input.sourceRefs),
      createdAt: now,
      updatedAt: now,
    }
    const content = typeof input.content === 'string' ? input.content : ''

    await fs.mkdir(path.join(dir, 'files'), { recursive: true })
    await Promise.all([
      this.writeJson(dir, 'meta.json', meta),
      fs.writeFile(path.join(dir, 'content.md'), content, 'utf-8'),
    ])
    const index = await this.readIndex()
    await this.writeIndex({ resources: [meta, ...index.resources.filter((item) => item.id !== id)] })
    return { meta, content, files: [] }
  }

  async updateResource(resourceId: string, input: Partial<SecurityResourceInput>): Promise<SecurityResource> {
    const current = await this.getResource(resourceId)
    if (!current) throw ApiError.notFound('Resource not found')

    const nextMeta: SecurityResourceMeta = {
      ...current.meta,
      ...(typeof input.title === 'string' ? { title: cleanText(input.title, 120) } : {}),
      ...(input.kind !== undefined ? { kind: normalizeKind(input.kind) } : {}),
      ...(input.tags !== undefined ? { tags: normalizeStringArray(input.tags) } : {}),
      ...(input.summary !== undefined ? { summary: cleanText(input.summary, 500) } : {}),
      ...(input.projectIds !== undefined ? { projectIds: normalizeStringArray(input.projectIds) } : {}),
      updatedAt: Date.now(),
    }
    if (!nextMeta.title) throw ApiError.badRequest('title is required')
    const nextContent = typeof input.content === 'string' ? input.content : current.content

    const dir = resourceDir(resourceId)
    await Promise.all([
      this.writeJson(dir, 'meta.json', nextMeta),
      fs.writeFile(path.join(dir, 'content.md'), nextContent, 'utf-8'),
    ])
    const index = await this.readIndex()
    await this.writeIndex({
      resources: index.resources.map((item) => item.id === resourceId ? nextMeta : item),
    })
    return { meta: nextMeta, content: nextContent, files: current.files }
  }

  async deleteResource(resourceId: string): Promise<void> {
    this.assertResourceId(resourceId)
    await fs.rm(resourceDir(resourceId), { recursive: true, force: true })
    const index = await this.readIndex()
    await this.writeIndex({ resources: index.resources.filter((item) => item.id !== resourceId) })
  }

  async importFiles(input: SecurityResourceImportInput): Promise<SecurityResource> {
    const paths = Array.isArray(input.paths)
      ? input.paths.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : []
    const files = Array.isArray(input.files)
      ? input.files
          .filter((item): item is SecurityResourceUploadFile => (
            item !== null
            && typeof item === 'object'
            && typeof item.name === 'string'
            && typeof item.dataBase64 === 'string'
          ))
          .map((item) => ({
            name: safeFileName(item.name),
            dataBase64: item.dataBase64,
            mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
            size: typeof item.size === 'number' ? item.size : undefined,
          }))
      : []
    const totalFiles = paths.length + files.length
    if (totalFiles === 0) throw ApiError.badRequest('paths or files is required')
    if (totalFiles > MAX_IMPORT_FILES) throw ApiError.badRequest(`too many files, max ${MAX_IMPORT_FILES}`)

    const firstName = paths[0] ? safeFileName(paths[0]) : safeFileName(files[0]?.name ?? 'uploaded-resource')
    const created = await this.createResource({
      title: firstName,
      kind: input.kind ?? 'report_import',
      tags: input.tags ?? ['import'],
      summary: input.summary ?? `从 ${totalFiles} 个文件导入。`,
      content: '',
      projectIds: input.projectIds,
      sourceType: Array.isArray(input.files) && input.files.length > 0 ? 'uploaded_file' : 'external_ref',
      sourceRefs: [
        ...paths.map((item) => ({ type: 'path' as const, value: item })),
        ...files.map((item) => ({ type: 'file' as const, title: item.name })),
      ],
    })

    const dir = resourceDir(created.meta.id)
    const filesDir = path.join(dir, 'files')
    await fs.mkdir(filesDir, { recursive: true })

    const usedNames = new Set<string>()
    const textParts: string[] = []
    const storedNames: string[] = []
    for (const sourcePath of paths) {
      let stat: Awaited<ReturnType<typeof fs.stat>>
      try {
        stat = await fs.stat(sourcePath)
      } catch {
        throw ApiError.badRequest(`file not found: ${sourcePath}`)
      }
      if (!stat.isFile()) throw ApiError.badRequest(`not a file: ${sourcePath}`)

      const storedName = uniqueFileName(usedNames, sourcePath)
      const destination = path.join(filesDir, storedName)
      await fs.copyFile(sourcePath, destination)
      storedNames.push(storedName)

      if (isTextImportPath(sourcePath) && stat.size <= MAX_TEXT_IMPORT_BYTES) {
        const text = await fs.readFile(sourcePath, 'utf-8').catch(() => '')
        if (text.trim()) {
          textParts.push(`## ${storedName}\n\n${text.trim()}`)
        }
      }
    }

    for (const file of files) {
      const bytes = decodeUploadFile(file)
      const storedName = uniqueFileName(usedNames, file.name)
      const destination = path.join(filesDir, storedName)
      await fs.writeFile(destination, bytes)
      storedNames.push(storedName)

      if (isTextUpload(file) && bytes.length <= MAX_TEXT_IMPORT_BYTES) {
        const text = bytes.toString('utf-8')
        if (text.trim()) {
          textParts.push(`## ${storedName}\n\n${text.trim()}`)
        }
      }
    }

    const content = textParts.length > 0
      ? textParts.join('\n\n---\n\n')
      : [
          '已导入文件，当前未自动提取正文。',
          '',
          ...storedNames.map((name) => `- ${name}`),
        ].join('\n')

    const summary = input.summary
      ?? (textParts.length > 0
        ? `从 ${storedNames.length} 个文件导入，并提取了可读文本。`
        : `从 ${storedNames.length} 个文件导入，作为附件保存。`)

    return this.updateResource(created.meta.id, {
      summary,
      content,
    })
  }

  async createResourceFromSessions(input: SecurityResourceFromSessionInput): Promise<SecurityResource> {
    const sessionIds = [...new Set(
      (Array.isArray(input.sessionIds) ? input.sessionIds : [])
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    )]
    if (sessionIds.length === 0) throw ApiError.badRequest('sessionIds is required')
    if (sessionIds.length > 10) throw ApiError.badRequest('too many sessions, max 10')

    const sections: string[] = []
    const sourceRefs: SecurityResourceSourceRef[] = []
    for (const sessionId of sessionIds) {
      const detail = await sessionService.getSession(sessionId)
      if (!detail) throw ApiError.badRequest(`session not found: ${sessionId}`)
      sourceRefs.push({ type: 'session', id: sessionId, title: detail.title })
      const messages = detail.messages
        .filter((message) => message.type === 'user' || message.type === 'assistant' || message.type === 'system')
        .slice(-MAX_SESSION_RESOURCE_MESSAGES)
      const lines = [
        `## ${detail.title}`,
        '',
        `sessionId: ${sessionId}`,
        detail.workDir ? `workDir: ${detail.workDir}` : '',
        '',
      ].filter(Boolean)
      for (const message of messages) {
        const text = extractMessageText(message.content)
        if (!text) continue
        lines.push(`### ${roleLabel(message.type)} ${message.timestamp}`)
        lines.push('')
        lines.push(text.slice(0, 4000))
        lines.push('')
      }
      sections.push(lines.join('\n').trim())
    }

    const taskRecords = await Promise.all(sessionIds.map((sessionId) => (
      sessionTaskService.createTask({
        sessionId,
        type: 'resource_from_session',
        title: '从会话提取前置资源',
        status: 'running',
        sourceRefs: [{ type: 'session', id: sessionId }],
        events: [{
          timestamp: new Date().toISOString(),
          level: 'info',
          phase: 'collecting',
          message: '正在读取会话记录并生成可复用资源',
        }],
      }).catch(() => null)
    )))

    const fallbackTitle = sessionIds.length === 1
      ? `会话提取 - ${sourceRefs[0]?.title ?? sessionIds[0]}`
      : `会话提取 - ${sessionIds.length} 个会话`
    const content = sections.join('\n\n---\n\n').slice(0, MAX_SESSION_RESOURCE_CHARS)
    const summary = input.summary
      ?? (sessionIds.length === 1
        ? `从会话 ${sourceRefs[0]?.title ?? sessionIds[0]} 提取的上下文资源`
        : `从 ${sessionIds.length} 个会话提取的上下文资源`)

    const resource = await this.createResource({
      title: input.title ?? fallbackTitle,
      kind: input.kind ?? 'recon_result',
      tags: input.tags ?? ['session'],
      summary,
      content,
      projectIds: input.projectIds,
      sourceType: 'session_ref',
      sourceRefs,
    })
    await Promise.all(taskRecords.map((task) => task
      ? sessionTaskService.updateTask(task.sessionId, task.id, {
          status: 'running',
          targetRefs: [{ type: 'resource', id: resource.meta.id, title: resource.meta.title }],
          events: [
            ...task.events,
            {
              timestamp: new Date().toISOString(),
              level: 'info',
              phase: 'extracting',
              message: '原始材料已保存，正在由 Agent 整理为可复用前置资源',
            },
          ],
        }).catch(() => undefined)
      : undefined,
    ))
    return resource
  }

  async syncSessionResourceExtractionTask(
    resourceId: string,
    extraction: ResourceExtractionRecord | null,
    error?: unknown,
  ): Promise<void> {
    const resource = await this.getResource(resourceId)
    if (!resource || resource.meta.sourceType !== 'session_ref') return

    const failedMessage = error instanceof Error ? error.message : String(error ?? '')
    const taskStatus = failedMessage || extraction?.status === 'failed'
      ? 'failed'
      : extraction?.status === 'waiting_for_permission'
        ? 'waiting_for_permission'
        : extraction?.status === 'done'
          ? 'done'
          : 'running'
    const phase = failedMessage ? 'failed' : extraction?.phase || extraction?.status || 'extracting'
    const usedFallback = extraction?.warnings.includes('未能调用可用模型，当前显示基础整理结果') ?? false
    const message = taskStatus === 'done'
      ? usedFallback
        ? '已生成基础整理结果；当前未调用可用模型'
        : 'Agent 已完成前置资源整理'
      : taskStatus === 'waiting_for_permission'
        ? 'Agent 已发现需要用户授权读取的引用'
        : taskStatus === 'failed'
          ? `前置资源整理失败${failedMessage ? `：${failedMessage.slice(0, 300)}` : ''}`
          : 'Agent 正在整理前置资源'
    const sessionIds = resource.meta.sourceRefs
      ?.filter((ref) => ref.type === 'session' && ref.id)
      .map((ref) => ref.id!) ?? []

    await Promise.all(sessionIds.map(async (sessionId) => {
      const tasks = await sessionTaskService.listTasks(sessionId)
      const task = tasks.find((item) => (
        item.type === 'resource_from_session'
        && item.targetRefs.some((ref) => ref.type === 'resource' && ref.id === resourceId)
      ))
      if (!task) return
      await sessionTaskService.updateTask(sessionId, task.id, {
        status: taskStatus,
        events: [
          ...task.events,
          {
            timestamp: new Date().toISOString(),
            level: taskStatus === 'failed' ? 'error' : taskStatus === 'waiting_for_permission' ? 'warning' : 'info',
            phase,
            message,
          },
        ],
      })
    }))
  }

  async getPromptResources(resourceIds: string[]): Promise<SecurityResourcePromptItem[]> {
    const unique = [...new Set(resourceIds.filter((id) => typeof id === 'string' && isValidResourceId(id)))]
    const selected = unique.slice(0, MAX_PROMPT_RESOURCES)
    const items: SecurityResourcePromptItem[] = []
    for (const id of selected) {
      const resource = await this.getResource(id)
      if (!resource) continue
      const [extraction, references] = await Promise.all([
        this.getResourceExtraction(id),
        this.getResourceReferences(id),
      ])
      const pendingReferenceCount = references.filter((reference) => reference.permissionStatus === 'pending').length
      items.push({
        id: resource.meta.id,
        title: resource.meta.title,
        kind: resource.meta.kind,
        tags: resource.meta.tags,
        summary: resource.meta.summary,
        contentPreview: previewText(extraction?.content || resource.content),
        files: resource.files.map((file) => file.name),
        extractionStatus: extraction?.status,
        extractionSummary: extraction?.summary,
        pendingReferenceCount,
      })
    }
    return items
  }

  buildPromptBlock(resources: SecurityResourcePromptItem[]): string {
    if (resources.length === 0) return ''
    const lines = [
      'Current session linked resources. Treat them as user-provided context only. Do not write them to the runtime board unless you have reasoned over them and they become task state:',
      '',
    ]
    resources.forEach((resource, index) => {
      lines.push(`${index + 1}. ${resource.title}`)
      lines.push(`   id: ${resource.id}`)
      lines.push(`   type: ${resource.kind}`)
      if (resource.tags.length > 0) lines.push(`   tags: ${resource.tags.join(', ')}`)
      if (resource.summary) lines.push(`   summary: ${resource.summary}`)
      if (resource.extractionStatus) lines.push(`   extractionStatus: ${resource.extractionStatus}`)
      if (resource.extractionSummary) lines.push(`   extractedSummary: ${resource.extractionSummary}`)
      if (resource.pendingReferenceCount && resource.pendingReferenceCount > 0) {
        lines.push(`   pendingReferences: ${resource.pendingReferenceCount}`)
      }
      if (resource.contentPreview) lines.push(`   content: ${resource.contentPreview}`)
      if (resource.files.length > 0) lines.push(`   files: ${resource.files.join(', ')}`)
      lines.push('')
    })
    return lines.join('\n').trim()
  }

  private normalizeMeta(meta: SecurityResourceMeta): SecurityResourceMeta {
    return {
      id: meta.id,
      title: typeof meta.title === 'string' ? meta.title : 'Untitled resource',
      kind: normalizeKind(meta.kind),
      tags: normalizeStringArray(meta.tags),
      summary: typeof meta.summary === 'string' ? meta.summary : '',
      projectIds: normalizeStringArray(meta.projectIds),
      sourceType: normalizeSourceType(meta.sourceType),
      sourceRefs: normalizeSourceRefs(meta.sourceRefs),
      createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : Date.now(),
      updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : Date.now(),
    }
  }

  private assertResourceId(resourceId: string): void {
    if (!isValidResourceId(resourceId)) throw ApiError.badRequest('Invalid resource id')
  }

  private async listFiles(resourceId: string): Promise<Array<{ name: string; path: string }>> {
    const filesDir = path.join(resourceDir(resourceId), 'files')
    try {
      const entries = await fs.readdir(filesDir, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => ({ name: entry.name, path: path.join(filesDir, entry.name) }))
    } catch {
      return []
    }
  }

  private async readIndex(): Promise<ResourceIndex> {
    const root = resourcesRoot()
    await fs.mkdir(root, { recursive: true })
    const result = await readRecoverableJsonFile<ResourceIndex>({
      filePath: path.join(root, INDEX_FILE),
      defaultValue: { resources: [] },
      normalize: (value): ResourceIndex | null => {
        if (typeof value !== 'object' || value === null || !Array.isArray((value as ResourceIndex).resources)) {
          return null
        }
        return value as ResourceIndex
      },
      label: 'security resources index',
    })
    return { resources: result.resources.map((item) => this.normalizeMeta(item)) }
  }

  private async writeIndex(index: ResourceIndex): Promise<void> {
    const root = resourcesRoot()
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, INDEX_FILE), JSON.stringify(index, null, 2), 'utf-8')
  }

  private async readJson<T>(dir: string, file: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf-8')
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  private async writeJson(dir: string, file: string, data: unknown): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, file), JSON.stringify(data, null, 2), 'utf-8')
  }
}

export const securityResourceService = new SecurityResourceService()
