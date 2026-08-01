import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { getDataDir } from '../../utils/kimoPaths.js'
import { ApiError } from '../middleware/errorHandler.js'
import { readRecoverableJsonFile } from './recoverableJsonFile.js'
import { securityResourceService } from './securityResourceService.js'
import { ProviderService } from './providerService.js'

export type ResourceReferenceType =
  | 'local_file'
  | 'local_directory'
  | 'url'
  | 'git_repo'
  | 'domain'
  | 'ip'
  | 'note'

export type ResourceReferencePermissionStatus =
  | 'not_required'
  | 'pending'
  | 'allowed'
  | 'denied'
  | 'failed'

export type ResourceReadMode =
  | 'file'
  | 'list_only'
  | 'list_and_selected_files'
  | 'fetch_url'
  | 'clone_shallow'

export type ResourceReadPolicy = {
  mode: ResourceReadMode
  maxDepth?: number
  maxFiles?: number
  maxBytesPerFile?: number
}

export type ResourceReference = {
  id: string
  type: ResourceReferenceType
  value: string
  intent?: 'asset_source' | 'scope_policy' | 'reference_doc' | 'credential_note' | 'unknown'
  permissionStatus: ResourceReferencePermissionStatus
  readPolicy?: ResourceReadPolicy
  sourceText?: string
  createdAt: number
  updatedAt: number
  lastReadAt?: number
  lastReadSummary?: string
  lastError?: string
}

export type ResourceExtractionStatus = 'idle' | 'queued' | 'running' | 'waiting_for_permission' | 'done' | 'failed'

export type ResourceExtractionItem = {
  type: string
  value: string
  description?: string
  source?: string
}

export type ResourceExtractionRecord = {
  status: ResourceExtractionStatus
  phase?: string
  summary: string
  content: string
  items: ResourceExtractionItem[]
  warnings: string[]
  error?: string
  startedAt?: number
  updatedAt: number
  completedAt?: number | null
}

type ResourceReferenceIndex = {
  references: ResourceReference[]
}

type ExtractionPromptInput = {
  title: string
  kind: string
  summary: string
  content: string
  files: Array<{ name: string; preview: string }>
  references: ResourceReference[]
  readableReferences: Array<{ id: string; type: ResourceReferenceType; value: string; summary: string; content: string }>
}

const SECURITY_DIR = 'security'
const RESOURCES_DIR = 'resources'
const REFERENCES_FILE = 'references.json'
const EXTRACTION_FILE = 'extraction.json'
const EXTRACTION_MD_FILE = 'extraction.md'
const EXTRACTION_LOG_FILE = 'extraction-log.jsonl'
const MAX_REFERENCE_TEXT = 2_000
const MAX_FILE_PREVIEW_BYTES = 250_000
const MAX_LLM_INPUT_CHARS = 18_000
const MAX_LLM_OUTPUT_TOKENS = 4_000
const MAX_URL_BYTES = 1_000_000
const MAX_LOCAL_FILE_BYTES = 1_000_000
const MAX_DIR_FILES = 30
const MAX_DIR_DEPTH = 2
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

function referencesPath(resourceId: string): string {
  return path.join(resourceDir(resourceId), REFERENCES_FILE)
}

function extractionPath(resourceId: string): string {
  return path.join(resourceDir(resourceId), EXTRACTION_FILE)
}

function extractionMarkdownPath(resourceId: string): string {
  return path.join(resourceDir(resourceId), EXTRACTION_MD_FILE)
}

function extractionLogPath(resourceId: string): string {
  return path.join(resourceDir(resourceId), EXTRACTION_LOG_FILE)
}

function stableReferenceId(type: ResourceReferenceType, value: string): string {
  return `ref_${createHash('sha1').update(`${type}:${value.trim().toLowerCase()}`).digest('hex').slice(0, 16)}`
}

function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

function isTextFile(fileName: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase())
}

function normalizeReference(raw: ResourceReference): ResourceReference {
  return {
    id: raw.id,
    type: raw.type,
    value: raw.value.trim(),
    intent: raw.intent ?? 'unknown',
    permissionStatus: raw.permissionStatus,
    readPolicy: raw.readPolicy,
    sourceText: raw.sourceText ?? '',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    lastReadAt: typeof raw.lastReadAt === 'number' ? raw.lastReadAt : undefined,
    lastReadSummary: raw.lastReadSummary ?? undefined,
    lastError: raw.lastError ?? undefined,
  }
}

function uniqueTextPreview(text: string, maxChars = MAX_REFERENCE_TEXT): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

function guessIntent(type: ResourceReferenceType, sourceText: string, value: string): ResourceReference['intent'] {
  if (type === 'domain' || type === 'ip' || type === 'local_file' || type === 'local_directory') return 'asset_source'
  if (/scope|range|constraint|不要|禁止|不能/i.test(sourceText)) return 'scope_policy'
  if (/credential|account|账号|密码|token/i.test(sourceText)) return 'credential_note'
  if (/doc|文档|reference|参考/i.test(sourceText) || type === 'url' || type === 'git_repo') return 'reference_doc'
  if (/asset|资产/i.test(sourceText) || /asset/i.test(value)) return 'asset_source'
  return 'unknown'
}

function classifyPath(value: string): ResourceReferenceType {
  if (/^\\\\/.test(value)) return path.extname(value) ? 'local_file' : 'local_directory'
  if (/^[a-zA-Z]:\\/.test(value)) {
    const normalized = value.replace(/[\\\/]+$/g, '')
    return path.extname(normalized) ? 'local_file' : 'local_directory'
  }
  return 'note'
}

function normalizePolicyForReference(reference: ResourceReference): ResourceReadPolicy {
  if (reference.readPolicy) return reference.readPolicy
  switch (reference.type) {
    case 'local_file':
      return { mode: 'file', maxBytesPerFile: MAX_LOCAL_FILE_BYTES }
    case 'local_directory':
      return { mode: 'list_and_selected_files', maxDepth: MAX_DIR_DEPTH, maxFiles: MAX_DIR_FILES, maxBytesPerFile: MAX_LOCAL_FILE_BYTES }
    case 'url':
      return { mode: 'fetch_url', maxBytesPerFile: MAX_URL_BYTES }
    case 'git_repo':
      return { mode: 'clone_shallow', maxBytesPerFile: MAX_URL_BYTES }
    default:
      return { mode: 'list_only' }
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
}

function looksLikeBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  let suspicious = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1
  }
  return suspicious / Math.max(sample.length, 1) > 0.2
}

export class ResourceExtractionService {
  async getReferences(resourceId: string): Promise<ResourceReference[]> {
    const result = await this.readReferences(resourceId)
    return [...result.references].sort((a, b) => a.createdAt - b.createdAt)
  }

  async getExtraction(resourceId: string): Promise<ResourceExtractionRecord | null> {
    return this.readJson<ResourceExtractionRecord>(resourceId, EXTRACTION_FILE, {
      status: 'idle',
      phase: 'idle',
      summary: '',
      content: '',
      items: [],
      warnings: [],
      updatedAt: 0,
    })
  }

  async queueExtraction(resourceId: string): Promise<void> {
    const resource = await securityResourceService.getResource(resourceId)
    if (!resource) {
      throw ApiError.notFound('Resource not found')
    }
    const now = Date.now()
    await this.writeExtraction(resourceId, {
      status: 'queued',
      phase: 'queued',
      summary: '',
      content: '',
      items: [],
      warnings: [],
      startedAt: now,
      updatedAt: now,
      completedAt: null,
    })
  }

  async extract(resourceId: string, providerId?: string | null): Promise<ResourceExtractionRecord | null> {
    const resource = await securityResourceService.getResource(resourceId)
    if (!resource) {
      throw ApiError.notFound('Resource not found')
    }

    const startAt = Date.now()
    await this.writeExtraction(resourceId, {
      status: 'running',
      phase: 'extracting',
      summary: '',
      content: '',
      items: [],
      warnings: [],
      startedAt: startAt,
      updatedAt: startAt,
      completedAt: null,
    })

    const existing = await this.readReferences(resourceId)
    const detected = this.detectReferences(`${resource.meta.title}\n\n${resource.meta.summary}\n\n${resource.content}`)
    const merged = this.mergeReferences(existing.references, detected)
    await this.writeReferences(resourceId, merged)

    const readableReferences: ExtractionPromptInput['readableReferences'] = []
    const warnings: string[] = []
    for (const reference of merged) {
      const readResult = await this.tryReadReference(resourceId, reference)
      if (readResult.summary) {
        readableReferences.push({
          id: reference.id,
          type: reference.type,
          value: reference.value,
          summary: readResult.summary,
          content: readResult.content,
        })
      }
      if (readResult.warning) warnings.push(readResult.warning)
    }

    const waitingForPermission = merged.some((reference) => reference.permissionStatus === 'pending')
    const promptInput: ExtractionPromptInput = {
      title: resource.meta.title,
      kind: resource.meta.kind,
      summary: resource.meta.summary,
      content: resource.content,
      files: await this.collectFilePreviews(resource.files),
      references: merged,
      readableReferences,
    }

    let extraction = await this.callExtractor(promptInput, providerId)
    if (!extraction) {
      extraction = this.buildFallbackExtraction(promptInput, warnings)
    }

    extraction.startedAt = extraction.startedAt ?? startAt
    extraction.updatedAt = Date.now()
    extraction.completedAt = extraction.status === 'running' || extraction.status === 'queued'
      ? null
      : extraction.updatedAt
    if (waitingForPermission && extraction.status === 'done') {
      extraction.status = 'waiting_for_permission'
      extraction.phase = 'waiting_for_permission'
      extraction.completedAt = extraction.updatedAt
      extraction.warnings = [...new Set([...extraction.warnings, '存在待授权引用，部分内容尚未读取'])]
    }
    if (!extraction.phase) {
      extraction.phase = extraction.status
    }
    extraction.warnings = [...new Set([...extraction.warnings, ...warnings])]
    await this.writeExtraction(resourceId, extraction)
    await this.writeLog(resourceId, {
      timestamp: new Date().toISOString(),
      status: extraction.status,
      referenceCount: merged.length,
      readableReferenceCount: readableReferences.length,
    })
    return extraction
  }

  async updateReferencePermission(
    resourceId: string,
    referenceId: string,
    patch: Partial<Pick<ResourceReference, 'permissionStatus' | 'readPolicy'>>,
  ): Promise<ResourceReference> {
    const result = await this.readReferences(resourceId)
    const index = result.references.findIndex((reference) => reference.id === referenceId)
    if (index < 0) throw ApiError.notFound('Reference not found')
    const current = result.references[index]!
    const next: ResourceReference = normalizeReference({
      ...current,
      ...(patch.permissionStatus ? { permissionStatus: patch.permissionStatus } : {}),
      ...(patch.readPolicy ? { readPolicy: patch.readPolicy } : {}),
      updatedAt: Date.now(),
    })
    result.references[index] = next
    await this.writeReferences(resourceId, result.references)
    return next
  }

  async readReference(resourceId: string, referenceId: string): Promise<{ reference: ResourceReference; extraction: ResourceExtractionRecord | null }> {
    const result = await this.readReferences(resourceId)
    const reference = result.references.find((item) => item.id === referenceId)
    if (!reference) throw ApiError.notFound('Reference not found')
    if (reference.permissionStatus === 'denied') {
      throw ApiError.badRequest('Reference is denied')
    }
    const nextPermissionStatus = reference.permissionStatus === 'not_required' ? 'not_required' : 'allowed'
    const updated = await this.updateReferencePermission(resourceId, referenceId, {
      permissionStatus: nextPermissionStatus,
      readPolicy: reference.readPolicy ?? normalizePolicyForReference(reference),
    })
    const extraction = await this.extract(resourceId)
    return { reference: updated, extraction }
  }

  detectReferences(text: string): ResourceReference[] {
    const input = sanitizeText(text, 100_000)
    if (!input) return []

    const found = new Map<string, ResourceReference>()
    const add = (type: ResourceReferenceType, value: string, sourceText: string): void => {
      const normalized = value.trim()
      if (!normalized) return
      const id = stableReferenceId(type, normalized)
      if (found.has(id)) return
      const permissionStatus: ResourceReferencePermissionStatus =
        type === 'domain' || type === 'ip' || type === 'note' ? 'not_required' : 'pending'
      found.set(id, normalizeReference({
        id,
        type,
        value: normalized,
        intent: guessIntent(type, sourceText, normalized),
        permissionStatus,
        sourceText: uniqueTextPreview(sourceText, 600),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }))
    }

    const lines = input.split('\n')
    for (const line of lines) {
      const pathMatches = line.match(/(?:[A-Za-z]:\\|\\\\)(?:[^\s<>:"|?*，。,;；]+\\?)+/g) ?? []
      for (const raw of pathMatches) {
        const trimmed = raw.trim().replace(/[.,;，。]+$/, '')
        if (!trimmed) continue
        add(classifyPath(trimmed), trimmed, line)
      }

      const urlMatches = line.match(/https?:\/\/[^\s"'`<>()\]，。；、,;]+/gi) ?? []
      for (const raw of urlMatches) {
        const trimmed = raw.trim().replace(/[.,;，。]+$/, '')
        const type: ResourceReferenceType = /github\.com|gitlab\.com|bitbucket\.org/i.test(trimmed) ? 'git_repo' : 'url'
        add(type, trimmed, line)
      }

      const gitMatches = line.match(/git@[\w.-]+:[^\s"'`<>()\]]+\.git/gi) ?? []
      for (const raw of gitMatches) {
        add('git_repo', raw.trim().replace(/[.,;，。]+$/, ''), line)
      }

      const ipMatches = line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []
      for (const raw of ipMatches) {
        add('ip', raw.trim(), line)
      }

      const domainMatches = line.match(/\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}\b/g) ?? []
      for (const raw of domainMatches) {
        if (urlMatches.some((url) => url.includes(raw))) continue
        add('domain', raw.trim(), line)
      }
    }

    return [...found.values()]
  }

  private async collectFilePreviews(files: Array<{ name: string; path: string }>): Promise<Array<{ name: string; preview: string }>> {
    const previews: Array<{ name: string; preview: string }> = []
    for (const file of files.slice(0, 10)) {
      try {
        const stat = await fs.stat(file.path)
        if (!stat.isFile()) continue
        if (stat.size > MAX_FILE_PREVIEW_BYTES) {
          previews.push({ name: file.name, preview: `[file too large: ${stat.size} bytes]` })
          continue
        }
        const raw = await fs.readFile(file.path)
        if (looksLikeBinary(raw)) {
          previews.push({ name: file.name, preview: '[binary file]' })
          continue
        }
        const text = raw.toString('utf-8').trim()
        if (!text) continue
        previews.push({
          name: file.name,
          preview: isTextFile(file.name)
            ? uniqueTextPreview(text)
            : uniqueTextPreview(text),
        })
      } catch {
        // skip broken file
      }
    }
    return previews
  }

  private async callExtractor(input: ExtractionPromptInput, providerId?: string | null): Promise<ResourceExtractionRecord | null> {
    try {
      const providerService = new ProviderService()
      let resolved = providerId ? await providerService.getProvider(providerId) : null
      if (!resolved) {
        const { activeId, providers } = await providerService.listProviders()
        resolved = activeId ? providers.find((provider) => provider.id === activeId) ?? null : null
      }
      if (!resolved?.baseUrl || !resolved?.apiKey) return null

      const model = resolved.models.main || resolved.models.sonnet || resolved.models.haiku
      if (!model) return null

      const url = `${resolved.baseUrl.replace(/\/+$/, '')}/v1/messages`
      const systemPrompt = `你是安全资源提炼助手。你会收到一条资源记录、正文、附件摘要、引用列表和已授权引用的读取结果。
你的任务是把它整理成可复用的上下文资源。只输出 JSON，不要输出解释文字。

要求：
- status 只能是 idle | running | waiting_for_permission | done | failed
- summary 用一句话概括这份资源的用途和核心内容
- content 用 Markdown 输出可直接给 agent 参考的正文
- items 用结构化要点，尽量覆盖资产、范围、账号环境、约束、证据、接口、目录、URL 等
- warnings 记录缺失、待授权、可疑格式、二进制、未能读取等问题
- 如果还有 pending 引用，status 应是 waiting_for_permission
- 不要编造未读取到的内容

返回格式：
{
  "status": "done",
  "summary": "",
  "content": "",
  "items": [{"type":"asset","value":"...","description":"...","source":"..."}],
  "warnings": []
}`
      const userText = JSON.stringify(input, null, 2).slice(0, MAX_LLM_INPUT_CHARS)
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': resolved.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_LLM_OUTPUT_TOKENS,
          system: systemPrompt,
          messages: [{ role: 'user', content: userText }],
          thinking: { type: 'disabled' },
        }),
        signal: AbortSignal.timeout(120_000),
      })

      if (!response.ok) return null
      const body = await response.json() as { content?: Array<{ type: string; text?: string }> }
      const text = body.content?.find((block) => block.type === 'text')?.text
      if (!text) return null
      return this.parseExtractionJson(text)
    } catch {
      return null
    }
  }

  private buildFallbackExtraction(input: ExtractionPromptInput, warnings: string[]): ResourceExtractionRecord {
    const items: ResourceExtractionItem[] = []
    for (const reference of input.references) {
      items.push({
        type: reference.type,
        value: reference.value,
        description: reference.intent ?? 'unknown',
        source: reference.sourceText ? uniqueTextPreview(reference.sourceText, 240) : undefined,
      })
    }
    for (const readable of input.readableReferences) {
      items.push({
        type: readable.type,
        value: readable.value,
        description: readable.summary,
        source: readable.id,
      })
    }
    for (const file of input.files) {
      if (file.preview) {
        items.push({
          type: 'attachment',
          value: file.name,
          description: 'attachment preview',
          source: file.preview.slice(0, 240),
        })
      }
    }

    const pendingCount = input.references.filter((ref) => ref.permissionStatus === 'pending').length
    return {
      status: pendingCount > 0 ? 'waiting_for_permission' : 'done',
      summary: input.summary || input.title || '资源上下文',
      content: [
        `# ${input.title}`,
        '',
        input.summary ? `> ${input.summary}` : '',
        '',
        input.content ? input.content.trim() : '',
        '',
        input.readableReferences.length > 0 ? '## 已读取引用' : '',
        ...input.readableReferences.map((ref) => `- ${ref.type}: ${ref.value}\n\n  ${ref.summary}${ref.content ? `\n\n\`\`\`\n${ref.content}\n\`\`\`` : ''}`),
      ].filter(Boolean).join('\n'),
      items,
      warnings: [...new Set(warnings)],
      updatedAt: Date.now(),
    }
  }

  private parseExtractionJson(raw: string): ResourceExtractionRecord | null {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const candidates = new Set<string>([trimmed])
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim()
    if (fenced) candidates.add(fenced)
    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.add(trimmed.slice(firstBrace, lastBrace + 1))
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as Partial<ResourceExtractionRecord>
        const status = parsed.status && ['idle', 'queued', 'running', 'waiting_for_permission', 'done', 'failed'].includes(parsed.status)
          ? parsed.status as ResourceExtractionStatus
          : 'done'
        return {
          status,
          summary: sanitizeText(parsed.summary, 1000),
          content: typeof parsed.content === 'string' ? parsed.content.trim().slice(0, 20_000) : '',
          items: Array.isArray(parsed.items)
            ? parsed.items
                .filter((item): item is ResourceExtractionItem => !!item && typeof item === 'object')
                .map((item) => ({
                  type: sanitizeText((item as ResourceExtractionItem).type, 60),
                  value: sanitizeText((item as ResourceExtractionItem).value, 500),
                  description: sanitizeText((item as ResourceExtractionItem).description, 500) || undefined,
                  source: sanitizeText((item as ResourceExtractionItem).source, 240) || undefined,
                }))
            : [],
          warnings: Array.isArray(parsed.warnings)
            ? parsed.warnings.filter((warning): warning is string => typeof warning === 'string').map((warning) => sanitizeText(warning, 500)).filter(Boolean)
            : [],
          error: typeof parsed.error === 'string' ? sanitizeText(parsed.error, 500) : undefined,
          updatedAt: Date.now(),
        }
      } catch {
        // try next candidate
      }
    }
    return null
  }

  private async tryReadReference(resourceId: string, reference: ResourceReference): Promise<{ summary: string; content: string; warning?: string }> {
    if (reference.permissionStatus !== 'allowed' && reference.permissionStatus !== 'not_required') {
      return { summary: '', content: '' }
    }

    const policy = normalizePolicyForReference(reference)
    try {
      switch (reference.type) {
        case 'local_file':
          return await this.readLocalFile(reference.value, policy)
        case 'local_directory':
          return await this.readLocalDirectory(reference.value, policy)
        case 'url':
          return await this.readUrl(reference.value, policy)
        case 'git_repo':
          return { summary: '', content: '', warning: 'git_repo reading not implemented yet' }
        default:
          return { summary: '', content: '' }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.writeReferenceLastError(resourceId, reference.id, message)
      return { summary: '', content: '', warning: `${reference.value}: ${message}` }
    }
  }

  private async readLocalFile(filePath: string, policy: ResourceReadPolicy): Promise<{ summary: string; content: string }> {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) throw ApiError.badRequest(`not a file: ${filePath}`)
    if (stat.size > (policy.maxBytesPerFile ?? MAX_LOCAL_FILE_BYTES)) {
      return { summary: `${path.basename(filePath)} (${stat.size} bytes)`, content: '[file too large]' }
    }
    const raw = await fs.readFile(filePath)
    if (looksLikeBinary(raw)) {
      return { summary: path.basename(filePath), content: '[binary file]' }
    }
    const text = raw.toString('utf-8').trim()
    if (!text) return { summary: path.basename(filePath), content: '' }
    return {
      summary: `${path.basename(filePath)} (${text.split('\n').length} lines)`,
      content: text.slice(0, MAX_REFERENCE_TEXT),
    }
  }

  private async readLocalDirectory(dirPath: string, policy: ResourceReadPolicy): Promise<{ summary: string; content: string }> {
    const stat = await fs.stat(dirPath)
    if (!stat.isDirectory()) throw ApiError.badRequest(`not a directory: ${dirPath}`)
    const maxDepth = policy.maxDepth ?? MAX_DIR_DEPTH
    const maxFiles = policy.maxFiles ?? MAX_DIR_FILES
    const maxBytes = policy.maxBytesPerFile ?? MAX_LOCAL_FILE_BYTES
    const lines: string[] = []
    let count = 0

    const walk = async (currentDir: string, depth: number): Promise<void> => {
      if (count >= maxFiles || depth > maxDepth) return
      const entries = await fs.readdir(currentDir, { withFileTypes: true })
      for (const entry of entries) {
        if (count >= maxFiles) break
        const fullPath = path.join(currentDir, entry.name)
        if (entry.isDirectory()) {
          lines.push(`[dir] ${fullPath}`)
          if (depth < maxDepth) await walk(fullPath, depth + 1)
          continue
        }
        count += 1
        if (!isTextFile(entry.name)) {
          lines.push(`[file] ${fullPath}`)
          continue
        }
        try {
          const stat = await fs.stat(fullPath)
          if (stat.size > maxBytes) {
            lines.push(`[file] ${fullPath} (${stat.size} bytes)`)
            continue
          }
          const raw = await fs.readFile(fullPath)
          if (looksLikeBinary(raw)) {
            lines.push(`[file] ${fullPath} [binary]`)
            continue
          }
          const text = raw.toString('utf-8').trim()
          if (text) {
            lines.push(`## ${fullPath}\n${text.slice(0, MAX_REFERENCE_TEXT)}`)
          }
        } catch {
          lines.push(`[file] ${fullPath} [unreadable]`)
        }
      }
    }

    await walk(dirPath, 0)
    return {
      summary: `目录 ${path.basename(dirPath)}，共读取 ${count} 个条目`,
      content: lines.join('\n\n'),
    }
  }

  private async readUrl(url: string, policy: ResourceReadPolicy): Promise<{ summary: string; content: string }> {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) {
      throw ApiError.badRequest(`failed to fetch url: ${response.status}`)
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > (policy.maxBytesPerFile ?? MAX_URL_BYTES)) {
      return { summary: url, content: '[url content too large]' }
    }
    if (looksLikeBinary(buffer)) {
      return { summary: url, content: '[binary content]' }
    }
    const raw = buffer.toString('utf-8').trim()
    if (!raw) return { summary: url, content: '' }
    if (contentType.includes('html')) {
      return { summary: url, content: uniqueTextPreview(stripHtml(raw), MAX_REFERENCE_TEXT) }
    }
    return { summary: url, content: raw.slice(0, MAX_REFERENCE_TEXT) }
  }

  private mergeReferences(existing: ResourceReference[], detected: ResourceReference[]): ResourceReference[] {
    const byId = new Map(existing.map((reference) => [reference.id, normalizeReference(reference)]))
    for (const next of detected) {
      const current = byId.get(next.id)
      if (current) {
        byId.set(next.id, normalizeReference({
          ...next,
          permissionStatus: current.permissionStatus,
          readPolicy: current.readPolicy ?? next.readPolicy,
          lastReadAt: current.lastReadAt,
          lastReadSummary: current.lastReadSummary,
          lastError: current.lastError,
          createdAt: current.createdAt,
          updatedAt: Date.now(),
        }))
      } else {
        byId.set(next.id, normalizeReference(next))
      }
    }
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  private async readReferences(resourceId: string): Promise<ResourceReferenceIndex> {
    const result = await readRecoverableJsonFile<ResourceReferenceIndex>({
      filePath: referencesPath(resourceId),
      label: 'security resource references',
      defaultValue: { references: [] },
      normalize: (value): ResourceReferenceIndex | null => {
        if (!value || typeof value !== 'object' || !Array.isArray((value as ResourceReferenceIndex).references)) {
          return null
        }
        return {
          references: (value as ResourceReferenceIndex).references
            .filter((reference): reference is ResourceReference => !!reference && typeof reference === 'object')
            .map((reference) => normalizeReference(reference)),
        }
      },
    })
    return result
  }

  private async writeReferences(resourceId: string, references: ResourceReference[]): Promise<void> {
    await fs.mkdir(resourceDir(resourceId), { recursive: true })
    await fs.writeFile(referencesPath(resourceId), JSON.stringify({ references }, null, 2), 'utf-8')
  }

  private async writeExtraction(resourceId: string, extraction: ResourceExtractionRecord): Promise<void> {
    await fs.mkdir(resourceDir(resourceId), { recursive: true })
    await fs.writeFile(extractionPath(resourceId), JSON.stringify(extraction, null, 2), 'utf-8')
    await fs.writeFile(extractionMarkdownPath(resourceId), extraction.content || extraction.summary || '', 'utf-8')
  }

  private async readJson<T>(resourceId: string, fileName: string, defaultValue: T): Promise<T> {
    const result = await readRecoverableJsonFile<T>({
      filePath: path.join(resourceDir(resourceId), fileName),
      label: fileName,
      defaultValue,
      normalize: (value) => value as T,
    })
    return result
  }

  private async writeLog(resourceId: string, entry: Record<string, unknown>): Promise<void> {
    await fs.mkdir(resourceDir(resourceId), { recursive: true })
    await fs.appendFile(extractionLogPath(resourceId), `${JSON.stringify(entry)}\n`, 'utf-8')
  }

  private async writeReferenceLastError(resourceId: string, referenceId: string, error: string): Promise<void> {
    const result = await this.readReferences(resourceId)
    const index = result.references.findIndex((reference) => reference.id === referenceId)
    if (index < 0) return
    result.references[index] = {
      ...result.references[index]!,
      lastError: error,
      updatedAt: Date.now(),
    }
    await this.writeReferences(resourceId, result.references)
  }
}

export const resourceExtractionService = new ResourceExtractionService()
