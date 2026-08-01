export type MarketplaceResourceType = 'skill' | 'mcp' | 'tool' | 'agent'

export type MarketplaceResource = {
  id: string
  type: MarketplaceResourceType
  name: string
  version: string
  category?: string
  description?: string
  packagePath?: string
  packageUrl?: string
  sha256?: string
  signature?: string
  minMikoVersion?: string
  permissions?: string[]
}

export type MarketplaceCatalog = {
  schemaVersion: 1
  source: 'local' | 'cache' | 'bundled' | 'empty'
  generatedAt?: string
  verification?: {
    signature: 'missing' | 'verified'
  }
  trust?: {
    sourceType: 'official' | 'local-dev' | 'custom'
    label: string
    url?: string
    requiresSignature: boolean
    publicKeySource: 'official' | 'configured' | 'none'
  }
  resources: MarketplaceResource[]
}

export type InstalledMarketplaceResource = {
  id: string
  type: MarketplaceResourceType
  name: string
  version: string
  enabled: boolean
  origin: 'marketplace'
  packagePath: string
  installedAt: string
  updatedAt?: string
  userModified?: boolean
  mcpServers?: string[]
  mcpServerHashes?: Record<string, string>
}

export type MarketplaceInstalledState = {
  schemaVersion: 1
  installed: Record<string, InstalledMarketplaceResource>
}

export type MarketplaceInstallPreview = {
  resource: MarketplaceResource
  operation: 'install' | 'update'
  targetPackagePath: string
  writes: string[]
  permissions: string[]
  verification: {
    sha256: 'present' | 'missing'
    signature: 'present' | 'missing'
  }
  mcpServers?: Array<{
    name: string
    type: string
    command?: string
    args?: string[]
    envKeys?: string[]
    url?: string
  }>
}
