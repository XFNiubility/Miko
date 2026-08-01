import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getDataDir } from '../../utils/kimoPaths.js'
import { ApiError } from '../middleware/errorHandler.js'
import { readRecoverableJsonFile } from './recoverableJsonFile.js'

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
  sessionId: string
  type: SessionTaskType
  title: string
  status?: SessionTaskStatus
  sourceRefs?: SessionTaskRef[]
  targetRefs?: SessionTaskRef[]
  events?: SessionTaskEvent[]
}

const SECURITY_DIR = 'security'
const SESSIONS_DIR = '_sessions'
const TASKS_DIR = 'tasks'
const MAX_EVENTS = 200

function tasksDir(sessionId: string): string {
  return path.join(getDataDir(), SECURITY_DIR, SESSIONS_DIR, sessionId, TASKS_DIR)
}

function taskPath(sessionId: string, taskId: string): string {
  return path.join(tasksDir(sessionId), `${taskId}.json`)
}

function isValidId(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value)
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function normalizeRef(value: unknown): SessionTaskRef | null {
  if (!value || typeof value !== 'object') return null
  const item = value as SessionTaskRef
  const validTypes: SessionTaskRef['type'][] = ['session', 'resource', 'project', 'skill', 'mcp', 'tool', 'file', 'url', 'manual']
  const type = validTypes.includes(item.type) ? item.type : 'manual'
  return {
    type,
    id: cleanText(item.id, 200) || undefined,
    title: cleanText(item.title, 300) || undefined,
    value: cleanText(item.value, 1000) || undefined,
  }
}

function normalizeRefs(value: unknown): SessionTaskRef[] {
  if (!Array.isArray(value)) return []
  return value.map(normalizeRef).filter((item): item is SessionTaskRef => Boolean(item))
}

function normalizeEvent(value: unknown): SessionTaskEvent | null {
  if (!value || typeof value !== 'object') return null
  const item = value as SessionTaskEvent
  const level = item.level === 'warning' || item.level === 'error' ? item.level : 'info'
  const phase = cleanText(item.phase, 80) || 'event'
  const message = cleanText(item.message, 1000)
  if (!message) return null
  return {
    timestamp: cleanText(item.timestamp, 80) || new Date().toISOString(),
    level,
    phase,
    message,
    data: item.data && typeof item.data === 'object' ? item.data as Record<string, unknown> : undefined,
  }
}

function normalizeEvents(value: unknown): SessionTaskEvent[] {
  if (!Array.isArray(value)) return []
  return value.map(normalizeEvent).filter((item): item is SessionTaskEvent => Boolean(item)).slice(-MAX_EVENTS)
}

function normalizeTask(value: unknown, fallbackSessionId?: string): SessionTask | null {
  if (!value || typeof value !== 'object') return null
  const item = value as SessionTask
  const id = cleanText(item.id, 120)
  const sessionId = cleanText(item.sessionId, 200) || fallbackSessionId || ''
  const validTypes: SessionTaskType[] = ['resource_from_session', 'project_from_session', 'recon', 'skill_create', 'skill_edit', 'mcp_install', 'marketplace_install', 'config_fix']
  const validStatuses: SessionTaskStatus[] = ['queued', 'running', 'waiting_for_permission', 'done', 'empty', 'failed']
  if (!id || !sessionId) return null
  const status = validStatuses.includes(item.status) ? item.status : 'queued'
  return {
    id,
    sessionId,
    type: validTypes.includes(item.type) ? item.type : 'recon',
    title: cleanText(item.title, 300) || 'Agent task',
    status,
    sourceRefs: normalizeRefs(item.sourceRefs),
    targetRefs: normalizeRefs(item.targetRefs),
    events: normalizeEvents(item.events),
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
    completedAt: typeof item.completedAt === 'number' ? item.completedAt : null,
  }
}

export class SessionTaskService {
  async listTasks(sessionId: string): Promise<SessionTask[]> {
    this.assertSessionId(sessionId)
    let entries: string[]
    try {
      entries = await fs.readdir(tasksDir(sessionId))
    } catch {
      return []
    }
    const tasks = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => this.readTaskFile(sessionId, path.join(tasksDir(sessionId), entry))),
    )
    return tasks
      .filter((task): task is SessionTask => Boolean(task))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async getTask(sessionId: string, taskId: string): Promise<SessionTask | null> {
    this.assertSessionId(sessionId)
    this.assertTaskId(taskId)
    return this.readTaskFile(sessionId, taskPath(sessionId, taskId))
  }

  async createTask(input: SessionTaskInput): Promise<SessionTask> {
    this.assertSessionId(input.sessionId)
    const now = Date.now()
    const task: SessionTask = {
      id: `task_${crypto.randomUUID()}`,
      sessionId: input.sessionId,
      type: input.type,
      title: cleanText(input.title, 300) || 'Agent task',
      status: input.status ?? 'queued',
      sourceRefs: normalizeRefs(input.sourceRefs),
      targetRefs: normalizeRefs(input.targetRefs),
      events: normalizeEvents(input.events),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    await this.writeTask(task)
    return task
  }

  async updateTask(sessionId: string, taskId: string, patch: Partial<Omit<SessionTask, 'id' | 'sessionId' | 'createdAt'>>): Promise<SessionTask> {
    const current = await this.getTask(sessionId, taskId)
    if (!current) throw ApiError.notFound('Session task not found')
    const status = patch.status ?? current.status
    const task: SessionTask = {
      ...current,
      ...(patch.type ? { type: patch.type } : {}),
      ...(patch.title !== undefined ? { title: cleanText(patch.title, 300) || current.title } : {}),
      status,
      ...(patch.sourceRefs ? { sourceRefs: normalizeRefs(patch.sourceRefs) } : {}),
      ...(patch.targetRefs ? { targetRefs: normalizeRefs(patch.targetRefs) } : {}),
      ...(patch.events ? { events: normalizeEvents(patch.events) } : {}),
      updatedAt: Date.now(),
      completedAt: status === 'done' || status === 'empty' || status === 'failed'
        ? (patch.completedAt ?? Date.now())
        : (patch.completedAt ?? null),
    }
    await this.writeTask(task)
    return task
  }

  async appendEvent(sessionId: string, taskId: string, event: Omit<SessionTaskEvent, 'timestamp'> & { timestamp?: string }): Promise<SessionTask> {
    const current = await this.getTask(sessionId, taskId)
    if (!current) throw ApiError.notFound('Session task not found')
    const normalized = normalizeEvent({
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    })
    if (!normalized) throw ApiError.badRequest('Invalid task event')
    const task: SessionTask = {
      ...current,
      events: [...current.events, normalized].slice(-MAX_EVENTS),
      updatedAt: Date.now(),
    }
    await this.writeTask(task)
    return task
  }

  private async readTaskFile(sessionId: string, filePath: string): Promise<SessionTask | null> {
    const result = await readRecoverableJsonFile<SessionTask | null>({
      filePath,
      label: 'session task',
      defaultValue: null,
      normalize: (value) => normalizeTask(value, sessionId),
    })
    return result
  }

  private async writeTask(task: SessionTask): Promise<void> {
    await fs.mkdir(tasksDir(task.sessionId), { recursive: true })
    await fs.writeFile(taskPath(task.sessionId, task.id), JSON.stringify(task, null, 2), 'utf-8')
  }

  private assertSessionId(sessionId: string): void {
    if (!sessionId || sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
      throw ApiError.badRequest('Invalid session id')
    }
  }

  private assertTaskId(taskId: string): void {
    if (!isValidId(taskId)) throw ApiError.badRequest('Invalid task id')
  }
}

export const sessionTaskService = new SessionTaskService()
