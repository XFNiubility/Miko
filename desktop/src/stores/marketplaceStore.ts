import { create } from 'zustand'
import type { StoreApi } from 'zustand'
import { marketplaceApi } from '../api/marketplace'
import type {
  MarketplaceCatalog,
  MarketplaceInstallPreview,
  MarketplaceInstalledState,
  MarketplaceResource,
} from '../types/marketplace'

type MarketplaceStore = {
  catalog: MarketplaceCatalog | null
  installed: MarketplaceInstalledState | null
  isLoading: boolean
  isApplying: boolean
  activeOperationId: string | null
  error: string | null
  previewResource: (id: string) => Promise<MarketplaceInstallPreview>
  fetchMarketplace: () => Promise<void>
  refreshRemoteCatalog: () => Promise<void>
  installResource: (id: string) => Promise<void>
  uninstallResource: (id: string) => Promise<void>
  enableResource: (id: string) => Promise<void>
  disableResource: (id: string) => Promise<void>
}

type MarketplaceSet = StoreApi<MarketplaceStore>['setState']

async function withOperation(
  set: MarketplaceSet,
  id: string,
  operation: () => Promise<void>,
) {
  set({ isApplying: true, activeOperationId: id, error: null })
  try {
    await operation()
  } catch (error) {
    set({ error: error instanceof Error ? error.message : String(error) })
    throw error
  } finally {
    set({ isApplying: false, activeOperationId: null })
  }
}

export const useMarketplaceStore = create<MarketplaceStore>((set) => ({
  catalog: null,
  installed: null,
  isLoading: false,
  isApplying: false,
  activeOperationId: null,
  error: null,

  previewResource: async (id) => {
    set({ isApplying: true, activeOperationId: id, error: null })
    try {
      return await marketplaceApi.preview(id)
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      set({ isApplying: false, activeOperationId: null })
    }
  },

  fetchMarketplace: async () => {
    set({ isLoading: true, error: null })
    try {
      const [catalog, installed] = await Promise.all([
        marketplaceApi.catalog(),
        marketplaceApi.installed(),
      ])
      set({ catalog, installed, isLoading: false })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        isLoading: false,
      })
    }
  },

  refreshRemoteCatalog: async () => {
    set({ isLoading: true, error: null })
    try {
      const catalog = await marketplaceApi.refresh()
      const installed = await marketplaceApi.installed()
      set({ catalog, installed, isLoading: false })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        isLoading: false,
      })
      throw error
    }
  },

  installResource: async (id) => {
    await withOperation(set, id, async () => {
      const { installed } = await marketplaceApi.install(id)
      set((state) => ({
        installed: {
          schemaVersion: 1,
          installed: {
            ...(state.installed?.installed ?? {}),
            [id]: installed,
          },
        },
      }))
    })
  },

  uninstallResource: async (id) => {
    await withOperation(set, id, async () => {
      await marketplaceApi.uninstall(id)
      set((state) => {
        const next = { ...(state.installed?.installed ?? {}) }
        delete next[id]
        return {
          installed: {
            schemaVersion: 1,
            installed: next,
          },
        }
      })
    })
  },

  enableResource: async (id) => {
    await withOperation(set, id, async () => {
      const { installed } = await marketplaceApi.enable(id)
      set((state) => ({
        installed: {
          schemaVersion: 1,
          installed: {
            ...(state.installed?.installed ?? {}),
            [id]: installed,
          },
        },
      }))
    })
  },

  disableResource: async (id) => {
    await withOperation(set, id, async () => {
      const { installed } = await marketplaceApi.disable(id)
      set((state) => ({
        installed: {
          schemaVersion: 1,
          installed: {
            ...(state.installed?.installed ?? {}),
            [id]: installed,
          },
        },
      }))
    })
  },
}))

export function groupMarketplaceResources(resources: MarketplaceResource[]) {
  return resources.reduce<Record<MarketplaceResource['type'], MarketplaceResource[]>>(
    (groups, resource) => {
      groups[resource.type].push(resource)
      return groups
    },
    { skill: [], mcp: [], tool: [], agent: [] },
  )
}
