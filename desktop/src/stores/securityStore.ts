import { create } from 'zustand'
import { securityApi } from '../api/security'
import type {
  CategoryDef,
  CreateProjectInput,
  ExploreNode,
  Hint,
  ProjectMeta,
  ProjectExtractionStatus,
  ProjectStatus,
  ResourceExtraction,
  ResourceReference,
  ResourceReferencePermissionStatus,
  SecurityProject,
  SecurityResourceFromSessionInput,
  SecurityResource,
  SecurityResourceImportInput,
  SecurityResourceInput,
  SecurityResourceMeta,
  SessionTask,
  SessionSummary,
} from '../api/security'

type SecurityStore = {
  projects: ProjectMeta[]
  categories: CategoryDef[]
  selectedProjectId: string | null
  selectedProject: SecurityProject | null
  resources: SecurityResourceMeta[]
  selectedResourceId: string | null
  selectedResource: SecurityResource | null
  resourceExtractions: Record<string, ResourceExtraction | null>
  resourceReferences: Record<string, ResourceReference[]>
  sessionResourceIds: Record<string, string[]>
  sessionResources: Record<string, SecurityResource[]>
  sessionTasks: Record<string, SessionTask[]>
  sessionSummaries: SessionSummary[]
  nodes: ExploreNode[]
  hints: Hint[]
  projectExtractionStatus: ProjectExtractionStatus | null

  isProjectsLoading: boolean
  isResourcesLoading: boolean
  isDetailLoading: boolean
  isResourceDetailLoading: boolean
  isMutating: boolean
  /** D2 后台提炼进行中：详情已加载、有关联会话但还没发现，正在轮询等结果。 */
  isExtracting: boolean
  listError: string | null
  detailError: string | null

  fetchProjects: () => Promise<void>
  fetchResources: () => Promise<void>
  selectResource: (id: string) => Promise<void>
  clearResourceSelection: () => void
  createResource: (data: SecurityResourceInput) => Promise<string | null>
  importResource: (data: SecurityResourceImportInput) => Promise<string | null>
  createResourceFromSession: (data: SecurityResourceFromSessionInput) => Promise<string | null>
  updateResource: (id: string, data: Partial<SecurityResourceInput>) => Promise<void>
  deleteResource: (id: string) => Promise<void>
  fetchResourceExtraction: (id: string) => Promise<void>
  fetchResourceReferences: (id: string) => Promise<void>
  runResourceExtraction: (id: string) => Promise<void>
  pollResourceExtraction: (id: string, seq: number) => Promise<void>
  updateResourceReference: (id: string, referenceId: string, permissionStatus: ResourceReferencePermissionStatus) => Promise<void>
  readResourceReference: (id: string, referenceId: string) => Promise<void>
  fetchSessionResources: (sessionId: string) => Promise<void>
  setSessionResources: (sessionId: string, resourceIds: string[]) => Promise<void>
  fetchSessionTasks: (sessionId: string) => Promise<void>
  fetchCategories: () => Promise<void>
  addCategory: (label: string, color: string) => Promise<CategoryDef | null>
  removeCategory: (id: string) => Promise<void>
  selectProject: (id: string) => Promise<void>
  pollForFindings: (id: string, seq: number) => Promise<void>
  clearSelection: () => void
  reloadSelected: () => Promise<void>

  createProject: (data: CreateProjectInput) => Promise<string | null>
  updateProject: (id: string, data: Partial<Pick<ProjectMeta, 'name' | 'priority' | 'status' | 'category'>>) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  refreshProject: (id: string) => Promise<void>
  linkSession: (id: string, sessionId: string) => Promise<void>
  addHint: (id: string, content: string) => Promise<void>
}

// Monotonic token so a slow detail request can never overwrite a newer selection.
let detailRequestSeq = 0
let resourceDetailRequestSeq = 0

// D2 提炼是后台异步的：打开详情那刻 findings 可能还空，过几秒才写入。
// 这里在"有会话但暂无发现"时轮询几次把结果拉回来，避免用户看到假的 0。
const POLL_INTERVAL_MS = 1000
const POLL_MAX_ATTEMPTS = 60
const RESOURCE_POLL_INTERVAL_MS = 1000
const RESOURCE_POLL_MAX_ATTEMPTS = 60

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const useSecurityStore = create<SecurityStore>((set, get) => ({
  projects: [],
  categories: [],
  selectedProjectId: null,
  selectedProject: null,
  resources: [],
  selectedResourceId: null,
  selectedResource: null,
  resourceExtractions: {},
  resourceReferences: {},
  sessionResourceIds: {},
  sessionResources: {},
  sessionTasks: {},
  sessionSummaries: [],
  nodes: [],
  hints: [],
  projectExtractionStatus: null,

  isProjectsLoading: false,
  isResourcesLoading: false,
  isDetailLoading: false,
  isResourceDetailLoading: false,
  isMutating: false,
  isExtracting: false,
  listError: null,
  detailError: null,

  fetchProjects: async () => {
    set({ isProjectsLoading: true, listError: null })
    try {
      const { projects } = await securityApi.list()
      set({ projects, isProjectsLoading: false })
    } catch (err) {
      set({ listError: errMsg(err), isProjectsLoading: false })
    }
  },

  fetchResources: async () => {
    set({ isResourcesLoading: true, listError: null })
    try {
      const { resources } = await securityApi.listResources()
      set({ resources, isResourcesLoading: false })
    } catch (err) {
      set({ listError: errMsg(err), isResourcesLoading: false })
    }
  },

  selectResource: async (id) => {
    const seq = ++resourceDetailRequestSeq
    set({
      selectedResourceId: id,
      selectedResource: get().selectedResourceId === id ? get().selectedResource : null,
      isResourceDetailLoading: true,
      detailError: null,
    })
    try {
      const [{ resource }, extractionResult, referencesResult] = await Promise.all([
        securityApi.getResource(id),
        securityApi.getResourceExtraction(id).catch(() => ({ extraction: null })),
        securityApi.getResourceReferences(id).catch(() => ({ references: [] })),
      ])
      if (get().selectedResourceId !== id || seq !== resourceDetailRequestSeq) return
      set((state) => ({
        selectedResource: resource,
        resourceExtractions: { ...state.resourceExtractions, [id]: extractionResult.extraction },
        resourceReferences: { ...state.resourceReferences, [id]: referencesResult.references },
        isResourceDetailLoading: false,
      }))
      const status = extractionResult.extraction?.status
      if (status === 'queued' || status === 'running') {
        void get().pollResourceExtraction(id, seq)
      }
    } catch (err) {
      if (get().selectedResourceId !== id || seq !== resourceDetailRequestSeq) return
      set({ detailError: errMsg(err), isResourceDetailLoading: false })
    }
  },

  clearResourceSelection: () => {
    resourceDetailRequestSeq++
    set({ selectedResourceId: null, selectedResource: null, isResourceDetailLoading: false })
  },

  createResource: async (data) => {
    set({ isMutating: true, listError: null })
    try {
      const { resource } = await securityApi.createResource(data)
      set((state) => ({ resources: [resource.meta, ...state.resources], isMutating: false }))
      await get().selectResource(resource.meta.id)
      if (get().selectedResourceId === resource.meta.id) {
        void get().pollResourceExtraction(resource.meta.id, resourceDetailRequestSeq)
      }
      return resource.meta.id
    } catch (err) {
      set({ listError: errMsg(err), isMutating: false })
      return null
    }
  },

  importResource: async (data) => {
    set({ isMutating: true, listError: null })
    try {
      const { resource } = await securityApi.importResource(data)
      set((state) => ({ resources: [resource.meta, ...state.resources], isMutating: false }))
      await get().selectResource(resource.meta.id)
      if (get().selectedResourceId === resource.meta.id) {
        void get().pollResourceExtraction(resource.meta.id, resourceDetailRequestSeq)
      }
      return resource.meta.id
    } catch (err) {
      set({ listError: errMsg(err), isMutating: false })
      return null
    }
  },

  createResourceFromSession: async (data) => {
    set({ isMutating: true, listError: null })
    try {
      const { resource } = await securityApi.createResourceFromSession(data)
      set((state) => ({ resources: [resource.meta, ...state.resources], isMutating: false }))
      await get().selectResource(resource.meta.id)
      if (get().selectedResourceId === resource.meta.id) {
        void get().pollResourceExtraction(resource.meta.id, resourceDetailRequestSeq)
      }
      return resource.meta.id
    } catch (err) {
      set({ listError: errMsg(err), isMutating: false })
      return null
    }
  },

  updateResource: async (id, data) => {
    set({ isMutating: true })
    try {
      const { resource } = await securityApi.updateResource(id, data)
      set((state) => ({
        resources: state.resources.map((item) => item.id === id ? resource.meta : item),
        selectedResource: state.selectedResourceId === id ? resource : state.selectedResource,
        isMutating: false,
      }))
    } catch (err) {
      set({ detailError: errMsg(err), isMutating: false })
    }
  },

  deleteResource: async (id) => {
    set({ isMutating: true })
    try {
      await securityApi.deleteResource(id)
      set((state) => ({
        resources: state.resources.filter((item) => item.id !== id),
        selectedResourceId: state.selectedResourceId === id ? null : state.selectedResourceId,
        selectedResource: state.selectedResourceId === id ? null : state.selectedResource,
        sessionResourceIds: Object.fromEntries(
          Object.entries(state.sessionResourceIds).map(([sessionId, ids]) => [sessionId, ids.filter((item) => item !== id)]),
        ),
        sessionResources: Object.fromEntries(
          Object.entries(state.sessionResources).map(([sessionId, resources]) => [sessionId, resources.filter((item) => item.meta.id !== id)]),
        ),
        resourceExtractions: Object.fromEntries(Object.entries(state.resourceExtractions).filter(([resourceId]) => resourceId !== id)),
        resourceReferences: Object.fromEntries(Object.entries(state.resourceReferences).filter(([resourceId]) => resourceId !== id)),
        isMutating: false,
      }))
    } catch (err) {
      set({ listError: errMsg(err), isMutating: false })
    }
  },

  fetchResourceExtraction: async (id) => {
    try {
      const { extraction } = await securityApi.getResourceExtraction(id)
      set((state) => ({ resourceExtractions: { ...state.resourceExtractions, [id]: extraction } }))
    } catch (err) {
      set({ detailError: errMsg(err) })
    }
  },

  fetchResourceReferences: async (id) => {
    try {
      const { references } = await securityApi.getResourceReferences(id)
      set((state) => ({ resourceReferences: { ...state.resourceReferences, [id]: references } }))
    } catch (err) {
      set({ detailError: errMsg(err) })
    }
  },

  runResourceExtraction: async (id) => {
    set({ isMutating: true })
    try {
      const { extraction } = await securityApi.extractResource(id)
      const { references } = await securityApi.getResourceReferences(id)
      set((state) => ({
        resourceExtractions: { ...state.resourceExtractions, [id]: extraction },
        resourceReferences: { ...state.resourceReferences, [id]: references },
        isMutating: false,
      }))
      if (get().selectedResourceId === id) {
        void get().pollResourceExtraction(id, resourceDetailRequestSeq)
      }
    } catch (err) {
      set({ detailError: errMsg(err), isMutating: false })
    }
  },

  pollResourceExtraction: async (id, seq) => {
    for (let attempt = 0; attempt < RESOURCE_POLL_MAX_ATTEMPTS; attempt++) {
      await delay(RESOURCE_POLL_INTERVAL_MS)
      if (seq !== resourceDetailRequestSeq || get().selectedResourceId !== id) return
      try {
        const [{ extraction }, { references }] = await Promise.all([
          securityApi.getResourceExtraction(id),
          securityApi.getResourceReferences(id),
        ])
        if (seq !== resourceDetailRequestSeq || get().selectedResourceId !== id) return
        set((state) => ({
          resourceExtractions: { ...state.resourceExtractions, [id]: extraction },
          resourceReferences: { ...state.resourceReferences, [id]: references },
        }))
        const status = extraction?.status
        if (status === 'done' || status === 'waiting_for_permission' || status === 'failed' || status === 'idle') {
          return
        }
      } catch {
        // Single polling failure should not clear the selected resource.
      }
    }
  },

  updateResourceReference: async (id, referenceId, permissionStatus) => {
    set({ isMutating: true })
    try {
      const { reference } = await securityApi.updateResourceReference(id, referenceId, { permissionStatus })
      set((state) => ({
        resourceReferences: {
          ...state.resourceReferences,
          [id]: (state.resourceReferences[id] ?? []).map((item) => item.id === referenceId ? reference : item),
        },
        isMutating: false,
      }))
    } catch (err) {
      set({ detailError: errMsg(err), isMutating: false })
    }
  },

  readResourceReference: async (id, referenceId) => {
    set({ isMutating: true })
    try {
      const { extraction } = await securityApi.readResourceReference(id, referenceId)
      const { references } = await securityApi.getResourceReferences(id)
      set((state) => ({
        resourceExtractions: { ...state.resourceExtractions, [id]: extraction },
        resourceReferences: { ...state.resourceReferences, [id]: references },
        isMutating: false,
      }))
      if (get().selectedResourceId === id) {
        void get().pollResourceExtraction(id, resourceDetailRequestSeq)
      }
    } catch (err) {
      set({ detailError: errMsg(err), isMutating: false })
    }
  },

  fetchSessionResources: async (sessionId) => {
    try {
      const { resourceIds, resources } = await securityApi.getSessionResources(sessionId)
      set((state) => ({
        sessionResourceIds: { ...state.sessionResourceIds, [sessionId]: resourceIds },
        sessionResources: { ...state.sessionResources, [sessionId]: resources },
      }))
    } catch (err) {
      set({ detailError: errMsg(err) })
    }
  },

  setSessionResources: async (sessionId, resourceIds) => {
    set({ isMutating: true })
    try {
      const result = await securityApi.setSessionResources(sessionId, resourceIds)
      set((state) => ({
        sessionResourceIds: { ...state.sessionResourceIds, [sessionId]: result.resourceIds },
        sessionResources: { ...state.sessionResources, [sessionId]: result.resources },
        isMutating: false,
      }))
    } catch (err) {
      set({ detailError: errMsg(err), isMutating: false })
    }
  },

  fetchSessionTasks: async (sessionId) => {
    try {
      const { tasks } = await securityApi.getSessionTasks(sessionId)
      set((state) => ({
        sessionTasks: { ...state.sessionTasks, [sessionId]: tasks },
      }))
    } catch (err) {
      set({ detailError: errMsg(err) })
    }
  },

  fetchCategories: async () => {
    try {
      const { categories } = await securityApi.listCategories()
      set({ categories })
    } catch (err) {
      // 分类拉取失败不阻塞列表；保留已有（可能为空，前端有内置兜底）。
      set({ listError: errMsg(err) })
    }
  },

  addCategory: async (label, color) => {
    set({ isMutating: true })
    try {
      const { category } = await securityApi.addCategory({ label, color })
      set((state) => ({
        // 去重追加（同 id 不重复）。
        categories: state.categories.some((c) => c.id === category.id)
          ? state.categories
          : [...state.categories, category],
        isMutating: false,
      }))
      return category
    } catch (err) {
      set({ listError: errMsg(err), isMutating: false })
      return null
    }
  },

  removeCategory: async (id) => {
    set({ isMutating: true })
    try {
      await securityApi.removeCategory(id)
      set((state) => ({
        categories: state.categories.filter((c) => c.id !== id),
        // 占用该分类的项目后端已重置为 custom；本地同步避免重拉。
        projects: state.projects.map((p) => (p.category === id ? { ...p, category: 'custom' } : p)),
        isMutating: false,
      }))
    } catch (err) {
      set({ listError: errMsg(err), isMutating: false })
    }
  },

  selectProject: async (id) => {
    const seq = ++detailRequestSeq
    // Switch selection immediately; drop stale detail so the panel never shows the previous project.
    set({
      selectedProjectId: id,
      selectedProject: get().selectedProjectId === id ? get().selectedProject : null,
      sessionSummaries: get().selectedProjectId === id ? get().sessionSummaries : [],
      nodes: get().selectedProjectId === id ? get().nodes : [],
      hints: get().selectedProjectId === id ? get().hints : [],
      projectExtractionStatus: get().selectedProjectId === id ? get().projectExtractionStatus : null,
      isDetailLoading: true,
      detailError: null,
    })
    try {
      const { project, sessionSummaries, nodes, hints, extractionStatus } = await securityApi.get(id)
      if (seq !== detailRequestSeq) return
      set({ selectedProject: project, sessionSummaries: sessionSummaries ?? [], nodes: nodes ?? [], hints: hints ?? [], projectExtractionStatus: extractionStatus ?? null, isDetailLoading: false })
      // 有关联会话但还没节点 → D2 可能正在后台提炼，轮询拉取结果。
      const status = extractionStatus?.status
      if (status === 'queued' || status === 'running' || ((nodes ?? []).length === 0 && project.meta.sessionIds.length > 0)) {
        void get().pollForFindings(id, seq)
      }
    } catch (err) {
      if (seq !== detailRequestSeq) return
      set({ detailError: errMsg(err), isDetailLoading: false })
    }
  },

  pollForFindings: async (id, seq) => {
    set({ isExtracting: true })
    try {
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        await delay(POLL_INTERVAL_MS)
        // 用户已切走 / 重新加载，放弃本轮轮询。
        if (seq !== detailRequestSeq) return
        try {
          const { project, sessionSummaries, nodes, hints, extractionStatus } = await securityApi.get(id)
          if (seq !== detailRequestSeq) return
          set({ selectedProject: project, sessionSummaries: sessionSummaries ?? [], nodes: nodes ?? [], hints: hints ?? [], projectExtractionStatus: extractionStatus ?? null })
          const status = extractionStatus?.status
          if (status === 'done' || status === 'empty' || status === 'failed' || (nodes ?? []).length > 0) {
            return
          }
        } catch {
          // 单次失败不终止轮询
        }
      }
    } finally {
      if (seq === detailRequestSeq) set({ isExtracting: false })
    }
  },

  clearSelection: () => {
    detailRequestSeq++
    set({ selectedProjectId: null, selectedProject: null, sessionSummaries: [], nodes: [], hints: [], projectExtractionStatus: null, isDetailLoading: false, isExtracting: false, detailError: null })
  },

  reloadSelected: async () => {
    const id = get().selectedProjectId
    if (!id) return
    await get().selectProject(id)
  },

  createProject: async (data) => {
    set({ isMutating: true, listError: null })
    try {
      const { project } = await securityApi.create(data)
      set((state) => ({ projects: [...state.projects, project], isMutating: false }))
      await get().selectProject(project.id)
      return project.id
    } catch (err) {
      set({ listError: errMsg(err), isMutating: false })
      return null
    }
  },

  updateProject: async (id, data) => {
    set({ isMutating: true })
    try {
      await securityApi.update(id, data)
      // Optimistically patch the list entry so the rail reflects the change without a full refetch.
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === id ? { ...p, ...data, updatedAt: Date.now() } : p,
        ),
        selectedProject:
          state.selectedProject && state.selectedProject.meta.id === id
            ? { ...state.selectedProject, meta: { ...state.selectedProject.meta, ...data, updatedAt: Date.now() } }
            : state.selectedProject,
        isMutating: false,
      }))
    } catch (err) {
      set({ detailError: errMsg(err), isMutating: false })
      // Re-sync from server on failure so UI never drifts from persisted state.
      await get().fetchProjects()
    }
  },

  deleteProject: async (id) => {
    set({ isMutating: true })
    try {
      await securityApi.remove(id)
      set((state) => {
        const projects = state.projects.filter((p) => p.id !== id)
        const wasSelected = state.selectedProjectId === id
        return {
          projects,
          isMutating: false,
          selectedProjectId: wasSelected ? null : state.selectedProjectId,
          selectedProject: wasSelected ? null : state.selectedProject,
          detailError: wasSelected ? null : state.detailError,
        }
      })
    } catch (err) {
      set({ listError: errMsg(err), isMutating: false })
    }
  },

  refreshProject: async (id) => {
    set({ isMutating: true })
    try {
      await securityApi.refresh(id)
      set({ isMutating: false })
      if (get().selectedProjectId === id) {
        await get().reloadSelected()
      }
      await get().fetchProjects()
    } catch (err) {
      set({ detailError: errMsg(err), isMutating: false })
    }
  },

  linkSession: async (id, sessionId) => {
    set({ isMutating: true })
    try {
      await securityApi.linkSession(id, sessionId)
      set({ isMutating: false })
      if (get().selectedProjectId === id) {
        await get().reloadSelected()
      }
      await get().fetchProjects()
    } catch (err) {
      set({ detailError: errMsg(err), isMutating: false })
    }
  },

  addHint: async (id, content) => {
    const text = content.trim()
    if (!text) return
    set({ isMutating: true })
    try {
      const { hint } = await securityApi.addHint(id, text)
      // 仅当仍停在该项目时局部追加，避免整树重载抖动。
      set((state) => ({
        isMutating: false,
        hints: state.selectedProjectId === id ? [...state.hints, hint] : state.hints,
      }))
    } catch (err) {
      set({ detailError: errMsg(err), isMutating: false })
    }
  },
}))

export function statusLabel(status: ProjectStatus): string {
  return { active: 'active', paused: 'paused', completed: 'completed' }[status] ?? status
}
