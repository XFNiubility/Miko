import { create } from 'zustand'
import { resourceUpdatesApi } from '../api/updates'
import type { ResourceUpdateManifest, ResourceUpdateStatus } from '../types/resourceUpdate'

type ResourceUpdateStore = {
  manifest: ResourceUpdateManifest | null
  status: ResourceUpdateStatus | null
  isLoading: boolean
  isRefreshing: boolean
  isApplying: boolean
  isRollingBack: boolean
  error: string | null
  fetchStatus: () => Promise<void>
  refreshManifest: () => Promise<ResourceUpdateManifest>
  applyUpdates: () => Promise<ResourceUpdateStatus>
  rollbackUpdates: () => Promise<ResourceUpdateStatus>
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useResourceUpdateStore = create<ResourceUpdateStore>((set) => ({
  manifest: null,
  status: null,
  isLoading: false,
  isRefreshing: false,
  isApplying: false,
  isRollingBack: false,
  error: null,

  fetchStatus: async () => {
    set({ isLoading: true, error: null })
    try {
      const status = await resourceUpdatesApi.status()
      set({ status, manifest: status.manifest ?? null, isLoading: false })
    } catch (error) {
      set({ error: getErrorMessage(error), isLoading: false })
    }
  },

  refreshManifest: async () => {
    set({ isRefreshing: true, error: null })
    try {
      const manifest = await resourceUpdatesApi.refresh()
      const status = await resourceUpdatesApi.status()
      set({ manifest, status, isRefreshing: false })
      return manifest
    } catch (error) {
      set({ error: getErrorMessage(error), isRefreshing: false })
      throw error
    }
  },

  applyUpdates: async () => {
    set({ isApplying: true, error: null })
    try {
      const status = await resourceUpdatesApi.apply()
      set({ status, manifest: status.manifest ?? null, isApplying: false })
      return status
    } catch (error) {
      set({ error: getErrorMessage(error), isApplying: false })
      throw error
    }
  },

  rollbackUpdates: async () => {
    set({ isRollingBack: true, error: null })
    try {
      const status = await resourceUpdatesApi.rollback()
      set({ status, manifest: status.manifest ?? null, isRollingBack: false })
      return status
    } catch (error) {
      set({ error: getErrorMessage(error), isRollingBack: false })
      throw error
    }
  },
}))
