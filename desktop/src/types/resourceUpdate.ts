export type ResourceUpdateType = 'builtin-bundle' | 'marketplace-catalog'

export type ResourceUpdateManifest = {
  schemaVersion: 1
  source: 'local' | 'cache' | 'empty'
  generatedAt?: string
  currentVersion: string
  latestVersion?: string
  channel?: string
  notes?: string
  packageUrl?: string
  sha256?: string
  signature?: string
  bundledDataVersion?: string
  resources?: Array<{
    id: string
    type: ResourceUpdateType
    version: string
    packageUrl?: string
    sha256?: string
    signature?: string
  }>
}

export type ResourceUpdateStatus = {
  schemaVersion: 1
  state: 'idle' | 'refreshed' | 'applying' | 'applied' | 'rolled-back' | 'error'
  updatedAt?: string
  manifest?: ResourceUpdateManifest
  appliedResources?: Array<{
    id: string
    type: ResourceUpdateType
    version: string
  }>
  error?: string
}
