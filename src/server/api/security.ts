/**
 * Security Project API — 安全测试项目的 REST 端点
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { securityProjectService } from '../services/securityProjectService.js'
import { securityResourceService } from '../services/securityResourceService.js'
import { resourceExtractionService } from '../services/resourceExtractionService.js'
import { sessionService } from '../services/sessionService.js'
import { sessionTaskService } from '../services/sessionTaskService.js'
import type { SessionTaskEvent, SessionTaskRef, SessionTaskStatus, SessionTaskType } from '../services/sessionTaskService.js'
import { sessionBoardService } from '../services/sessionBoardService.js'
import type { ProjectPriority, ExploreNode } from '../services/securityProjectService.js'
import type { SecurityResourceKind, SecurityResourceUploadFile } from '../services/securityResourceService.js'
import type { ExplorePhase } from '../services/findingsExtractionService.js'

export async function handleSecurityApi(req: Request, url: URL, _segments: string[]): Promise<Response> {
  try {
    const path = url.pathname
    const parts = path.split('/').filter(Boolean)
    const resource = parts[1]  // 'security'
    const sub = parts[2]       // 'projects' 或 undefined

    if (!sub) {
      throw ApiError.notFound('Security API root')
    }

    // /api/security/resources
    if (sub === 'resources') {
      const resourceId = parts[3]
      if (req.method === 'GET' && !resourceId) {
        return listResources()
      }
      if (req.method === 'POST' && !resourceId) {
        return createResource(req)
      }
      if (req.method === 'POST' && resourceId === 'import' && !parts[4]) {
        return importResource(req)
      }
      if (req.method === 'POST' && resourceId === 'from-session' && !parts[4]) {
        return createResourceFromSession(req)
      }
      if (resourceId && parts[4] === 'extraction' && !parts[5]) {
        if (req.method === 'GET') return getResourceExtraction(resourceId)
        throw new ApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
      }
      if (resourceId && parts[4] === 'extract' && !parts[5]) {
        if (req.method === 'POST') return extractResource(resourceId)
        throw new ApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
      }
      if (resourceId && parts[4] === 'references') {
        if (req.method === 'GET' && !parts[5]) return getResourceReferences(resourceId)
        if (req.method === 'PATCH' && parts[5] && !parts[6]) return updateResourceReference(req, resourceId, parts[5])
        if (req.method === 'POST' && parts[5] && parts[6] === 'read' && !parts[7]) return readResourceReference(resourceId, parts[5])
        throw new ApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
      }
      if (req.method === 'GET' && resourceId && !parts[4]) {
        return getResource(resourceId)
      }
      if (req.method === 'PATCH' && resourceId && !parts[4]) {
        return updateResource(req, resourceId)
      }
      if (req.method === 'DELETE' && resourceId && !parts[4]) {
        return deleteResource(resourceId)
      }
      throw new ApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    }

    // /api/security/projects
    if (sub === 'projects') {
      const projectId = parts[3]

      if (req.method === 'GET' && !projectId) {
        return listProjects()
      }
      if (req.method === 'POST' && !projectId) {
        return createProject(req)
      }
      if (req.method === 'GET' && projectId && !parts[4]) {
        return getProject(projectId)
      }
      if (req.method === 'GET' && parts[4] === 'extraction-status' && !parts[5] && projectId) {
        return getProjectExtractionStatus(projectId)
      }
      if (req.method === 'PATCH' && projectId) {
        return updateProject(req, projectId)
      }
      if (req.method === 'DELETE' && projectId && !parts[4]) {
        return deleteProject(projectId)
      }
      // /api/security/projects/:id/sessions
      if (req.method === 'POST' && parts[4] === 'sessions' && projectId) {
        return linkSession(req, projectId)
      }
      // POST /api/security/projects/:id/refresh
      if (req.method === 'POST' && parts[4] === 'refresh' && projectId) {
        return refreshProject(projectId)
      }
      // POST /api/security/projects/:id/hints — 用户注入 Hint
      if (req.method === 'POST' && parts[4] === 'hints' && projectId) {
        return addHint(req, projectId)
      }
      // GET /api/security/projects/:id/board — 黑板图快照（board MCP 读）
      if (req.method === 'GET' && parts[4] === 'board' && !parts[5] && projectId) {
        return await getBoard(projectId)
      }
      // POST /api/security/projects/:id/board/nodes — 写节点（board MCP 写，唯一写入者）
      if (req.method === 'POST' && parts[4] === 'board' && parts[5] === 'nodes' && projectId) {
        return await writeBoardNode(req, projectId)
      }

      throw new ApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    }

    // /api/security/sessions/:sid/board[...] — 会话级黑板（路 A：黑板归会话）
    if (sub === 'sessions') {
      const sessionId = parts[3]
      if (!sessionId) throw ApiError.notFound('sessionId required')
      // GET /api/security/sessions/:sid/board — 图快照（board MCP 读 + 前端面板轮询）
      if (req.method === 'GET' && parts[4] === 'board' && !parts[5]) {
        return await getSessionBoard(sessionId)
      }
      // POST /api/security/sessions/:sid/board/nodes — 写节点（board MCP 写，唯一写入者）
      if (req.method === 'POST' && parts[4] === 'board' && parts[5] === 'nodes') {
        return await writeSessionBoardNode(req, sessionId)
      }
      // POST /api/security/sessions/:sid/board/hints — 用户注入 Hint
      if (req.method === 'POST' && parts[4] === 'board' && parts[5] === 'hints') {
        return await addSessionHint(req, sessionId)
      }
      if (parts[4] === 'resources') {
        if (req.method === 'GET' && !parts[5]) {
          return await getSessionResources(sessionId)
        }
        if (req.method === 'PUT' && !parts[5]) {
          return await setSessionResources(req, sessionId)
        }
        if (req.method === 'POST' && !parts[5]) {
          return await addSessionResource(req, sessionId)
        }
        if (req.method === 'DELETE' && parts[5]) {
          return await removeSessionResource(sessionId, parts[5])
        }
      }
      if (parts[4] === 'tasks') {
        if (req.method === 'GET' && !parts[5]) {
          return await listSessionTasks(sessionId)
        }
        if (req.method === 'POST' && !parts[5]) {
          return await createSessionTask(req, sessionId)
        }
        if (req.method === 'GET' && parts[5] && !parts[6]) {
          return await getSessionTask(sessionId, parts[5])
        }
        if (req.method === 'PATCH' && parts[5] && !parts[6]) {
          return await updateSessionTask(req, sessionId, parts[5])
        }
      }
      throw new ApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    }

    // /api/security/categories — 分类注册表（内置 + 自定义）
    if (sub === 'categories') {
      const categoryId = parts[3]
      if (req.method === 'GET' && !categoryId) {
        return listCategories()
      }
      if (req.method === 'POST' && !categoryId) {
        return addCategory(req)
      }
      if (req.method === 'DELETE' && categoryId) {
        return removeCategory(categoryId)
      }
      throw new ApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    }

    throw ApiError.notFound(`Unknown security endpoint: ${sub}`)
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Handlers ────────────────────────────────────────────────

async function listProjects(): Promise<Response> {
  const projects = await securityProjectService.listProjects()
  return Response.json({ projects })
}

async function listCategories(): Promise<Response> {
  const categories = await securityProjectService.getCategories()
  return Response.json({ categories })
}

async function listResources(): Promise<Response> {
  const resources = await securityResourceService.listResources()
  return Response.json({ resources })
}

async function queueResourceExtraction(resourceId: string): Promise<void> {
  await resourceExtractionService.queueExtraction(resourceId).catch(() => undefined)
  void (async () => {
    try {
      const extraction = await resourceExtractionService.extract(resourceId)
      await securityResourceService.syncSessionResourceExtractionTask(resourceId, extraction)
    } catch (error) {
      await securityResourceService.syncSessionResourceExtractionTask(resourceId, null, error).catch(() => undefined)
    }
  })()
}

async function getResource(resourceId: string): Promise<Response> {
  const resource = await securityResourceService.getResource(resourceId)
  if (!resource) {
    throw ApiError.notFound('Resource not found')
  }
  return Response.json({ resource })
}

async function createResource(req: Request): Promise<Response> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>
  const resource = await securityResourceService.createResource({
    title: typeof body.title === 'string' ? body.title : '',
    kind: typeof body.kind === 'string' ? body.kind as SecurityResourceKind : undefined,
    tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
    summary: typeof body.summary === 'string' ? body.summary : undefined,
    content: typeof body.content === 'string' ? body.content : undefined,
    projectIds: Array.isArray(body.projectIds) ? body.projectIds as string[] : undefined,
  })
  await queueResourceExtraction(resource.meta.id)
  return Response.json({ resource }, { status: 201 })
}

async function importResource(req: Request): Promise<Response> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>
  if (!Array.isArray(body.paths) && !Array.isArray(body.files)) {
    throw ApiError.badRequest('paths or files is required')
  }
  const resource = await securityResourceService.importFiles({
    paths: Array.isArray(body.paths) ? body.paths.filter((item): item is string => typeof item === 'string') : undefined,
    files: Array.isArray(body.files) ? body.files.filter((item): item is SecurityResourceUploadFile => {
      return Boolean(item)
        && typeof item === 'object'
        && typeof (item as SecurityResourceUploadFile).name === 'string'
        && typeof (item as SecurityResourceUploadFile).dataBase64 === 'string'
    }) : undefined,
    kind: typeof body.kind === 'string' ? body.kind as SecurityResourceKind : undefined,
    tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
    summary: typeof body.summary === 'string' ? body.summary : undefined,
    projectIds: Array.isArray(body.projectIds) ? body.projectIds as string[] : undefined,
  })
  await queueResourceExtraction(resource.meta.id)
  return Response.json({ resource }, { status: 201 })
}

async function createResourceFromSession(req: Request): Promise<Response> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>
  if (!Array.isArray(body.sessionIds)) {
    throw ApiError.badRequest('sessionIds is required')
  }
  const resource = await securityResourceService.createResourceFromSessions({
    sessionIds: body.sessionIds.filter((item): item is string => typeof item === 'string'),
    title: typeof body.title === 'string' ? body.title : undefined,
    kind: typeof body.kind === 'string' ? body.kind as SecurityResourceKind : undefined,
    tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
    summary: typeof body.summary === 'string' ? body.summary : undefined,
    projectIds: Array.isArray(body.projectIds) ? body.projectIds as string[] : undefined,
  })
  await queueResourceExtraction(resource.meta.id)
  return Response.json({ resource }, { status: 201 })
}

async function updateResource(req: Request, resourceId: string): Promise<Response> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>
  const resource = await securityResourceService.updateResource(resourceId, {
    title: typeof body.title === 'string' ? body.title : undefined,
    kind: typeof body.kind === 'string' ? body.kind as SecurityResourceKind : undefined,
    tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
    summary: typeof body.summary === 'string' ? body.summary : undefined,
    content: typeof body.content === 'string' ? body.content : undefined,
    projectIds: Array.isArray(body.projectIds) ? body.projectIds as string[] : undefined,
  })
  await queueResourceExtraction(resource.meta.id)
  return Response.json({ resource })
}

async function deleteResource(resourceId: string): Promise<Response> {
  await securityResourceService.deleteResource(resourceId)
  return Response.json({ ok: true })
}

async function getResourceExtraction(resourceId: string): Promise<Response> {
  const extraction = await resourceExtractionService.getExtraction(resourceId)
  return Response.json({ extraction })
}

async function extractResource(resourceId: string): Promise<Response> {
  try {
    const extraction = await resourceExtractionService.extract(resourceId)
    await securityResourceService.syncSessionResourceExtractionTask(resourceId, extraction)
    return Response.json({ extraction })
  } catch (error) {
    await securityResourceService.syncSessionResourceExtractionTask(resourceId, null, error).catch(() => undefined)
    throw error
  }
}

async function getResourceReferences(resourceId: string): Promise<Response> {
  const references = await resourceExtractionService.getReferences(resourceId)
  return Response.json({ references })
}

async function updateResourceReference(req: Request, resourceId: string, referenceId: string): Promise<Response> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>
  const permissionStatus = typeof body.permissionStatus === 'string'
    && ['not_required', 'pending', 'allowed', 'denied', 'failed'].includes(body.permissionStatus)
    ? body.permissionStatus as 'not_required' | 'pending' | 'allowed' | 'denied' | 'failed'
    : undefined
  const readPolicy = body.readPolicy && typeof body.readPolicy === 'object'
    ? body.readPolicy as { mode: 'file' | 'list_only' | 'list_and_selected_files' | 'fetch_url' | 'clone_shallow'; maxDepth?: number; maxFiles?: number; maxBytesPerFile?: number }
    : undefined
  const reference = await resourceExtractionService.updateReferencePermission(resourceId, referenceId, {
    permissionStatus,
    readPolicy,
  })
  return Response.json({ reference })
}

async function readResourceReference(resourceId: string, referenceId: string): Promise<Response> {
  const result = await resourceExtractionService.readReference(resourceId, referenceId)
  return Response.json(result)
}

async function getSessionResources(sessionId: string): Promise<Response> {
  const resourceIds = await sessionService.getLinkedSecurityResourceIds(sessionId)
  const resources = await Promise.all(resourceIds.map((id) => securityResourceService.getResource(id)))
  return Response.json({
    resourceIds,
    resources: resources.filter((resource): resource is NonNullable<typeof resource> => Boolean(resource)),
  })
}

async function setSessionResources(req: Request, sessionId: string): Promise<Response> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>
  if (!Array.isArray(body.resourceIds)) {
    throw ApiError.badRequest('resourceIds is required')
  }
  const resourceIds = await validateResourceIds(body.resourceIds)
  const linkedResourceIds = await sessionService.setLinkedSecurityResourceIds(sessionId, resourceIds)
  const resources = await Promise.all(linkedResourceIds.map((id) => securityResourceService.getResource(id)))
  return Response.json({
    resourceIds: linkedResourceIds,
    resources: resources.filter((resource): resource is NonNullable<typeof resource> => Boolean(resource)),
  })
}

async function addSessionResource(req: Request, sessionId: string): Promise<Response> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>
  if (typeof body.resourceId !== 'string') {
    throw ApiError.badRequest('resourceId is required')
  }
  const [resourceId] = await validateResourceIds([body.resourceId])
  const current = await sessionService.getLinkedSecurityResourceIds(sessionId)
  const next = current.includes(resourceId) ? current : [...current, resourceId]
  const linkedResourceIds = await sessionService.setLinkedSecurityResourceIds(sessionId, next)
  const resources = await Promise.all(linkedResourceIds.map((id) => securityResourceService.getResource(id)))
  return Response.json({
    resourceIds: linkedResourceIds,
    resources: resources.filter((resource): resource is NonNullable<typeof resource> => Boolean(resource)),
  })
}

async function removeSessionResource(sessionId: string, resourceId: string): Promise<Response> {
  const current = await sessionService.getLinkedSecurityResourceIds(sessionId)
  const linkedResourceIds = await sessionService.setLinkedSecurityResourceIds(
    sessionId,
    current.filter((id) => id !== resourceId),
  )
  const resources = await Promise.all(linkedResourceIds.map((id) => securityResourceService.getResource(id)))
  return Response.json({
    resourceIds: linkedResourceIds,
    resources: resources.filter((resource): resource is NonNullable<typeof resource> => Boolean(resource)),
  })
}

const SESSION_TASK_TYPES: SessionTaskType[] = [
  'resource_from_session',
  'project_from_session',
  'recon',
  'skill_create',
  'skill_edit',
  'mcp_install',
  'marketplace_install',
  'config_fix',
]

const SESSION_TASK_CREATE_STATUSES: SessionTaskStatus[] = ['queued', 'running']
const SESSION_TASK_CLIENT_PATCH_STATUSES: SessionTaskStatus[] = ['queued', 'running', 'waiting_for_permission', 'failed']

function isSessionTaskType(value: unknown): value is SessionTaskType {
  return typeof value === 'string' && SESSION_TASK_TYPES.includes(value as SessionTaskType)
}

function isSessionTaskCreateStatus(value: unknown): value is SessionTaskStatus {
  return typeof value === 'string' && SESSION_TASK_CREATE_STATUSES.includes(value as SessionTaskStatus)
}

function isSessionTaskClientPatchStatus(value: unknown): value is SessionTaskStatus {
  return typeof value === 'string' && SESSION_TASK_CLIENT_PATCH_STATUSES.includes(value as SessionTaskStatus)
}

function jsonArray<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? value as T[] : undefined
}

async function listSessionTasks(sessionId: string): Promise<Response> {
  const tasks = await sessionTaskService.listTasks(sessionId)
  return Response.json({ tasks })
}

async function createSessionTask(req: Request, sessionId: string): Promise<Response> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>

  if (!isSessionTaskType(body.type)) {
    throw ApiError.badRequest('Invalid task type')
  }
  if (typeof body.title !== 'string' || !body.title.trim()) {
    throw ApiError.badRequest('title is required')
  }
  if (body.status !== undefined && !isSessionTaskCreateStatus(body.status)) {
    throw ApiError.badRequest('Client-created tasks can only start as queued or running')
  }

  const task = await sessionTaskService.createTask({
    sessionId,
    type: body.type,
    title: body.title,
    status: body.status,
    sourceRefs: jsonArray<SessionTaskRef>(body.sourceRefs),
    targetRefs: jsonArray<SessionTaskRef>(body.targetRefs),
    events: jsonArray<SessionTaskEvent>(body.events),
  })
  return Response.json({ task }, { status: 201 })
}

async function getSessionTask(sessionId: string, taskId: string): Promise<Response> {
  const task = await sessionTaskService.getTask(sessionId, taskId)
  if (!task) throw ApiError.notFound('Session task not found')
  return Response.json({ task })
}

async function updateSessionTask(req: Request, sessionId: string, taskId: string): Promise<Response> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>

  const patch: {
    status?: SessionTaskStatus
    title?: string
    sourceRefs?: SessionTaskRef[]
    targetRefs?: SessionTaskRef[]
  } = {}

  if (body.status !== undefined) {
    if (!isSessionTaskClientPatchStatus(body.status)) {
      throw ApiError.badRequest('Client updates cannot mark tasks done or empty')
    }
    patch.status = body.status
  }
  if (typeof body.title === 'string') patch.title = body.title
  if (Array.isArray(body.sourceRefs)) patch.sourceRefs = body.sourceRefs as SessionTaskRef[]
  if (Array.isArray(body.targetRefs)) patch.targetRefs = body.targetRefs as SessionTaskRef[]

  let task = Object.keys(patch).length > 0
    ? await sessionTaskService.updateTask(sessionId, taskId, patch)
    : await sessionTaskService.getTask(sessionId, taskId)
  if (!task) throw ApiError.notFound('Session task not found')

  if (body.event !== undefined) {
    if (!body.event || typeof body.event !== 'object') {
      throw ApiError.badRequest('Invalid task event')
    }
    task = await sessionTaskService.appendEvent(sessionId, taskId, body.event as SessionTaskEvent)
  }
  return Response.json({ task })
}

async function validateResourceIds(rawIds: unknown[]): Promise<string[]> {
  const resourceIds = rawIds
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    .filter(Boolean)
  const unique = [...new Set(resourceIds)]
  for (const id of unique) {
    const resource = await securityResourceService.getResource(id)
    if (!resource) {
      throw ApiError.badRequest(`resource not found: ${id}`)
    }
  }
  return unique
}

async function addCategory(req: Request): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(await req.text())
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
  if (typeof body.label !== 'string' || !body.label.trim()) {
    throw ApiError.badRequest('label is required')
  }
  const color = typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color.trim())
    ? body.color.trim()
    : '#6b7087'
  const category = await securityProjectService.addCategory({ label: body.label.trim(), color })
  return Response.json({ category }, { status: 201 })
}

async function removeCategory(categoryId: string): Promise<Response> {
  await securityProjectService.removeCategory(categoryId)
  return Response.json({ ok: true })
}

async function createProject(req: Request): Promise<Response> {
  let raw: string
  try {
    raw = await req.text()
  } catch {
    throw ApiError.badRequest('Cannot read request body')
  }
  if (!raw || !raw.trim()) {
    throw ApiError.badRequest('Empty request body')
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch (e) {
    console.error('[security] parse error:', e)
    throw ApiError.badRequest('Invalid JSON body')
  }

  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw ApiError.badRequest('name is required')
  }
  const sessionIdsForCreate = Array.isArray(body.sessionIds)
    ? (body.sessionIds as string[]).filter(s => typeof s === 'string')
    : undefined
  // target 可空：带关联会话时 createProject 会从会话推导真实 target（修"target=占位"问题）。
  const hasSessions = !!sessionIdsForCreate && sessionIdsForCreate.length > 0
  if ((typeof body.target !== 'string' || !body.target.trim()) && !hasSessions) {
    throw ApiError.badRequest('target is required (or link a session to derive it)')
  }

  const validPriorities = ['P0', 'P1', 'P2', 'P3', 'P4']
  const priority = (body.priority as string) ?? 'P2'
  if (!validPriorities.includes(priority)) {
    throw ApiError.badRequest('priority must be P0-P4')
  }

  const validCategories = (await securityProjectService.getCategories()).map((c) => c.id)
  const category = (body.category as string) ?? 'custom'
  if (!validCategories.includes(category)) {
    throw ApiError.badRequest(`category must be one of: ${validCategories.join('/')}`)
  }

  const tags = Array.isArray(body.tags)
    ? (body.tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : undefined

  const sessionIds = sessionIdsForCreate

  const project = await securityProjectService.createProject({
    name: body.name.trim(),
    target: typeof body.target === 'string' ? body.target.trim() : '',
    priority: priority as ProjectPriority,
    category,
    tags,
    sessionIds,
  })

  // D2：有关联会话时后台提炼结构化发现，不阻塞创建响应。
  if (sessionIds && sessionIds.length > 0) {
    void securityProjectService.extractFindingsForProject(project.id).catch(() => undefined)
  }

  return Response.json({ project }, { status: 201 })
}

async function getProject(projectId: string): Promise<Response> {
  const project = await securityProjectService.getProject(projectId)
  if (!project) {
    throw ApiError.notFound('Project not found')
  }
  // D1：关联会话的真实摘要；探索节点树（统一模型）；黑板 Hint。
  const sessionSummaries = await securityProjectService.getSessionSummaries(project.meta.sessionIds)
  const nodes = await securityProjectService.getNodes(projectId)
  const hints = await securityProjectService.getHints(projectId)
  const extractionStatus = await securityProjectService.getExtractionStatus(projectId)
  return Response.json({ project, sessionSummaries, nodes, hints, extractionStatus })
}

async function getProjectExtractionStatus(projectId: string): Promise<Response> {
  const extractionStatus = await securityProjectService.getExtractionStatus(projectId)
  return Response.json({ extractionStatus })
}

async function addHint(req: Request, projectId: string): Promise<Response> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>
  if (typeof body.content !== 'string' || !body.content.trim()) {
    throw ApiError.badRequest('content is required')
  }
  const hint = await securityProjectService.addHint(projectId, body.content)
  return Response.json({ hint }, { status: 201 })
}

/** GET 黑板图快照（board MCP 的 board_read 回调；纯读，复用 exportGraphSnapshot）。 */
async function getBoard(projectId: string): Promise<Response> {
  const project = await securityProjectService.getProject(projectId)
  if (!project) {
    throw ApiError.notFound('Project not found')
  }
  const snapshot = await securityProjectService.exportGraphSnapshot(projectId)
  return new Response(snapshot, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * POST 写节点（board MCP 的 board_write 回调；securityProjectService 是唯一写入者）。
 * body.kind:
 *   - 'intent'          → addIntents（reason 产出，可批量）
 *   - 'fact' | 'finding'→ 有 intentId 则 completeIntent（explore 探完）；否则 addRootFact（bootstrap 开局）
 * sessionId/agentId 由 board MCP 经 env 注入进 body（API 不向 LLM 暴露，故信任 body）。
 * 失败显式抛错，不返空兜底。
 */
async function writeBoardNode(req: Request, projectId: string): Promise<Response> {
  const project = await securityProjectService.getProject(projectId)
  if (!project) {
    throw ApiError.notFound('Project not found')
  }
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>

  const kind = body.kind
  if (kind === 'intent') {
    const intents = Array.isArray(body.intents) ? body.intents : [body]
    const parsed = intents.map((raw) => {
      const it = raw as Record<string, unknown>
      if (typeof it.title !== 'string' || !it.title.trim()) {
        throw ApiError.badRequest('intent.title is required')
      }
      return {
        title: it.title,
        fromFactIds: Array.isArray(it.fromFactIds) ? (it.fromFactIds as string[]) : undefined,
        phase: typeof it.phase === 'string' ? (it.phase as ExplorePhase) : undefined,
        parentId: typeof it.parentId === 'string' ? it.parentId : undefined,
      }
    })
    const created = await securityProjectService.addIntents(projectId, parsed)
    return Response.json({ created }, { status: 201 })
  }

  if (kind === 'fact' || kind === 'finding' || kind === 'asset') {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      throw ApiError.badRequest('title is required')
    }
    // asset 是攻击面/对象骨架节点，不强制 result；fact/finding 仍必须有结论。
    if (kind !== 'asset' && (typeof body.result !== 'string' || !body.result.trim())) {
      throw ApiError.badRequest('result is required')
    }
    const node = {
      type: kind,
      title: body.title,
      result: typeof body.result === 'string' ? body.result : undefined,
      process: typeof body.process === 'string' ? body.process : undefined,
      evidence: typeof body.evidence === 'string' ? body.evidence : undefined,
      payload: typeof body.payload === 'string' ? body.payload : undefined,
      flag: typeof body.flag === 'string' ? body.flag : undefined,
      severity: typeof body.severity === 'string' ? (body.severity as ExploreNode['severity']) : undefined,
      phase: typeof body.phase === 'string' ? (body.phase as ExplorePhase) : undefined,
      parentId: typeof body.parentId === 'string' ? body.parentId : undefined,
      assetKind: typeof body.assetKind === 'string' ? body.assetKind : undefined,
      detail: typeof body.detail === 'string' ? body.detail : undefined,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
      agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
    }
    if (typeof body.intentId === 'string' && body.intentId.trim()) {
      const fact = await securityProjectService.completeIntent(projectId, body.intentId, node)
      if (!fact) throw ApiError.badRequest(`intent not found: ${body.intentId}`)
      return Response.json({ node: fact }, { status: 201 })
    }
    const fact = await securityProjectService.addRootFact(projectId, node)
    return Response.json({ node: fact }, { status: 201 })
  }

  throw ApiError.badRequest(`unknown board node kind: ${String(kind)}`)
}

// ─── 会话级黑板 handlers（路 A：黑板归会话）──────────────────

/** GET 会话黑板图快照（board MCP 读 + 前端面板轮询）。无 meta（未开测试模式）返空 graph。 */
async function getSessionBoard(sessionId: string): Promise<Response> {
  const snapshot = await sessionBoardService.exportGraphSnapshot(sessionId)
  // 未开测试模式时 snapshot 为空串——返回空图，前端面板显示"未开启"
  return new Response(snapshot || JSON.stringify({ goal: '', target: '', facts: [], intents: [], hints: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * POST 写会话黑板节点（board MCP 的 board_write 回调；sessionBoardService 唯一写入者）。
 * 与项目级同形：kind=intent → addIntents；fact/finding 有 intentId → completeIntent，否则 addRootFact。
 * 失败显式抛错，不返空兜底。
 */
async function writeSessionBoardNode(req: Request, sessionId: string): Promise<Response> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>

  const kind = body.kind
  if (kind === 'intent') {
    const intents = Array.isArray(body.intents) ? body.intents : [body]
    const parsed = intents.map((raw) => {
      const it = raw as Record<string, unknown>
      if (typeof it.title !== 'string' || !it.title.trim()) {
        throw ApiError.badRequest('intent.title is required')
      }
      return {
        title: it.title,
        fromFactIds: Array.isArray(it.fromFactIds) ? (it.fromFactIds as string[]) : undefined,
        phase: typeof it.phase === 'string' ? (it.phase as ExplorePhase) : undefined,
        parentId: typeof it.parentId === 'string' ? it.parentId : undefined,
      }
    })
    const created = await sessionBoardService.addIntents(sessionId, parsed)
    return Response.json({ created }, { status: 201 })
  }

  if (kind === 'fact' || kind === 'finding' || kind === 'asset') {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      throw ApiError.badRequest('title is required')
    }
    // asset 是攻击面/对象骨架节点，不强制 result；fact/finding 仍必须有结论。
    if (kind !== 'asset' && (typeof body.result !== 'string' || !body.result.trim())) {
      throw ApiError.badRequest('result is required')
    }
    const node = {
      type: kind,
      title: body.title,
      result: typeof body.result === 'string' ? body.result : undefined,
      process: typeof body.process === 'string' ? body.process : undefined,
      evidence: typeof body.evidence === 'string' ? body.evidence : undefined,
      payload: typeof body.payload === 'string' ? body.payload : undefined,
      flag: typeof body.flag === 'string' ? body.flag : undefined,
      severity: typeof body.severity === 'string' ? (body.severity as ExploreNode['severity']) : undefined,
      phase: typeof body.phase === 'string' ? (body.phase as ExplorePhase) : undefined,
      parentId: typeof body.parentId === 'string' ? body.parentId : undefined,
      assetKind: typeof body.assetKind === 'string' ? body.assetKind : undefined,
      detail: typeof body.detail === 'string' ? body.detail : undefined,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : sessionId,
      agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
    }
    if (typeof body.intentId === 'string' && body.intentId.trim()) {
      const fact = await sessionBoardService.completeIntent(sessionId, body.intentId, node)
      if (!fact) throw ApiError.badRequest(`intent not found: ${body.intentId}`)
      return Response.json({ node: fact }, { status: 201 })
    }
    const fact = await sessionBoardService.addRootFact(sessionId, node)
    return Response.json({ node: fact }, { status: 201 })
  }

  throw ApiError.badRequest(`unknown board node kind: ${String(kind)}`)
}

/** POST 会话黑板注入 Hint。 */
async function addSessionHint(req: Request, sessionId: string): Promise<Response> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>
  if (typeof body.content !== 'string' || !body.content.trim()) {
    throw ApiError.badRequest('content is required')
  }
  const hint = await sessionBoardService.addHint(sessionId, body.content)
  return Response.json({ hint }, { status: 201 })
}

async function updateProject(req: Request, projectId: string): Promise<Response> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>

  const updates: Record<string, unknown> = {}
  if (typeof body.name === 'string') updates.name = body.name
  if (typeof body.priority === 'string') updates.priority = body.priority
  if (typeof body.status === 'string') updates.status = body.status
  if (typeof body.category === 'string') {
    // 校验 category 是否在注册表中（内置+自定义）
    const validCategories = (await securityProjectService.getCategories()).map((c) => c.id)
    if (!validCategories.includes(body.category)) {
      throw ApiError.badRequest(`category must be one of: ${validCategories.join('/')}`)
    }
    updates.category = body.category
  }

  await securityProjectService.updateProject(projectId, updates)
  return Response.json({ ok: true })
}

async function deleteProject(projectId: string): Promise<Response> {
  await securityProjectService.deleteProject(projectId)
  return Response.json({ ok: true })
}

async function linkSession(req: Request, projectId: string): Promise<Response> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>

  if (typeof body.sessionId !== 'string') {
    throw ApiError.badRequest('sessionId is required')
  }

  await securityProjectService.linkSession(projectId, body.sessionId)
  // D1：仅挂接会话，不再正则刮取伪造 board。
  // D2：后台对会话做 LLM 提炼，结果写 findings.json，不阻塞响应。
  void securityProjectService.extractFindingsForProject(projectId).catch(() => undefined)
  return Response.json({ ok: true })
}

async function refreshProject(projectId: string): Promise<Response> {
  // D1：刷新会话摘要由 getProject 实时计算，这里不再正则刮取。
  // D2：刷新时重新触发结构化发现提炼（同步等待，让前端刷新后即可见）。
  const project = await securityProjectService.getProject(projectId)
  if (!project) {
    throw ApiError.notFound('Project not found')
  }
  await securityProjectService.extractFindingsForProject(projectId).catch(() => undefined)
  return Response.json({ ok: true })
}
