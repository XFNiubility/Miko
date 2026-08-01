import { api } from './client'
import type { ResourceUpdateManifest, ResourceUpdateStatus } from '../types/resourceUpdate'

export const resourceUpdatesApi = {
  check: () =>
    api.get<ResourceUpdateManifest>('/api/updates/check', { timeout: 120_000 }),

  status: () =>
    api.get<ResourceUpdateStatus>('/api/updates/status', { timeout: 120_000 }),

  refresh: (manifestUrl?: string) =>
    api.post<ResourceUpdateManifest>(
      '/api/updates/refresh',
      manifestUrl ? { manifestUrl } : {},
      { timeout: 120_000 },
    ),

  apply: (resourceIds?: string[]) =>
    api.post<ResourceUpdateStatus>(
      '/api/updates/apply',
      resourceIds && resourceIds.length > 0 ? { resourceIds } : {},
      { timeout: 120_000 },
    ),

  rollback: () =>
    api.post<ResourceUpdateStatus>('/api/updates/rollback', {}, { timeout: 120_000 }),
}
