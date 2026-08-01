import { api } from './client'

export type ProjectPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4'
export type ProjectStatus = 'active' | 'paused' | 'completed'
/** 内置分类 id；自定义分类是动态字符串，所以 ProjectMeta.category 用 string。 */
export type ProjectCategory = 'web' | 'audit' | 'asset' | 'mobile' | 'binary' | 'custom'
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
  sourceType?: 'manual_text' | 'uploaded_file' | 'session_ref' | 'external_ref'
  sourceRefs?: Array<{ type: 'session' | 'file' | 'path' | 'url' | 'git' | 'manual'; id?: string; title?: string; value?: string }>
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

export type ResourceReadPolicy = {
  mode: 'file' | 'list_only' | 'list_and_selected_files' | 'fetch_url' | 'clone_shallow'
  maxDepth?: number
  maxFiles?: number
  maxBytesPerFile?: number
}

export type ResourceReference = {
  id: string
  type: 'local_file' | 'local_directory' | 'url' | 'git_repo' | 'domain' | 'ip' | 'note'
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

export type ResourceExtraction = {
  status: 'idle' | 'queued' | 'running' | 'waiting_for_permission' | 'done' | 'failed'
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

export type SessionTaskType =
  | 'resource_from_session'
  | 'project_from_session'
  | 'recon'
  | 'skill_create'
  | 'skill_edit'
  | 'mcp_install'
  | 'marketplace_install'
  | 'config_fix'

export type SessionTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_permission'
  | 'done'
  | 'empty'
  | 'failed'

export type SessionTaskRef = {
  type: 'session' | 'resource' | 'project' | 'skill' | 'mcp' | 'tool' | 'file' | 'url' | 'manual'
  id?: string
  title?: string
  value?: string
}

export type SessionTaskEvent = {
  timestamp: string
  level: 'info' | 'warning' | 'error'
  phase: string
  message: string
  data?: Record<string, unknown>
}

export type SessionTask = {
  id: string
  sessionId: string
  type: SessionTaskType
  title: string
  status: SessionTaskStatus
  sourceRefs: SessionTaskRef[]
  targetRefs: SessionTaskRef[]
  events: SessionTaskEvent[]
  createdAt: number
  updatedAt: number
  completedAt?: number | null
}

export type SessionTaskInput = {
  type: SessionTaskType
  title: string
  status?: 'queued' | 'running'
  sourceRefs?: SessionTaskRef[]
  targetRefs?: SessionTaskRef[]
  events?: SessionTaskEvent[]
}

export type SessionTaskUpdateInput = {
  title?: string
  status?: 'queued' | 'running' | 'waiting_for_permission' | 'failed'
  sourceRefs?: SessionTaskRef[]
  targetRefs?: SessionTaskRef[]
  event?: Partial<SessionTaskEvent> & Pick<SessionTaskEvent, 'level' | 'phase' | 'message'>
}

/** 分类定义（注册表项）。内置分类 builtin=true，不可删除。 */
export type CategoryDef = {
  id: string
  label: string
  color: string
  builtin?: boolean
}

export type ProjectMeta = {
  id: string
  name: string
  target: string
  priority: ProjectPriority
  status: ProjectStatus
  goal: string
  category: string
  tags?: string[]
  sessionIds: string[]
  findingCount?: number
  createdAt: number
  updatedAt: number
}

export type Fact = {
  id: string
  title: string
  detail: string
  severity?: string
  sourceIntent: string
  createdAt: number
}

export type Intent = {
  id: string
  description: string
  status: string
  createdAt: number
}

export type Hint = {
  id: string
  content: string
  createdAt: number
}

export type Blackboard = {
  facts: Fact[]
  intents: Intent[]
  hints: Hint[]
  closedIntentIds: string[]
}

export type Finding = {
  id: string
  title: string
  detail: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  status: string
  location?: string
  sessionId: string
  createdAt: number
}

export type SecurityProject = {
  meta: ProjectMeta
  board: Blackboard
  findings: Finding[]
}

/** D1：关联会话的真实摘要（标题/步骤数/结论），由后端实时从 JSONL 读取。 */
export type SessionSummary = {
  sessionId: string
  title: string
  stepCount: number
  conclusion: string
}

export type ProjectExtractionStatus = {
  status: 'idle' | 'queued' | 'running' | 'done' | 'empty' | 'failed'
  phase: string
  source: 'linked_sessions'
  sessionIds: string[]
  sessionCount: number
  nodeCount: number
  findingCount: number
  error?: string
  startedAt?: number | null
  updatedAt: number
  completedAt?: number | null
}

/** 探索节点（统一模型）：D2 提炼/真黑板产出，前端用同一棵树渲染。 */
export type ExploreNodeType = 'asset' | 'fact' | 'intent' | 'finding'
export type ExplorePhase = 'recon' | 'asset' | 'probe' | 'exploit' | 'post' | 'other'

/** intent 的真黑板图语义状态（区别于 D2 提炼用的旧 status 字段）。 */
export type IntentGraphStatus = 'open' | 'running' | 'done' | 'failed'

export type ExploreNode = {
  id: string
  type: ExploreNodeType
  title: string
  parentId?: string
  phase?: ExplorePhase
  sessionId: string
  createdAt: number
  assetKind?: string
  detail?: string
  process?: string
  result?: string
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info'
  status?: string
  location?: string
  payload?: string
  evidence?: string
  flag?: string
  // ── 真黑板图语义（intent 专属，阶段1）──
  /** open=待探, running=worker 探索中, done=探完, failed=探死。旧节点读取时默认 done。 */
  graphStatus?: IntentGraphStatus
  /** 认领该 intent 的 worker 标识 */
  claimedBy?: string
  /** 派生该 intent 的源 fact 节点 id */
  fromFactIds?: string[]
  /** 探完后产出的 fact 节点 id（done 时指向结果） */
  toFactId?: string
}

export type CreateProjectInput = {
  name: string
  target: string
  priority: string
  category?: string
  tags?: string[]
  sessionIds?: string[]
}

export const securityApi = {
  listResources: () => api.get<{ resources: SecurityResourceMeta[] }>('/api/security/resources'),

  getResource: (id: string) =>
    api.get<{ resource: SecurityResource }>(`/api/security/resources/${id}`),

  createResource: (data: SecurityResourceInput) =>
    api.post<{ resource: SecurityResource }>('/api/security/resources', data),

  importResource: (data: SecurityResourceImportInput) =>
    api.post<{ resource: SecurityResource }>('/api/security/resources/import', data),

  createResourceFromSession: (data: SecurityResourceFromSessionInput) =>
    api.post<{ resource: SecurityResource }>('/api/security/resources/from-session', data),

  getResourceExtraction: (id: string) =>
    api.get<{ extraction: ResourceExtraction | null }>(`/api/security/resources/${id}/extraction`),

  extractResource: (id: string) =>
    api.post<{ extraction: ResourceExtraction | null }>(`/api/security/resources/${id}/extract`),

  getResourceReferences: (id: string) =>
    api.get<{ references: ResourceReference[] }>(`/api/security/resources/${id}/references`),

  updateResourceReference: (id: string, referenceId: string, data: { permissionStatus?: ResourceReferencePermissionStatus; readPolicy?: ResourceReadPolicy }) =>
    api.patch<{ reference: ResourceReference }>(`/api/security/resources/${id}/references/${referenceId}`, data),

  readResourceReference: (id: string, referenceId: string) =>
    api.post<{ reference: ResourceReference; extraction: ResourceExtraction | null }>(`/api/security/resources/${id}/references/${referenceId}/read`),

  updateResource: (id: string, data: Partial<SecurityResourceInput>) =>
    api.patch<{ resource: SecurityResource }>(`/api/security/resources/${id}`, data),

  deleteResource: (id: string) => api.delete<{ ok: true }>(`/api/security/resources/${id}`),

  getSessionResources: (sessionId: string) =>
    api.get<{ resourceIds: string[]; resources: SecurityResource[] }>(`/api/security/sessions/${sessionId}/resources`),

  setSessionResources: (sessionId: string, resourceIds: string[]) =>
    api.put<{ resourceIds: string[]; resources: SecurityResource[] }>(`/api/security/sessions/${sessionId}/resources`, { resourceIds }),

  addSessionResource: (sessionId: string, resourceId: string) =>
    api.post<{ resourceIds: string[]; resources: SecurityResource[] }>(`/api/security/sessions/${sessionId}/resources`, { resourceId }),

  removeSessionResource: (sessionId: string, resourceId: string) =>
    api.delete<{ resourceIds: string[]; resources: SecurityResource[] }>(`/api/security/sessions/${sessionId}/resources/${resourceId}`),

  getSessionTasks: (sessionId: string) =>
    api.get<{ tasks: SessionTask[] }>(`/api/security/sessions/${sessionId}/tasks`),

  createSessionTask: (sessionId: string, data: SessionTaskInput) =>
    api.post<{ task: SessionTask }>(`/api/security/sessions/${sessionId}/tasks`, data),

  getSessionTask: (sessionId: string, taskId: string) =>
    api.get<{ task: SessionTask }>(`/api/security/sessions/${sessionId}/tasks/${taskId}`),

  updateSessionTask: (sessionId: string, taskId: string, data: SessionTaskUpdateInput) =>
    api.patch<{ task: SessionTask }>(`/api/security/sessions/${sessionId}/tasks/${taskId}`, data),

  list: () => api.get<{ projects: ProjectMeta[] }>('/api/security/projects'),

  /** 分类注册表：内置 + 用户自定义。 */
  listCategories: () => api.get<{ categories: CategoryDef[] }>('/api/security/categories'),

  /** 新增自定义分类（label + 16 进制色值）。 */
  addCategory: (data: { label: string; color: string }) =>
    api.post<{ category: CategoryDef }>('/api/security/categories', data),

  /** 删除自定义分类（内置不可删；占用项目会被重置为 custom）。 */
  removeCategory: (id: string) => api.delete<{ ok: true }>(`/api/security/categories/${id}`),

  create: (data: CreateProjectInput) =>
    api.post<{ project: ProjectMeta }>('/api/security/projects', data),

  get: (id: string) =>
    api.get<{ project: SecurityProject; sessionSummaries: SessionSummary[]; nodes: ExploreNode[]; hints: Hint[]; extractionStatus?: ProjectExtractionStatus }>(
      `/api/security/projects/${id}`,
    ),

  getProjectExtractionStatus: (id: string) =>
    api.get<{ extractionStatus: ProjectExtractionStatus }>(`/api/security/projects/${id}/extraction-status`),

  update: (id: string, data: Partial<Pick<ProjectMeta, 'name' | 'priority' | 'status'>>) =>
    api.patch<{ ok: true }>(`/api/security/projects/${id}`, data),

  remove: (id: string) => api.delete<{ ok: true }>(`/api/security/projects/${id}`),

  // refresh 同步等后端 LLM 提炼（最长 5min，见 findingsExtractionService EXTRACTION_TIMEOUT_MS）。
  // 必须给一个大于后端上限的超时，否则 client 默认 30s 会先 abort——后端虽成功但前端报超时、
  // 且跳过刷新后的 reloadSelected，UI 不更新（要手动刷浏览器才见数据）。
  refresh: (id: string) => api.post<{ ok: true }>(`/api/security/projects/${id}/refresh`, undefined, { timeout: 310_000 }),

  linkSession: (id: string, sessionId: string) =>
    api.post<{ ok: true }>(`/api/security/projects/${id}/sessions`, { sessionId }),

  /** 用户向黑板注入一条 Hint（人在回路指导）。 */
  addHint: (id: string, content: string) =>
    api.post<{ hint: Hint }>(`/api/security/projects/${id}/hints`, { content }),

  /** 读会话级黑板图快照（紧凑 JSON）。会话级黑板面板轮询用。 */
  getSessionBoard: (sessionId: string) =>
    api.get<SessionBoardSnapshot>(`/api/security/sessions/${sessionId}/board`),

  /** 向会话级黑板注入 Hint。 */
  addSessionHint: (sessionId: string, content: string) =>
    api.post<{ hint: Hint }>(`/api/security/sessions/${sessionId}/board/hints`, { content }),
}

/** 会话级黑板紧凑快照（exportGraphSnapshot 的形状）。 */
export type SessionBoardSnapshot = {
  goal: string
  target: string
  facts: Array<{ id: string; type: string; title: string; parentId?: string; severity?: string; result?: string }>
  intents: Array<{ id: string; title: string; status: string; parentId?: string; from?: string[]; to?: string; result?: string }>
  hints: string[]
}
