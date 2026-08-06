import { getConfiguredResourcePublicKeys } from './resourceSignature.js'

export type MarketplaceTrustSourceType = 'official' | 'local-dev' | 'custom'

export type MarketplaceTrustSource = {
  type: MarketplaceTrustSourceType
  label: string
  url: string
  requiresSignature: boolean
  allowUnsigned: boolean
  publicKeys: string[]
  publicKeySource: 'official' | 'configured' | 'none'
}

const BUILTIN_OFFICIAL_MARKETPLACE_CATALOG_URLS = ['http://8.134.211.101/catalog.json']

// Public verification keys only. The signing private key remains on the marketplace server.
const BUILTIN_OFFICIAL_RESOURCE_PUBLIC_KEYS = [
  'MCowBQYDK2VwAyEAO0UZPIYPEVuYWtjhR0X4+kCaxyf8HqlqBitAbnlS+Wg=',
]

function csvEnv(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

function getConfiguredOfficialPublicKeys(): string[] {
  return [
    process.env.KIMO_MARKETPLACE_OFFICIAL_PUBLIC_KEY?.trim(),
    process.env.MIKO_MARKETPLACE_OFFICIAL_PUBLIC_KEY?.trim(),
    ...csvEnv('KIMO_MARKETPLACE_OFFICIAL_PUBLIC_KEYS'),
    ...csvEnv('MIKO_MARKETPLACE_OFFICIAL_PUBLIC_KEYS'),
  ].filter((key): key is string => Boolean(key))
}

function getOfficialPublicKeys(): string[] {
  return [
    ...getConfiguredOfficialPublicKeys(),
    ...BUILTIN_OFFICIAL_RESOURCE_PUBLIC_KEYS,
  ]
}

function configuredOfficialCatalogUrls(): string[] {
  return [
    ...BUILTIN_OFFICIAL_MARKETPLACE_CATALOG_URLS,
    process.env.KIMO_MARKETPLACE_OFFICIAL_CATALOG_URL?.trim(),
    process.env.MIKO_MARKETPLACE_OFFICIAL_CATALOG_URL?.trim(),
    ...csvEnv('KIMO_MARKETPLACE_OFFICIAL_CATALOG_URLS'),
    ...csvEnv('MIKO_MARKETPLACE_OFFICIAL_CATALOG_URLS'),
  ].filter((value): value is string => Boolean(value))
}

function configuredOfficialHosts(): string[] {
  return [
    ...csvEnv('KIMO_MARKETPLACE_OFFICIAL_HOSTS'),
    ...csvEnv('MIKO_MARKETPLACE_OFFICIAL_HOSTS'),
  ].map(host => host.toLowerCase())
}

export function isLocalMarketplaceUrl(value: string): boolean {
  const parsed = new URL(value)
  const host = parsed.hostname.toLowerCase()
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host.endsWith('.localhost')
}

function isOfficialMarketplaceUrl(value: string): boolean {
  const parsed = new URL(value)
  const normalized = parsed.toString()
  if (configuredOfficialCatalogUrls().some(url => new URL(url).toString() === normalized)) {
    return true
  }

  const host = parsed.hostname.toLowerCase()
  return configuredOfficialHosts().some(officialHost => host === officialHost || host.endsWith(`.${officialHost}`))
}

export function allowsUnsignedCustomMarketplace(): boolean {
  const override = process.env.KIMO_MARKETPLACE_ALLOW_UNSIGNED_REMOTE?.trim().toLowerCase()
    || process.env.MIKO_MARKETPLACE_ALLOW_UNSIGNED_REMOTE?.trim().toLowerCase()
  return override === '1' || override === 'true' || override === 'yes'
}

export function resolveMarketplaceTrustSource(url: string): MarketplaceTrustSource {
  if (isLocalMarketplaceUrl(url)) {
    return {
      type: 'local-dev',
      label: 'Local development',
      url,
      requiresSignature: false,
      allowUnsigned: true,
      publicKeys: getConfiguredResourcePublicKeys(),
      publicKeySource: getConfiguredResourcePublicKeys().length > 0 ? 'configured' : 'none',
    }
  }

  if (isOfficialMarketplaceUrl(url)) {
    const publicKeys = getOfficialPublicKeys()
    return {
      type: 'official',
      label: 'Official',
      url,
      requiresSignature: true,
      allowUnsigned: false,
      publicKeys,
      publicKeySource: publicKeys.length > 0 ? 'official' : 'none',
    }
  }

  const publicKeys = getConfiguredResourcePublicKeys()
  return {
    type: 'custom',
    label: 'Custom',
    url,
    requiresSignature: true,
    allowUnsigned: allowsUnsignedCustomMarketplace(),
    publicKeys,
    publicKeySource: publicKeys.length > 0 ? 'configured' : 'none',
  }
}

export function getMarketplacePublicKeysForTrust(
  trust: { sourceType?: MarketplaceTrustSourceType; url?: string } | undefined,
): string[] {
  if (trust?.sourceType === 'official') return getOfficialPublicKeys()
  if (trust?.sourceType === 'local-dev' || trust?.sourceType === 'custom') return getConfiguredResourcePublicKeys()
  if (trust?.url) return resolveMarketplaceTrustSource(trust.url).publicKeys
  return getConfiguredResourcePublicKeys()
}
