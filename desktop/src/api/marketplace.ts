import { api } from './client'
import type {
  InstalledMarketplaceResource,
  MarketplaceInstallPreview,
  MarketplaceCatalog,
  MarketplaceInstalledState,
} from '../types/marketplace'

export const marketplaceApi = {
  catalog: () =>
    api.get<MarketplaceCatalog>('/api/marketplace/catalog', { timeout: 120_000 }),

  installed: () =>
    api.get<MarketplaceInstalledState>('/api/marketplace/installed', { timeout: 120_000 }),

  refresh: (catalogUrl?: string) =>
    api.post<MarketplaceCatalog>(
      '/api/marketplace/refresh',
      catalogUrl ? { catalogUrl } : {},
      { timeout: 120_000 },
    ),

  install: (id: string) =>
    api.post<{ installed: InstalledMarketplaceResource }>(
      '/api/marketplace/install',
      { id },
      { timeout: 120_000 },
    ),

  preview: (id: string) =>
    api.post<MarketplaceInstallPreview>(
      '/api/marketplace/preview',
      { id },
      { timeout: 120_000 },
    ),

  uninstall: (id: string) =>
    api.post<{ ok: true }>('/api/marketplace/uninstall', { id }, { timeout: 120_000 }),

  enable: (id: string) =>
    api.post<{ installed: InstalledMarketplaceResource }>(
      '/api/marketplace/enable',
      { id },
      { timeout: 120_000 },
    ),

  disable: (id: string) =>
    api.post<{ installed: InstalledMarketplaceResource }>(
      '/api/marketplace/disable',
      { id },
      { timeout: 120_000 },
    ),
}
