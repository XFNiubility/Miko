import { afterEach, describe, expect, it } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getMcpFile, resetDataDirForTests, setDataDir } from '../utils/kimoPaths.js'
import { canonicalizeSignedJson } from './resourceSignature.js'
import {
  getInstalledMarketplaceSkillLocations,
  getMarketplaceInstallPreview,
  getMarketplaceCatalog,
  getMarketplaceInstalled,
  installMarketplaceResource,
  refreshMarketplaceCatalog,
  setMarketplaceResourceEnabled,
  uninstallMarketplaceResource,
} from './marketplaceService.js'
import { checkLocalUpdateManifest } from './updateService.js'

const tempDirs: string[] = []
const originalBundledRoot = process.env.KIMO_BUNDLED_DATA_ROOT
const originalMarketplaceCatalogUrl = process.env.KIMO_MARKETPLACE_CATALOG_URL
const originalMarketplaceAllowUnsignedRemote = process.env.KIMO_MARKETPLACE_ALLOW_UNSIGNED_REMOTE
const originalMarketplaceOfficialCatalogUrl = process.env.KIMO_MARKETPLACE_OFFICIAL_CATALOG_URL
const originalMarketplaceOfficialHosts = process.env.KIMO_MARKETPLACE_OFFICIAL_HOSTS
const originalMarketplaceOfficialPublicKey = process.env.KIMO_MARKETPLACE_OFFICIAL_PUBLIC_KEY
const originalResourceSignaturePublicKey = process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY
const originalResourceSignaturePrivateKey = process.env.KIMO_RESOURCE_SIGNATURE_PRIVATE_KEY
const originalFetch = globalThis.fetch

async function makeDataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'miko-marketplace-'))
  const dataDir = join(root, 'data')
  tempDirs.push(root)
  setDataDir(dataDir)
  await mkdir(dataDir, { recursive: true })
  return dataDir
}

async function makeZip(files: Record<string, string>): Promise<Uint8Array> {
  const { zipSync } = await import('fflate')
  return zipSync(Object.fromEntries(
    Object.entries(files).map(([name, content]) => [name, new TextEncoder().encode(content)]),
  ))
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function signResource(data: Uint8Array): { publicKey: string; signature: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signature = sign(null, Buffer.from(data), privateKey).toString('base64')
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).toString('base64'),
    signature: `ed25519:${signature}`,
  }
}

function makeResourceSigner(): { publicKey: string; signData: (data: Uint8Array) => string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).toString('base64'),
    signData: (data) => `ed25519:${sign(null, Buffer.from(data), privateKey).toString('base64')}`,
  }
}

async function writeLocalMarketplaceCatalog(dataDir: string, resources: unknown[]) {
  const marketplaceDir = join(dataDir, 'marketplace')
  await mkdir(marketplaceDir, { recursive: true })
  await writeFile(
    join(marketplaceDir, 'catalog.local.json'),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-07-27T00:00:00.000Z',
      resources,
    }),
    'utf-8',
  )
}

async function writeLocalMcpPackage(
  packagePath: string,
  resource: { id: string; name: string; version: string },
  mcpServers: Record<string, unknown>,
) {
  await mkdir(packagePath, { recursive: true })
  await writeFile(
    join(packagePath, 'resource.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: resource.id,
      type: 'mcp',
      name: resource.name,
      version: resource.version,
    }),
    'utf-8',
  )
  await writeFile(
    join(packagePath, 'mcp.json'),
    JSON.stringify({ mcpServers }),
    'utf-8',
  )
}

afterEach(async () => {
  resetDataDirForTests()
  if (originalBundledRoot === undefined) {
    delete process.env.KIMO_BUNDLED_DATA_ROOT
  } else {
    process.env.KIMO_BUNDLED_DATA_ROOT = originalBundledRoot
  }
  if (originalMarketplaceCatalogUrl === undefined) {
    delete process.env.KIMO_MARKETPLACE_CATALOG_URL
  } else {
    process.env.KIMO_MARKETPLACE_CATALOG_URL = originalMarketplaceCatalogUrl
  }
  if (originalMarketplaceAllowUnsignedRemote === undefined) {
    delete process.env.KIMO_MARKETPLACE_ALLOW_UNSIGNED_REMOTE
  } else {
    process.env.KIMO_MARKETPLACE_ALLOW_UNSIGNED_REMOTE = originalMarketplaceAllowUnsignedRemote
  }
  if (originalMarketplaceOfficialCatalogUrl === undefined) {
    delete process.env.KIMO_MARKETPLACE_OFFICIAL_CATALOG_URL
  } else {
    process.env.KIMO_MARKETPLACE_OFFICIAL_CATALOG_URL = originalMarketplaceOfficialCatalogUrl
  }
  if (originalMarketplaceOfficialHosts === undefined) {
    delete process.env.KIMO_MARKETPLACE_OFFICIAL_HOSTS
  } else {
    process.env.KIMO_MARKETPLACE_OFFICIAL_HOSTS = originalMarketplaceOfficialHosts
  }
  if (originalMarketplaceOfficialPublicKey === undefined) {
    delete process.env.KIMO_MARKETPLACE_OFFICIAL_PUBLIC_KEY
  } else {
    process.env.KIMO_MARKETPLACE_OFFICIAL_PUBLIC_KEY = originalMarketplaceOfficialPublicKey
  }
  if (originalResourceSignaturePublicKey === undefined) {
    delete process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY
  } else {
    process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY = originalResourceSignaturePublicKey
  }
  if (originalResourceSignaturePrivateKey === undefined) {
    delete process.env.KIMO_RESOURCE_SIGNATURE_PRIVATE_KEY
  } else {
    process.env.KIMO_RESOURCE_SIGNATURE_PRIVATE_KEY = originalResourceSignaturePrivateKey
  }
  globalThis.fetch = originalFetch
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('marketplaceService', () => {
  it('returns empty catalog and install state when marketplace files are absent', async () => {
    await makeDataRoot()

    await expect(getMarketplaceCatalog()).resolves.toEqual({
      schemaVersion: 1,
      source: 'empty',
      resources: [],
    })
    await expect(getMarketplaceInstalled()).resolves.toEqual({
      schemaVersion: 1,
      installed: {},
    })
  })

  it('uses the formal local marketplace catalog URL when no override is provided', async () => {
    await makeDataRoot()
    delete process.env.KIMO_MARKETPLACE_CATALOG_URL
    const requests: string[] = []

    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      requests.push(url)
      return new Response(JSON.stringify({ schemaVersion: 1, resources: [] }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    await expect(refreshMarketplaceCatalog()).resolves.toMatchObject({
      schemaVersion: 1,
      source: 'cache',
      resources: [],
    })
    expect(requests).toEqual(['http://127.0.0.1:8788/catalog.json'])
  })

  it('requires a catalog signature for non-local marketplace sources by default', async () => {
    const dataDir = await makeDataRoot()

    globalThis.fetch = (async () => new Response(JSON.stringify({
      schemaVersion: 1,
      resources: [{
        id: 'skill.unsigned-remote',
        type: 'skill',
        name: 'unsigned-remote',
        version: '1.0.0',
      }],
    }), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

    await expect(refreshMarketplaceCatalog('https://market.example.com/catalog.json')).rejects.toThrow(
      'catalog signature is required for non-local source',
    )
    await expect(readFile(join(dataDir, 'marketplace', 'catalog-cache.json'), 'utf-8')).rejects.toThrow()
  })

  it('allows unsigned non-local catalogs only when the development override is explicit', async () => {
    await makeDataRoot()
    process.env.KIMO_MARKETPLACE_ALLOW_UNSIGNED_REMOTE = '1'

    globalThis.fetch = (async () => new Response(JSON.stringify({
      schemaVersion: 1,
      resources: [{
        id: 'skill.unsigned-override',
        type: 'skill',
        name: 'unsigned-override',
        version: '1.0.0',
      }],
    }), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

    await expect(refreshMarketplaceCatalog('https://market.example.com/catalog.json')).resolves.toMatchObject({
      source: 'cache',
      verification: { signature: 'missing' },
      resources: [{ id: 'skill.unsigned-override' }],
    })
  })

  it('uses the official marketplace public key for catalog and package verification', async () => {
    const dataDir = await makeDataRoot()
    delete process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY
    const signer = makeResourceSigner()
    process.env.KIMO_MARKETPLACE_OFFICIAL_CATALOG_URL = 'https://market.example.com/catalog.json'
    process.env.KIMO_MARKETPLACE_OFFICIAL_PUBLIC_KEY = signer.publicKey

    const zipData = await makeZip({
      'resource.json': JSON.stringify({
        schemaVersion: 1,
        id: 'skill.official-signed',
        type: 'skill',
        name: 'official-signed',
        version: '1.0.0',
      }),
      'SKILL.md': [
        '---',
        'name: Official Signed',
        'description: Official signed marketplace skill',
        'version: 1.0.0',
        '---',
        'Run official signed marketplace skill.',
      ].join('\n'),
    })
    const catalogBody = JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-07-28T00:00:00.000Z',
      resources: [{
        id: 'skill.official-signed',
        type: 'skill',
        name: 'official-signed',
        version: '1.0.0',
        packageUrl: 'https://market.example.com/packages/skill.official-signed/1.0.0/package.zip',
        sha256: sha256(zipData),
        signature: signer.signData(zipData),
      }],
    })
    const catalogSignature = signer.signData(new TextEncoder().encode(catalogBody))

    globalThis.fetch = (async (input) => {
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      const url = new URL(rawUrl)
      if (url.pathname === '/catalog.json') {
        return new Response(catalogBody, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-miko-catalog-signature': catalogSignature,
          },
        })
      }
      if (url.pathname === '/packages/skill.official-signed/1.0.0/package.zip') {
        return new Response(zipData, { headers: { 'content-type': 'application/zip' } })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    await expect(refreshMarketplaceCatalog('https://market.example.com/catalog.json')).resolves.toMatchObject({
      source: 'cache',
      verification: { signature: 'verified' },
      trust: {
        sourceType: 'official',
        requiresSignature: true,
        publicKeySource: 'official',
      },
      resources: [{ id: 'skill.official-signed' }],
    })

    await installMarketplaceResource('skill.official-signed')
    await expect(
      readFile(join(dataDir, 'marketplace', 'packages', 'skill.official-signed', '1.0.0', 'SKILL.md'), 'utf-8'),
    ).resolves.toContain('Official signed marketplace skill')
  })

  it('does not trust the official public key for custom marketplace sources', async () => {
    await makeDataRoot()
    const signer = makeResourceSigner()
    process.env.KIMO_MARKETPLACE_OFFICIAL_CATALOG_URL = 'https://official.example.com/catalog.json'
    process.env.KIMO_MARKETPLACE_OFFICIAL_PUBLIC_KEY = signer.publicKey
    delete process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY

    const catalogBody = JSON.stringify({
      schemaVersion: 1,
      resources: [{
        id: 'skill.custom-wrong-key',
        type: 'skill',
        name: 'custom-wrong-key',
        version: '1.0.0',
      }],
    })
    const catalogSignature = signer.signData(new TextEncoder().encode(catalogBody))

    globalThis.fetch = (async () => new Response(catalogBody, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-miko-catalog-signature': catalogSignature,
      },
    })) as typeof fetch

    await expect(refreshMarketplaceCatalog('https://custom.example.com/catalog.json')).rejects.toThrow(
      'no trusted public key is configured',
    )
  })

  it('installs, disables, enables, and uninstalls a local skill package without touching user skills', async () => {
    const dataDir = await makeDataRoot()
    const packageSource = join(dataDir, 'local-source', 'web-helper')
    await mkdir(packageSource, { recursive: true })
    await writeFile(
      join(packageSource, 'SKILL.md'),
      [
        '---',
        'name: Web Helper',
        'description: Local marketplace skill',
        'version: 1.0.0',
        '---',
        'Run local marketplace skill.',
      ].join('\n'),
      'utf-8',
    )

    const marketplaceDir = join(dataDir, 'marketplace')
    await mkdir(marketplaceDir, { recursive: true })
    await writeFile(
      join(marketplaceDir, 'catalog.local.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-07-25T00:00:00.000Z',
        resources: [{
          id: 'skill.web-helper',
          type: 'skill',
          name: 'web-helper',
          version: '1.0.0',
          category: 'web',
          description: 'Local marketplace skill',
          packagePath: packageSource,
          permissions: ['network'],
        }],
      }),
      'utf-8',
    )

    const installed = await installMarketplaceResource('skill.web-helper')
    expect(installed).toMatchObject({
      id: 'skill.web-helper',
      type: 'skill',
      name: 'web-helper',
      version: '1.0.0',
      enabled: true,
      origin: 'marketplace',
    })

    const copiedSkill = join(dataDir, 'marketplace', 'packages', 'skill.web-helper', '1.0.0', 'SKILL.md')
    await expect(readFile(copiedSkill, 'utf-8')).resolves.toContain('Local marketplace skill')
    await expect(readFile(join(dataDir, 'skills', 'web-helper', 'SKILL.md'), 'utf-8')).rejects.toThrow()

    await expect(getInstalledMarketplaceSkillLocations()).resolves.toEqual([{
      packageId: 'skill.web-helper',
      name: 'web-helper',
      version: '1.0.0',
      skillDir: join(dataDir, 'marketplace', 'packages', 'skill.web-helper', '1.0.0'),
    }])

    await setMarketplaceResourceEnabled('skill.web-helper', false)
    await expect(getInstalledMarketplaceSkillLocations()).resolves.toEqual([])

    await setMarketplaceResourceEnabled('skill.web-helper', true)
    expect(await getInstalledMarketplaceSkillLocations()).toHaveLength(1)

    await uninstallMarketplaceResource('skill.web-helper')
    await expect(getMarketplaceInstalled()).resolves.toEqual({
      schemaVersion: 1,
      installed: {},
    })
  })

  it('falls back to bundled marketplace catalog and installs into user marketplace state', async () => {
    const dataDir = await makeDataRoot()
    const root = await mkdtemp(join(tmpdir(), 'miko-bundled-marketplace-'))
    tempDirs.push(root)
    const bundledRoot = join(root, 'bundled-data')
    process.env.KIMO_BUNDLED_DATA_ROOT = bundledRoot

    const packageSource = join(bundledRoot, 'marketplace', 'local-packages', 'skill.demo', '1.0.0')
    await mkdir(packageSource, { recursive: true })
    await writeFile(
      join(packageSource, 'SKILL.md'),
      [
        '---',
        'name: Demo Skill',
        'description: Bundled marketplace skill',
        'version: 1.0.0',
        '---',
        'Run bundled marketplace skill.',
      ].join('\n'),
      'utf-8',
    )
    await writeFile(
      join(bundledRoot, 'marketplace', 'catalog.local.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-07-25T00:00:00.000Z',
        resources: [{
          id: 'skill.demo',
          type: 'skill',
          name: 'demo-skill',
          version: '1.0.0',
          description: 'Bundled marketplace skill',
          packagePath: 'local-packages/skill.demo/1.0.0',
        }],
      }),
      'utf-8',
    )

    await expect(getMarketplaceCatalog()).resolves.toMatchObject({
      schemaVersion: 1,
      source: 'bundled',
      resources: [{
        id: 'skill.demo',
        type: 'skill',
        name: 'demo-skill',
        version: '1.0.0',
      }],
    })

    await installMarketplaceResource('skill.demo')

    const copiedSkill = join(dataDir, 'marketplace', 'packages', 'skill.demo', '1.0.0', 'SKILL.md')
    await expect(readFile(copiedSkill, 'utf-8')).resolves.toContain('Bundled marketplace skill')
    await expect(readFile(join(dataDir, 'marketplace', 'installed.json'), 'utf-8')).resolves.toContain('skill.demo')
  })

  it('updates an installed skill to the catalog version and removes the old package copy', async () => {
    const dataDir = await makeDataRoot()
    const packageV1 = join(dataDir, 'local-source', 'skill.updatable', '1.0.0')
    const packageV2 = join(dataDir, 'local-source', 'skill.updatable', '2.0.0')
    await mkdir(packageV1, { recursive: true })
    await writeFile(
      join(packageV1, 'SKILL.md'),
      [
        '---',
        'name: Updatable',
        'description: Updatable skill v1',
        'version: 1.0.0',
        '---',
        'Run v1.',
      ].join('\n'),
      'utf-8',
    )
    await writeLocalMarketplaceCatalog(dataDir, [{
      id: 'skill.updatable',
      type: 'skill',
      name: 'updatable',
      version: '1.0.0',
      packagePath: packageV1,
    }])

    const firstInstall = await installMarketplaceResource('skill.updatable')
    expect(firstInstall.version).toBe('1.0.0')
    const copiedV1 = join(dataDir, 'marketplace', 'packages', 'skill.updatable', '1.0.0', 'SKILL.md')
    await expect(readFile(copiedV1, 'utf-8')).resolves.toContain('Run v1.')

    await mkdir(packageV2, { recursive: true })
    await writeFile(
      join(packageV2, 'SKILL.md'),
      [
        '---',
        'name: Updatable',
        'description: Updatable skill v2',
        'version: 2.0.0',
        '---',
        'Run v2.',
      ].join('\n'),
      'utf-8',
    )
    await writeLocalMarketplaceCatalog(dataDir, [{
      id: 'skill.updatable',
      type: 'skill',
      name: 'updatable',
      version: '2.0.0',
      packagePath: packageV2,
    }])

    const updated = await installMarketplaceResource('skill.updatable')
    expect(updated).toMatchObject({
      id: 'skill.updatable',
      version: '2.0.0',
      installedAt: firstInstall.installedAt,
    })
    expect(updated.updatedAt).toBeTruthy()

    const copiedV2 = join(dataDir, 'marketplace', 'packages', 'skill.updatable', '2.0.0', 'SKILL.md')
    await expect(readFile(copiedV2, 'utf-8')).resolves.toContain('Run v2.')
    await expect(readFile(copiedV1, 'utf-8')).rejects.toThrow()
  })

  it('refreshes a URL catalog and installs a remote directory package into user marketplace state', async () => {
    const dataDir = await makeDataRoot()
    const files = new Map<string, string>([
      ['/packages/skill.remote-demo/1.0.0/SKILL.md', [
        '---',
        'name: Remote Demo',
        'description: Remote marketplace skill',
        'version: 1.0.0',
        '---',
        'Run remote marketplace skill.',
      ].join('\n')],
    ])
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        const origin = url.origin

        if (url.pathname === '/catalog.json') {
          return Response.json({
            schemaVersion: 1,
            generatedAt: '2026-07-26T00:00:00.000Z',
            resources: [{
              id: 'skill.remote-demo',
              type: 'skill',
              name: 'remote-demo',
              version: '1.0.0',
              description: 'Remote marketplace skill',
              packageUrl: `${origin}/packages/skill.remote-demo/1.0.0`,
              permissions: ['network'],
            }],
          })
        }

        if (url.pathname === '/packages/skill.remote-demo/1.0.0') {
          return Response.json({
            name: '1.0.0',
            type: 'directory',
            entries: [{
              name: 'SKILL.md',
              type: 'file',
              url: '/packages/skill.remote-demo/1.0.0/SKILL.md',
            }],
          })
        }

        const file = files.get(url.pathname)
        if (file) return new Response(file, { headers: { 'content-type': 'text/markdown; charset=utf-8' } })

        return new Response('not found', { status: 404 })
      },
    })

    try {
      await expect(refreshMarketplaceCatalog(`${server.url}catalog.json`)).resolves.toMatchObject({
        schemaVersion: 1,
        source: 'cache',
        resources: [{
          id: 'skill.remote-demo',
          type: 'skill',
          name: 'remote-demo',
          version: '1.0.0',
        }],
      })

      await expect(readFile(join(dataDir, 'marketplace', 'catalog-cache.json'), 'utf-8')).resolves.toContain('skill.remote-demo')
      await installMarketplaceResource('skill.remote-demo')

      const copiedSkill = join(dataDir, 'marketplace', 'packages', 'skill.remote-demo', '1.0.0', 'SKILL.md')
      await expect(readFile(copiedSkill, 'utf-8')).resolves.toContain('Remote marketplace skill')
      await expect(getInstalledMarketplaceSkillLocations()).resolves.toEqual([{
        packageId: 'skill.remote-demo',
        name: 'remote-demo',
        version: '1.0.0',
        skillDir: join(dataDir, 'marketplace', 'packages', 'skill.remote-demo', '1.0.0'),
      }])
    } finally {
      server.stop(true)
    }
  })

  it('refreshes a catalog signed through the response header before writing cache', async () => {
    const dataDir = await makeDataRoot()
    const catalogBody = JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-07-28T00:00:00.000Z',
      resources: [{
        id: 'skill.signed-catalog-header',
        type: 'skill',
        name: 'signed-catalog-header',
        version: '1.0.0',
        packageUrl: 'https://market.example.com/packages/skill.signed-catalog-header/1.0.0/package.zip',
      }],
    })
    const bodyBytes = new TextEncoder().encode(catalogBody)
    const signed = signResource(bodyBytes)
    process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY = signed.publicKey

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/catalog.json') {
          return new Response(catalogBody, {
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'x-miko-catalog-signature': signed.signature,
            },
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await expect(refreshMarketplaceCatalog(`${server.url}catalog.json`)).resolves.toMatchObject({
        source: 'cache',
        verification: { signature: 'verified' },
        resources: [{ id: 'skill.signed-catalog-header' }],
      })
      const cache = JSON.parse(await readFile(join(dataDir, 'marketplace', 'catalog-cache.json'), 'utf-8'))
      expect(cache.verification).toEqual({ signature: 'verified' })
      expect(cache.signature).toBeUndefined()
    } finally {
      server.stop(true)
    }
  })

  it('refreshes a catalog with an embedded JSON signature for static hosting', async () => {
    const dataDir = await makeDataRoot()
    const catalog = {
      schemaVersion: 1,
      generatedAt: '2026-07-28T00:00:00.000Z',
      resources: [{
        id: 'skill.signed-catalog-body',
        type: 'skill',
        name: 'signed-catalog-body',
        version: '1.0.0',
        packageUrl: 'https://market.example.com/packages/skill.signed-catalog-body/1.0.0/package.zip',
      }],
    }
    const signed = signResource(new TextEncoder().encode(canonicalizeSignedJson(catalog)))
    process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY = signed.publicKey

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/catalog.json') {
          return Response.json({
            ...catalog,
            signature: signed.signature,
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await expect(refreshMarketplaceCatalog(`${server.url}catalog.json`)).resolves.toMatchObject({
        source: 'cache',
        verification: { signature: 'verified' },
        resources: [{ id: 'skill.signed-catalog-body' }],
      })
      const cache = JSON.parse(await readFile(join(dataDir, 'marketplace', 'catalog-cache.json'), 'utf-8'))
      expect(cache.verification).toEqual({ signature: 'verified' })
      expect(cache.resources[0].id).toBe('skill.signed-catalog-body')
    } finally {
      server.stop(true)
    }
  })

  it('rejects a tampered signed catalog without replacing the cached catalog', async () => {
    const dataDir = await makeDataRoot()
    await mkdir(join(dataDir, 'marketplace'), { recursive: true })
    await writeFile(
      join(dataDir, 'marketplace', 'catalog-cache.json'),
      JSON.stringify({
        schemaVersion: 1,
        source: 'cache',
        generatedAt: '2026-07-27T00:00:00.000Z',
        verification: { signature: 'verified' },
        resources: [{
          id: 'skill.previous-cache',
          type: 'skill',
          name: 'previous-cache',
          version: '1.0.0',
        }],
      }),
      'utf-8',
    )

    const originalCatalog = {
      schemaVersion: 1,
      resources: [{
        id: 'skill.original',
        type: 'skill',
        name: 'original',
        version: '1.0.0',
      }],
    }
    const tamperedCatalog = {
      schemaVersion: 1,
      resources: [{
        id: 'skill.tampered',
        type: 'skill',
        name: 'tampered',
        version: '1.0.0',
      }],
    }
    const signed = signResource(new TextEncoder().encode(canonicalizeSignedJson(originalCatalog)))
    process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY = signed.publicKey

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/catalog.json') {
          return Response.json({
            ...tamperedCatalog,
            signature: signed.signature,
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await expect(refreshMarketplaceCatalog(`${server.url}catalog.json`)).rejects.toThrow('signature verification failed')
      const cache = JSON.parse(await readFile(join(dataDir, 'marketplace', 'catalog-cache.json'), 'utf-8'))
      expect(cache.resources[0].id).toBe('skill.previous-cache')
    } finally {
      server.stop(true)
    }
  })

  it('refreshes a URL catalog and installs a verified zip package into user marketplace state', async () => {
    const dataDir = await makeDataRoot()
    const zipData = await makeZip({
      'resource.json': JSON.stringify({
        schemaVersion: 1,
        id: 'skill.remote-zip',
        type: 'skill',
        name: 'remote-zip',
        version: '1.0.0',
        description: 'Remote zip marketplace skill',
      }),
      'SKILL.md': [
        '---',
        'name: Remote Zip',
        'description: Remote zip marketplace skill',
        'version: 1.0.0',
        '---',
        'Run remote zip marketplace skill.',
      ].join('\n'),
    })

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        const origin = url.origin
        if (url.pathname === '/catalog.json') {
          return Response.json({
            schemaVersion: 1,
            generatedAt: '2026-07-26T00:00:00.000Z',
            resources: [{
              id: 'skill.remote-zip',
              type: 'skill',
              name: 'remote-zip',
              version: '1.0.0',
              description: 'Remote zip marketplace skill',
              packageUrl: `${origin}/packages/skill.remote-zip/1.0.0/package.zip`,
              sha256: sha256(zipData),
            }],
          })
        }
        if (url.pathname === '/packages/skill.remote-zip/1.0.0/package.zip') {
          return new Response(zipData, { headers: { 'content-type': 'application/zip' } })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await refreshMarketplaceCatalog(`${server.url}catalog.json`)
      await installMarketplaceResource('skill.remote-zip')

      const copiedSkill = join(dataDir, 'marketplace', 'packages', 'skill.remote-zip', '1.0.0', 'SKILL.md')
      await expect(readFile(copiedSkill, 'utf-8')).resolves.toContain('Remote zip marketplace skill')
      await expect(readFile(join(dataDir, 'marketplace', 'packages', 'skill.remote-zip', '1.0.0', 'resource.json'), 'utf-8')).resolves.toContain('skill.remote-zip')
      await expect(getInstalledMarketplaceSkillLocations()).resolves.toEqual([{
        packageId: 'skill.remote-zip',
        name: 'remote-zip',
        version: '1.0.0',
        skillDir: join(dataDir, 'marketplace', 'packages', 'skill.remote-zip', '1.0.0'),
      }])
    } finally {
      server.stop(true)
    }
  })

  it('installs a signed zip package when the configured resource public key verifies it', async () => {
    const dataDir = await makeDataRoot()
    const zipData = await makeZip({
      'resource.json': JSON.stringify({
        schemaVersion: 1,
        id: 'skill.signed-zip',
        type: 'skill',
        name: 'signed-zip',
        version: '1.0.0',
      }),
      'SKILL.md': [
        '---',
        'name: Signed Zip',
        'description: Signed marketplace skill',
        'version: 1.0.0',
        '---',
        'Run signed marketplace skill.',
      ].join('\n'),
    })
    const signed = signResource(zipData)
    process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY = signed.publicKey

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        const origin = url.origin
        if (url.pathname === '/catalog.json') {
          return Response.json({
            schemaVersion: 1,
            resources: [{
              id: 'skill.signed-zip',
              type: 'skill',
              name: 'signed-zip',
              version: '1.0.0',
              packageUrl: `${origin}/packages/skill.signed-zip/1.0.0/package.zip`,
              sha256: sha256(zipData),
              signature: signed.signature,
            }],
          })
        }
        if (url.pathname === '/packages/skill.signed-zip/1.0.0/package.zip') {
          return new Response(zipData, { headers: { 'content-type': 'application/zip' } })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await refreshMarketplaceCatalog(`${server.url}catalog.json`)
      await installMarketplaceResource('skill.signed-zip')

      await expect(
        readFile(join(dataDir, 'marketplace', 'packages', 'skill.signed-zip', '1.0.0', 'SKILL.md'), 'utf-8'),
      ).resolves.toContain('Signed marketplace skill')
    } finally {
      server.stop(true)
    }
  })

  it('rejects a signed zip package when signature verification fails', async () => {
    const dataDir = await makeDataRoot()
    const zipData = await makeZip({
      'resource.json': JSON.stringify({
        schemaVersion: 1,
        id: 'skill.bad-signature',
        type: 'skill',
        name: 'bad-signature',
        version: '1.0.0',
      }),
      'SKILL.md': 'name: Bad Signature\n',
    })
    const otherData = await makeZip({ 'tampered.txt': 'not the package' })
    const signed = signResource(otherData)
    process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY = signed.publicKey

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        const origin = url.origin
        if (url.pathname === '/catalog.json') {
          return Response.json({
            schemaVersion: 1,
            resources: [{
              id: 'skill.bad-signature',
              type: 'skill',
              name: 'bad-signature',
              version: '1.0.0',
              packageUrl: `${origin}/packages/skill.bad-signature/1.0.0/package.zip`,
              sha256: sha256(zipData),
              signature: signed.signature,
            }],
          })
        }
        if (url.pathname === '/packages/skill.bad-signature/1.0.0/package.zip') {
          return new Response(zipData, { headers: { 'content-type': 'application/zip' } })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await refreshMarketplaceCatalog(`${server.url}catalog.json`)
      await expect(installMarketplaceResource('skill.bad-signature')).rejects.toThrow('signature verification failed')
      await expect(readFile(join(dataDir, 'marketplace', 'installed.json'), 'utf-8')).rejects.toThrow()
    } finally {
      server.stop(true)
    }
  })

  it('rejects a zip package when the catalog sha256 does not match', async () => {
    const dataDir = await makeDataRoot()
    const zipData = await makeZip({
      'resource.json': JSON.stringify({
        schemaVersion: 1,
        id: 'skill.bad-hash',
        type: 'skill',
        name: 'bad-hash',
        version: '1.0.0',
      }),
      'SKILL.md': 'name: Bad Hash\n',
    })

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        const origin = url.origin
        if (url.pathname === '/catalog.json') {
          return Response.json({
            schemaVersion: 1,
            resources: [{
              id: 'skill.bad-hash',
              type: 'skill',
              name: 'bad-hash',
              version: '1.0.0',
              packageUrl: `${origin}/packages/skill.bad-hash/1.0.0/package.zip`,
              sha256: '0'.repeat(64),
            }],
          })
        }
        if (url.pathname === '/packages/skill.bad-hash/1.0.0/package.zip') {
          return new Response(zipData, { headers: { 'content-type': 'application/zip' } })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await refreshMarketplaceCatalog(`${server.url}catalog.json`)
      await expect(installMarketplaceResource('skill.bad-hash')).rejects.toThrow('sha256 mismatch')
      await expect(readFile(join(dataDir, 'marketplace', 'installed.json'), 'utf-8')).rejects.toThrow()
    } finally {
      server.stop(true)
    }
  })

  it('installs a verified MCP zip package by merging its servers into data/mcp.json', async () => {
    const dataDir = await makeDataRoot()
    await writeFile(
      getMcpFile(),
      JSON.stringify({
        mcpServers: {
          existing: {
            type: 'http',
            url: 'https://existing.example.com/mcp',
          },
        },
        customTopLevel: true,
      }),
      'utf-8',
    )
    const zipData = await makeZip({
      'resource.json': JSON.stringify({
        schemaVersion: 1,
        id: 'mcp.remote-browser',
        type: 'mcp',
        name: 'remote-browser',
        version: '1.0.0',
        description: 'Remote browser MCP package',
      }),
      'mcp.json': JSON.stringify({
        mcpServers: {
          browser_use: {
            type: 'stdio',
            command: 'node',
            args: ['${PACKAGE_DIR}/server/index.js'],
            env: {
              BROWSER_USE_HEADLESS: 'false',
            },
          },
        },
      }),
      'server/index.js': 'console.log("browser mcp")\n',
    })

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        const origin = url.origin
        if (url.pathname === '/catalog.json') {
          return Response.json({
            schemaVersion: 1,
            resources: [{
              id: 'mcp.remote-browser',
              type: 'mcp',
              name: 'remote-browser',
              version: '1.0.0',
              packageUrl: `${origin}/packages/mcp.remote-browser/1.0.0/package.zip`,
              sha256: sha256(zipData),
            }],
          })
        }
        if (url.pathname === '/packages/mcp.remote-browser/1.0.0/package.zip') {
          return new Response(zipData, { headers: { 'content-type': 'application/zip' } })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await refreshMarketplaceCatalog(`${server.url}catalog.json`)
      const installed = await installMarketplaceResource('mcp.remote-browser')
      expect(installed).toMatchObject({
        id: 'mcp.remote-browser',
        type: 'mcp',
        mcpServers: ['browser_use'],
      })

      const mcpJson = JSON.parse(await readFile(getMcpFile(), 'utf-8'))
      expect(mcpJson.customTopLevel).toBe(true)
      expect(mcpJson.mcpServers.existing).toEqual({
        type: 'http',
        url: 'https://existing.example.com/mcp',
      })
      expect(mcpJson.mcpServers.browser_use).toMatchObject({
        type: 'stdio',
        command: 'node',
        env: {
          BROWSER_USE_HEADLESS: 'false',
        },
      })
      expect(mcpJson.mcpServers.browser_use.args).toEqual([
        join(dataDir, 'marketplace', 'packages', 'mcp.remote-browser', '1.0.0', 'server', 'index.js'),
      ])

      await uninstallMarketplaceResource('mcp.remote-browser')
      const afterUninstall = JSON.parse(await readFile(getMcpFile(), 'utf-8'))
      expect(afterUninstall.mcpServers.browser_use).toBeUndefined()
      expect(afterUninstall.mcpServers.existing).toEqual({
        type: 'http',
        url: 'https://existing.example.com/mcp',
      })
    } finally {
      server.stop(true)
    }
  })

  it('does not overwrite an existing user MCP server with a marketplace MCP package', async () => {
    await makeDataRoot()
    await writeFile(
      getMcpFile(),
      JSON.stringify({
        mcpServers: {
          browser_use: {
            type: 'http',
            url: 'https://user.example.com/mcp',
          },
        },
      }),
      'utf-8',
    )
    const zipData = await makeZip({
      'resource.json': JSON.stringify({
        schemaVersion: 1,
        id: 'mcp.conflict',
        type: 'mcp',
        name: 'conflict',
        version: '1.0.0',
      }),
      'mcp.json': JSON.stringify({
        mcpServers: {
          browser_use: {
            type: 'stdio',
            command: 'node',
            args: ['server/index.js'],
          },
        },
      }),
      'server/index.js': 'console.log("conflict")\n',
    })

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        const origin = url.origin
        if (url.pathname === '/catalog.json') {
          return Response.json({
            schemaVersion: 1,
            resources: [{
              id: 'mcp.conflict',
              type: 'mcp',
              name: 'conflict',
              version: '1.0.0',
              packageUrl: `${origin}/packages/mcp.conflict/1.0.0/package.zip`,
              sha256: sha256(zipData),
            }],
          })
        }
        if (url.pathname === '/packages/mcp.conflict/1.0.0/package.zip') {
          return new Response(zipData, { headers: { 'content-type': 'application/zip' } })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await refreshMarketplaceCatalog(`${server.url}catalog.json`)
      await expect(installMarketplaceResource('mcp.conflict')).rejects.toThrow('already exists')
      const mcpJson = JSON.parse(await readFile(getMcpFile(), 'utf-8'))
      expect(mcpJson.mcpServers.browser_use).toEqual({
        type: 'http',
        url: 'https://user.example.com/mcp',
      })
      await expect(getMarketplaceInstalled()).resolves.toEqual({
        schemaVersion: 1,
        installed: {},
      })
    } finally {
      server.stop(true)
    }
  })

  it('refuses to uninstall a marketplace MCP server after the user edits its config', async () => {
    const dataDir = await makeDataRoot()
    const packageSource = join(dataDir, 'local-source', 'mcp.safe', '1.0.0')
    await writeLocalMcpPackage(
      packageSource,
      { id: 'mcp.safe', name: 'safe', version: '1.0.0' },
      {
        marketplace_safe: {
          type: 'stdio',
          command: 'node',
          args: ['${PACKAGE_DIR}/server/index.js'],
          env: {
            MODE: 'marketplace',
          },
        },
      },
    )
    await writeLocalMarketplaceCatalog(dataDir, [{
      id: 'mcp.safe',
      type: 'mcp',
      name: 'safe',
      version: '1.0.0',
      packagePath: packageSource,
    }])

    await installMarketplaceResource('mcp.safe')
    const edited = JSON.parse(await readFile(getMcpFile(), 'utf-8'))
    edited.mcpServers.marketplace_safe.env.MODE = 'user-edited'
    await writeFile(getMcpFile(), JSON.stringify(edited, null, 2), 'utf-8')

    await expect(uninstallMarketplaceResource('mcp.safe')).rejects.toThrow('modified')

    const afterFailedUninstall = JSON.parse(await readFile(getMcpFile(), 'utf-8'))
    expect(afterFailedUninstall.mcpServers.marketplace_safe.env.MODE).toBe('user-edited')
    await expect(getMarketplaceInstalled()).resolves.toMatchObject({
      installed: {
        'mcp.safe': {
          version: '1.0.0',
          mcpServers: ['marketplace_safe'],
        },
      },
    })
  })

  it('previews a marketplace MCP package without writing mcp.json or installed state', async () => {
    const dataDir = await makeDataRoot()
    const packageSource = join(dataDir, 'local-source', 'mcp.preview', '1.0.0')
    await writeLocalMcpPackage(
      packageSource,
      { id: 'mcp.preview', name: 'preview', version: '1.0.0' },
      {
        marketplace_preview: {
          type: 'stdio',
          command: 'node',
          args: ['${PACKAGE_DIR}/server/index.js', '--mode', 'preview'],
          env: {
            TOKEN: 'redacted',
            MODE: 'preview',
          },
        },
        marketplace_http: {
          type: 'http',
          url: 'https://example.com/mcp',
        },
      },
    )
    await writeLocalMarketplaceCatalog(dataDir, [{
      id: 'mcp.preview',
      type: 'mcp',
      name: 'preview',
      version: '1.0.0',
      packagePath: packageSource,
      permissions: ['network'],
    }])

    const preview = await getMarketplaceInstallPreview('mcp.preview')

    expect(preview).toMatchObject({
      operation: 'install',
      permissions: ['network'],
      verification: {
        sha256: 'missing',
        signature: 'missing',
      },
    })
    expect(preview.writes).toContain('mcp.json')
    expect(preview.mcpServers).toEqual([
      {
        name: 'marketplace_preview',
        type: 'stdio',
        command: 'node',
        args: [
          join(dataDir, 'marketplace', 'packages', 'mcp.preview', '1.0.0', 'server', 'index.js'),
          '--mode',
          'preview',
        ],
        envKeys: ['MODE', 'TOKEN'],
        url: undefined,
      },
      {
        name: 'marketplace_http',
        type: 'http',
        command: undefined,
        args: undefined,
        envKeys: undefined,
        url: 'https://example.com/mcp',
      },
    ])
    await expect(readFile(getMcpFile(), 'utf-8')).rejects.toThrow()
    await expect(readFile(join(dataDir, 'marketplace', 'installed.json'), 'utf-8')).rejects.toThrow()
  })

  it('validates real-world security marketplace samples without executing their tools', async () => {
    const dataDir = await makeDataRoot()
    await cp(
      join(process.cwd(), 'data', 'marketplace'),
      join(dataDir, 'marketplace'),
      { recursive: true },
    )

    const catalog = await getMarketplaceCatalog()
    expect(catalog.resources.map(resource => resource.id)).toContain('mcp.security-httpx')
    expect(catalog.resources.map(resource => resource.id)).toContain('skill.secskills-index')
    expect(catalog.resources.map(resource => resource.id)).toContain('tool.security-cli-adapter')

    const preview = await getMarketplaceInstallPreview('mcp.security-httpx')
    expect(preview).toMatchObject({
      operation: 'install',
      verification: {
        sha256: 'missing',
        signature: 'missing',
      },
    })
    expect(preview.writes).toContain('mcp.json')
    expect(preview.mcpServers).toEqual([{
      name: 'security_httpx',
      type: 'stdio',
      command: 'python',
      args: [
        join(dataDir, 'marketplace', 'packages', 'mcp.security-httpx', '1.0.0', 'server.py'),
        'httpx',
      ],
      envKeys: ['MIKO_MARKETPLACE_RESOURCE'],
      url: undefined,
    }])

    const installedMcp = await installMarketplaceResource('mcp.security-httpx')
    expect(installedMcp).toMatchObject({
      id: 'mcp.security-httpx',
      type: 'mcp',
      mcpServers: ['security_httpx'],
    })
    const mcpJson = JSON.parse(await readFile(getMcpFile(), 'utf-8'))
    expect(mcpJson.mcpServers.security_httpx.args).toEqual([
      join(dataDir, 'marketplace', 'packages', 'mcp.security-httpx', '1.0.0', 'server.py'),
      'httpx',
    ])

    const installedSkill = await installMarketplaceResource('skill.secskills-index')
    expect(installedSkill).toMatchObject({
      id: 'skill.secskills-index',
      type: 'skill',
      name: 'secskills-index',
    })
    await expect(
      readFile(join(dataDir, 'marketplace', 'packages', 'skill.secskills-index', '1.0.0', 'SKILL.md'), 'utf-8'),
    ).resolves.toContain('DaoYiSec/SecSkills')

    const toolResource = catalog.resources.find(resource => resource.id === 'tool.security-cli-adapter')
    expect(toolResource).toMatchObject({
      id: 'tool.security-cli-adapter',
      type: 'tool',
      category: 'security',
    })
  })

  it('refuses to update a marketplace MCP server after the user edits its config', async () => {
    const dataDir = await makeDataRoot()
    const packageV1 = join(dataDir, 'local-source', 'mcp.updatable', '1.0.0')
    const packageV2 = join(dataDir, 'local-source', 'mcp.updatable', '2.0.0')

    await writeLocalMcpPackage(
      packageV1,
      { id: 'mcp.updatable', name: 'updatable', version: '1.0.0' },
      {
        marketplace_updatable: {
          type: 'stdio',
          command: 'node',
          args: ['${PACKAGE_DIR}/server/v1.js'],
          env: {
            VERSION: '1',
          },
        },
      },
    )
    await writeLocalMarketplaceCatalog(dataDir, [{
      id: 'mcp.updatable',
      type: 'mcp',
      name: 'updatable',
      version: '1.0.0',
      packagePath: packageV1,
    }])

    await installMarketplaceResource('mcp.updatable')
    const edited = JSON.parse(await readFile(getMcpFile(), 'utf-8'))
    edited.mcpServers.marketplace_updatable.env.VERSION = 'user-edited'
    await writeFile(getMcpFile(), JSON.stringify(edited, null, 2), 'utf-8')

    await writeLocalMcpPackage(
      packageV2,
      { id: 'mcp.updatable', name: 'updatable', version: '2.0.0' },
      {
        marketplace_updatable: {
          type: 'stdio',
          command: 'node',
          args: ['${PACKAGE_DIR}/server/v2.js'],
          env: {
            VERSION: '2',
          },
        },
      },
    )
    await writeLocalMarketplaceCatalog(dataDir, [{
      id: 'mcp.updatable',
      type: 'mcp',
      name: 'updatable',
      version: '2.0.0',
      packagePath: packageV2,
    }])

    await expect(installMarketplaceResource('mcp.updatable')).rejects.toThrow('modified')

    const afterFailedUpdate = JSON.parse(await readFile(getMcpFile(), 'utf-8'))
    expect(afterFailedUpdate.mcpServers.marketplace_updatable.env.VERSION).toBe('user-edited')
    await expect(getMarketplaceInstalled()).resolves.toMatchObject({
      installed: {
        'mcp.updatable': {
          version: '1.0.0',
          mcpServers: ['marketplace_updatable'],
        },
      },
    })
  })

  it('updates an unmodified marketplace MCP server and removes the old package copy', async () => {
    const dataDir = await makeDataRoot()
    const packageV1 = join(dataDir, 'local-source', 'mcp.clean-update', '1.0.0')
    const packageV2 = join(dataDir, 'local-source', 'mcp.clean-update', '2.0.0')

    await writeLocalMcpPackage(
      packageV1,
      { id: 'mcp.clean-update', name: 'clean-update', version: '1.0.0' },
      {
        marketplace_clean_update: {
          type: 'stdio',
          command: 'node',
          args: ['${PACKAGE_DIR}/server/v1.js'],
          env: {
            VERSION: '1',
          },
        },
      },
    )
    await writeLocalMarketplaceCatalog(dataDir, [{
      id: 'mcp.clean-update',
      type: 'mcp',
      name: 'clean-update',
      version: '1.0.0',
      packagePath: packageV1,
    }])

    const firstInstall = await installMarketplaceResource('mcp.clean-update')
    expect(firstInstall.version).toBe('1.0.0')
    expect(firstInstall.mcpServerHashes?.marketplace_clean_update).toBeTruthy()
    const copiedV1 = join(dataDir, 'marketplace', 'packages', 'mcp.clean-update', '1.0.0', 'mcp.json')
    await expect(readFile(copiedV1, 'utf-8')).resolves.toContain('marketplace_clean_update')

    await writeLocalMcpPackage(
      packageV2,
      { id: 'mcp.clean-update', name: 'clean-update', version: '2.0.0' },
      {
        marketplace_clean_update: {
          type: 'stdio',
          command: 'node',
          args: ['${PACKAGE_DIR}/server/v2.js'],
          env: {
            VERSION: '2',
          },
        },
      },
    )
    await writeLocalMarketplaceCatalog(dataDir, [{
      id: 'mcp.clean-update',
      type: 'mcp',
      name: 'clean-update',
      version: '2.0.0',
      packagePath: packageV2,
    }])

    const updated = await installMarketplaceResource('mcp.clean-update')
    expect(updated.version).toBe('2.0.0')
    expect(updated.mcpServerHashes?.marketplace_clean_update).toBeTruthy()
    expect(updated.mcpServerHashes?.marketplace_clean_update).not.toBe(firstInstall.mcpServerHashes?.marketplace_clean_update)

    const mcpJson = JSON.parse(await readFile(getMcpFile(), 'utf-8'))
    expect(mcpJson.mcpServers.marketplace_clean_update.env.VERSION).toBe('2')
    expect(mcpJson.mcpServers.marketplace_clean_update.args).toEqual([
      join(dataDir, 'marketplace', 'packages', 'mcp.clean-update', '2.0.0', 'server', 'v2.js'),
    ])
    const copiedV2 = join(dataDir, 'marketplace', 'packages', 'mcp.clean-update', '2.0.0', 'mcp.json')
    await expect(readFile(copiedV2, 'utf-8')).resolves.toContain('marketplace_clean_update')
    await expect(readFile(copiedV1, 'utf-8')).rejects.toThrow()
  })

  it('keeps legacy marketplace MCP install states without hashes uninstallable', async () => {
    const dataDir = await makeDataRoot()
    await writeFile(
      getMcpFile(),
      JSON.stringify({
        mcpServers: {
          legacy_marketplace: {
            type: 'stdio',
            command: 'node',
            args: ['legacy.js'],
          },
        },
      }),
      'utf-8',
    )
    await mkdir(join(dataDir, 'marketplace'), { recursive: true })
    await writeFile(
      join(dataDir, 'marketplace', 'installed.json'),
      JSON.stringify({
        schemaVersion: 1,
        installed: {
          'mcp.legacy': {
            id: 'mcp.legacy',
            type: 'mcp',
            name: 'legacy',
            version: '1.0.0',
            enabled: true,
            origin: 'marketplace',
            packagePath: 'packages/mcp.legacy/1.0.0',
            installedAt: '2026-07-27T00:00:00.000Z',
            mcpServers: ['legacy_marketplace'],
          },
        },
      }),
      'utf-8',
    )

    await uninstallMarketplaceResource('mcp.legacy')

    const afterUninstall = JSON.parse(await readFile(getMcpFile(), 'utf-8'))
    expect(afterUninstall.mcpServers.legacy_marketplace).toBeUndefined()
    await expect(getMarketplaceInstalled()).resolves.toEqual({
      schemaVersion: 1,
      installed: {},
    })
  })
})

describe('updateService', () => {
  it('reads the local update manifest before any cloud updater exists', async () => {
    const dataDir = await makeDataRoot()
    await mkdir(join(dataDir, 'updates'), { recursive: true })
    await writeFile(
      join(dataDir, 'updates', 'update.local.json'),
      JSON.stringify({
        schemaVersion: 1,
        latestVersion: '1.2.3',
        channel: 'local',
        notes: 'Local manifest only',
        resources: [{
          id: 'builtin-bundle',
          type: 'builtin-bundle',
          version: '2026.07.25',
        }],
      }),
      'utf-8',
    )

    await expect(checkLocalUpdateManifest()).resolves.toMatchObject({
      schemaVersion: 1,
      source: 'local',
      latestVersion: '1.2.3',
      currentVersion: '999.0.0-local',
      resources: [{
        id: 'builtin-bundle',
        type: 'builtin-bundle',
        version: '2026.07.25',
      }],
    })
  })
})
