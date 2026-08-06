import { afterEach, describe, expect, it } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getBundledDataDir,
  getMarketplaceCatalogCacheFile,
  resetDataDirForTests,
  setDataDir,
} from '../utils/kimoPaths.js'
import {
  applyResourceUpdates,
  getResourceUpdateStatus,
  refreshUpdateManifest,
  rollbackResourceUpdates,
} from './updateService.js'

const tempDirs: string[] = []
const originalBundledRoot = process.env.KIMO_BUNDLED_DATA_ROOT
const originalUpdateManifestUrl = process.env.KIMO_UPDATE_MANIFEST_URL
const originalResourceSignaturePublicKey = process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY
const originalFetch = globalThis.fetch

async function makeRoots(): Promise<{ root: string; dataDir: string; bundledDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'miko-resource-update-'))
  tempDirs.push(root)
  const dataDir = join(root, 'data')
  const bundledDir = join(root, 'bundled-data')
  setDataDir(dataDir)
  process.env.KIMO_BUNDLED_DATA_ROOT = bundledDir
  await mkdir(dataDir, { recursive: true })
  await mkdir(bundledDir, { recursive: true })
  return { root, dataDir, bundledDir }
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

afterEach(async () => {
  globalThis.fetch = originalFetch
  resetDataDirForTests()
  if (originalBundledRoot === undefined) {
    delete process.env.KIMO_BUNDLED_DATA_ROOT
  } else {
    process.env.KIMO_BUNDLED_DATA_ROOT = originalBundledRoot
  }
  if (originalUpdateManifestUrl === undefined) {
    delete process.env.KIMO_UPDATE_MANIFEST_URL
  } else {
    process.env.KIMO_UPDATE_MANIFEST_URL = originalUpdateManifestUrl
  }
  if (originalResourceSignaturePublicKey === undefined) {
    delete process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY
  } else {
    process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY = originalResourceSignaturePublicKey
  }
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('updateService resource updates', () => {
  it('refreshes from the official cloud manifest by default', async () => {
    await makeRoots()
    delete process.env.KIMO_UPDATE_MANIFEST_URL
    let requestedUrl = ''
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input)
      return Response.json({
        schemaVersion: 1,
        resources: [],
      })
    }) as typeof fetch

    await expect(refreshUpdateManifest()).resolves.toMatchObject({
      source: 'cache',
    })
    expect(requestedUrl).toBe('http://8.134.211.101/updates/update.json')
  })

  it('reports an actionable service error when the update endpoint is unreachable', async () => {
    await makeRoots()
    globalThis.fetch = (async () => {
      throw new TypeError('connection refused')
    }) as typeof fetch

    await expect(refreshUpdateManifest('http://updates.example.test/update.json')).rejects.toMatchObject({
      name: 'UpdateServiceError',
      code: 'BAD_REQUEST',
      message: 'Unable to reach resource update endpoint http://updates.example.test/update.json: connection refused',
    })
  })

  it('refreshes a remote update manifest into the manifest cache and status file', async () => {
    await makeRoots()
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/updates/update.json') {
          return Response.json({
            schemaVersion: 1,
            latestVersion: '2.0.0',
            channel: 'local',
            resources: [{
              id: 'marketplace-main',
              type: 'marketplace-catalog',
              version: '2026.07.27',
              packageUrl: `${url.origin}/catalog.json`,
            }],
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      const manifest = await refreshUpdateManifest(`${server.url}updates/update.json`)
      expect(manifest).toMatchObject({
        source: 'cache',
        latestVersion: '2.0.0',
        resources: [{
          id: 'marketplace-main',
          type: 'marketplace-catalog',
        }],
      })
      await expect(getResourceUpdateStatus()).resolves.toMatchObject({
        state: 'refreshed',
        manifest: {
          latestVersion: '2.0.0',
        },
      })
    } finally {
      server.stop(true)
    }
  })

  it('applies a marketplace catalog resource into data/marketplace/catalog-cache.json', async () => {
    const { dataDir } = await makeRoots()
    await mkdir(join(dataDir, 'updates'), { recursive: true })

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/catalog.json') {
          return Response.json({
            schemaVersion: 1,
            generatedAt: '2026-07-27T00:00:00.000Z',
            resources: [{
              id: 'skill.catalog-update',
              type: 'skill',
              name: 'catalog-update',
              version: '1.0.0',
            }],
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await writeFile(
        join(dataDir, 'updates', 'update.local.json'),
        JSON.stringify({
          schemaVersion: 1,
          resources: [{
            id: 'marketplace-main',
            type: 'marketplace-catalog',
            version: '2026.07.27',
            packageUrl: `${server.url}catalog.json`,
          }],
        }),
        'utf-8',
      )

      await expect(applyResourceUpdates()).resolves.toMatchObject({
        state: 'applied',
        appliedResources: [{
          id: 'marketplace-main',
          type: 'marketplace-catalog',
          version: '2026.07.27',
        }],
      })

      const catalogCache = JSON.parse(await readFile(getMarketplaceCatalogCacheFile(), 'utf-8'))
      expect(catalogCache.source).toBe('cache')
      expect(catalogCache.resources[0].id).toBe('skill.catalog-update')
    } finally {
      server.stop(true)
    }
  })

  it('rolls back a marketplace catalog cache without touching bundled-data', async () => {
    const { dataDir } = await makeRoots()
    await mkdir(join(dataDir, 'updates'), { recursive: true })
    await mkdir(join(dataDir, 'marketplace'), { recursive: true })
    await writeFile(
      getMarketplaceCatalogCacheFile(),
      JSON.stringify({
        schemaVersion: 1,
        source: 'cache',
        resources: [{
          id: 'skill.previous-catalog',
          type: 'skill',
          name: 'previous-catalog',
          version: '1.0.0',
        }],
      }),
      'utf-8',
    )

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/catalog.json') {
          return Response.json({
            schemaVersion: 1,
            generatedAt: '2026-07-27T00:00:00.000Z',
            resources: [{
              id: 'skill.updated-catalog',
              type: 'skill',
              name: 'updated-catalog',
              version: '2.0.0',
            }],
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await writeFile(
        join(dataDir, 'updates', 'update.local.json'),
        JSON.stringify({
          schemaVersion: 1,
          resources: [{
            id: 'marketplace-main',
            type: 'marketplace-catalog',
            version: '2026.07.27',
            packageUrl: `${server.url}catalog.json`,
          }],
        }),
        'utf-8',
      )

      await applyResourceUpdates()
      let catalogCache = JSON.parse(await readFile(getMarketplaceCatalogCacheFile(), 'utf-8'))
      expect(catalogCache.resources[0].id).toBe('skill.updated-catalog')

      process.env.KIMO_BUNDLED_DATA_ROOT = join(dataDir, 'conflicting-bundled-root')
      await expect(rollbackResourceUpdates()).resolves.toMatchObject({
        state: 'rolled-back',
        appliedResources: [{
          id: 'marketplace-main',
          type: 'marketplace-catalog',
          version: '2026.07.27',
        }],
      })
      catalogCache = JSON.parse(await readFile(getMarketplaceCatalogCacheFile(), 'utf-8'))
      expect(catalogCache.resources[0].id).toBe('skill.previous-catalog')
    } finally {
      server.stop(true)
    }
  })

  it('rolls back an older marketplace catalog cache by deleting the generated cache', async () => {
    const { dataDir } = await makeRoots()
    await mkdir(join(dataDir, 'updates'), { recursive: true })
    await mkdir(join(dataDir, 'marketplace'), { recursive: true })
    await writeFile(
      getMarketplaceCatalogCacheFile(),
      JSON.stringify({
        schemaVersion: 1,
        source: 'cache',
        resources: [{
          id: 'skill.generated-catalog',
          type: 'skill',
          name: 'generated-catalog',
          version: '1.0.0',
        }],
      }),
      'utf-8',
    )
    await writeFile(
      join(dataDir, 'updates', 'status.json'),
      JSON.stringify({
        schemaVersion: 1,
        state: 'applied',
        appliedResources: [{
          id: 'marketplace-main',
          type: 'marketplace-catalog',
          version: '2026.07.27',
        }],
      }),
      'utf-8',
    )

    process.env.KIMO_BUNDLED_DATA_ROOT = join(dataDir, 'conflicting-bundled-root')
    await expect(rollbackResourceUpdates()).resolves.toMatchObject({
      state: 'rolled-back',
    })
    await expect(readFile(getMarketplaceCatalogCacheFile(), 'utf-8')).rejects.toThrow()
  })

  it('applies a builtin bundle zip and rolls back to the previous bundled-data copy', async () => {
    const { dataDir, bundledDir } = await makeRoots()
    await mkdir(join(dataDir, 'updates'), { recursive: true })
    await mkdir(join(bundledDir, 'skills', 'old-skill'), { recursive: true })
    await writeFile(join(bundledDir, 'skills', 'old-skill', 'SKILL.md'), 'old skill', 'utf-8')

    const zipData = await makeZip({
      'skills/new-skill/SKILL.md': 'new skill',
      'marketplace/catalog.local.json': JSON.stringify({ schemaVersion: 1, resources: [] }),
    })
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/bundled-data.zip') {
          return new Response(zipData, { headers: { 'content-type': 'application/zip' } })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await writeFile(
        join(dataDir, 'updates', 'update.local.json'),
        JSON.stringify({
          schemaVersion: 1,
          resources: [{
            id: 'builtin-data',
            type: 'builtin-bundle',
            version: '2026.07.27',
            packageUrl: `${server.url}bundled-data.zip`,
            sha256: sha256(zipData),
          }],
        }),
        'utf-8',
      )

      await applyResourceUpdates()
      await expect(readFile(join(getBundledDataDir(), 'skills', 'new-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('new skill')
      await expect(readFile(join(getBundledDataDir(), 'skills', 'old-skill', 'SKILL.md'), 'utf-8')).rejects.toThrow()

      await rollbackResourceUpdates()
      await expect(readFile(join(getBundledDataDir(), 'skills', 'old-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('old skill')
      await expect(readFile(join(getBundledDataDir(), 'skills', 'new-skill', 'SKILL.md'), 'utf-8')).rejects.toThrow()
    } finally {
      server.stop(true)
    }
  })

  it('applies a signed builtin bundle when the configured resource public key verifies it', async () => {
    const { dataDir } = await makeRoots()
    await mkdir(join(dataDir, 'updates'), { recursive: true })

    const zipData = await makeZip({
      'skills/signed-skill/SKILL.md': 'signed skill',
    })
    const signed = signResource(zipData)
    process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY = signed.publicKey
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/bundled-data.zip') {
          return new Response(zipData, { headers: { 'content-type': 'application/zip' } })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await writeFile(
        join(dataDir, 'updates', 'update.local.json'),
        JSON.stringify({
          schemaVersion: 1,
          resources: [{
            id: 'builtin-data',
            type: 'builtin-bundle',
            version: '2026.07.28',
            packageUrl: `${server.url}bundled-data.zip`,
            sha256: sha256(zipData),
            signature: signed.signature,
          }],
        }),
        'utf-8',
      )

      await expect(applyResourceUpdates()).resolves.toMatchObject({
        state: 'applied',
        appliedResources: [{
          id: 'builtin-data',
          type: 'builtin-bundle',
          version: '2026.07.28',
        }],
      })
      await expect(readFile(join(getBundledDataDir(), 'skills', 'signed-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('signed skill')
    } finally {
      server.stop(true)
    }
  })

  it('rejects a builtin bundle with a bad signature and preserves bundled-data', async () => {
    const { dataDir, bundledDir } = await makeRoots()
    await mkdir(join(dataDir, 'updates'), { recursive: true })
    await mkdir(join(bundledDir, 'skills', 'stable-skill'), { recursive: true })
    await writeFile(join(bundledDir, 'skills', 'stable-skill', 'SKILL.md'), 'stable skill', 'utf-8')

    const zipData = await makeZip({
      'skills/new-skill/SKILL.md': 'new skill',
    })
    const otherData = await makeZip({
      'skills/other-skill/SKILL.md': 'other skill',
    })
    const signed = signResource(otherData)
    process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY = signed.publicKey
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/bundled-data.zip') {
          return new Response(zipData, { headers: { 'content-type': 'application/zip' } })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await writeFile(
        join(dataDir, 'updates', 'update.local.json'),
        JSON.stringify({
          schemaVersion: 1,
          resources: [{
            id: 'builtin-data',
            type: 'builtin-bundle',
            version: '2026.07.28',
            packageUrl: `${server.url}bundled-data.zip`,
            sha256: sha256(zipData),
            signature: signed.signature,
          }],
        }),
        'utf-8',
      )

      await expect(applyResourceUpdates()).rejects.toThrow('signature verification failed')
      await expect(readFile(join(getBundledDataDir(), 'skills', 'stable-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('stable skill')
      await expect(getResourceUpdateStatus()).resolves.toMatchObject({
        state: 'error',
      })
    } finally {
      server.stop(true)
    }
  })

  it('rejects a builtin bundle with a mismatched sha256 and preserves bundled-data', async () => {
    const { dataDir, bundledDir } = await makeRoots()
    await mkdir(join(dataDir, 'updates'), { recursive: true })
    await mkdir(join(bundledDir, 'skills', 'stable-skill'), { recursive: true })
    await writeFile(join(bundledDir, 'skills', 'stable-skill', 'SKILL.md'), 'stable skill', 'utf-8')

    const zipData = await makeZip({
      'skills/new-skill/SKILL.md': 'new skill',
    })
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/bundled-data.zip') {
          return new Response(zipData, { headers: { 'content-type': 'application/zip' } })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      await writeFile(
        join(dataDir, 'updates', 'update.local.json'),
        JSON.stringify({
          schemaVersion: 1,
          resources: [{
            id: 'builtin-data',
            type: 'builtin-bundle',
            version: '2026.07.27',
            packageUrl: `${server.url}bundled-data.zip`,
            sha256: '0'.repeat(64),
          }],
        }),
        'utf-8',
      )

      await expect(applyResourceUpdates()).rejects.toThrow('sha256 mismatch')
      await expect(readFile(join(getBundledDataDir(), 'skills', 'stable-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('stable skill')
      await expect(getResourceUpdateStatus()).resolves.toMatchObject({
        state: 'error',
      })
    } finally {
      server.stop(true)
    }
  })
})
