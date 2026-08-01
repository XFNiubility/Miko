import { afterAll, describe, expect, it } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyResourceSignature } from '../src/services/resourceSignature.js'

const storageRoot = mkdtempSync(join(tmpdir(), 'miko-marketplace-rbac-'))
const port = '8797'
const originalPrivateKey = process.env.KIMO_RESOURCE_SIGNATURE_PRIVATE_KEY
const originalPublicKey = process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY
const { privateKey, publicKey } = generateKeyPairSync('ed25519')

process.env.MARKETPLACE_STORAGE_ROOT = storageRoot
process.env.MARKETPLACE_ROOT = join(storageRoot, 'bundled')
process.env.MARKETPLACE_PORT = port
process.env.KIMO_RESOURCE_SIGNATURE_PRIVATE_KEY = Buffer.from(
  privateKey.export({ type: 'pkcs8', format: 'der' }),
).toString('base64')
process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY = Buffer.from(
  publicKey.export({ type: 'spki', format: 'der' }),
).toString('base64')

const { startLocalMarketplaceServer } = await import('./local-marketplace-server.ts')
const server = startLocalMarketplaceServer()
const baseUrl = `http://127.0.0.1:${port}`

afterAll(() => {
  server.stop(true)
  rmSync(storageRoot, { recursive: true, force: true })
  if (originalPrivateKey === undefined) {
    delete process.env.KIMO_RESOURCE_SIGNATURE_PRIVATE_KEY
  } else {
    process.env.KIMO_RESOURCE_SIGNATURE_PRIVATE_KEY = originalPrivateKey
  }
  if (originalPublicKey === undefined) {
    delete process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY
  } else {
    process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY = originalPublicKey
  }
})

function request(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, init)
}

async function makeSkillPackage(id: string, version: string) {
  const { zipSync } = await import('fflate')
  return zipSync({
    'resource.json': new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      id,
      type: 'skill',
      name: id,
      version,
      category: 'test',
      description: 'RBAC test skill',
    })),
    'SKILL.md': new TextEncoder().encode('# Test Skill\n'),
  })
}

async function submitSkill(id: string, version: string) {
  const form = new FormData()
  form.set('package', new File([await makeSkillPackage(id, version)], `${id}-${version}.zip`, { type: 'application/zip' }))
  const response = await request('/api/submissions', {
    method: 'POST',
    headers: { 'x-miko-role': 'publisher', 'x-miko-actor': 'publisher-one' },
    body: form,
  })
  expect(response.status).toBe(201)
  const body = await response.json() as { submission: { id: string } }
  return body.submission.id
}

describe('local marketplace RBAC', () => {
  it('keeps public catalog and packages anonymous while hiding backend APIs', async () => {
    await expect((await request('/api/catalog')).status).toBe(200)
    await expect((await request('/api/submissions')).status).toBe(401)
    await expect((await request('/api/submissions/mine')).status).toBe(401)
    await expect((await request('/reviews')).status).toBe(401)
    await expect((await request('/publish')).status).toBe(401)
  })

  it('serves the public catalog with a verifiable signature header when a signing key is configured', async () => {
    const response = await request('/api/catalog')
    expect(response.status).toBe(200)
    const signature = response.headers.get('x-miko-catalog-signature')
    expect(signature).toMatch(/^ed25519:/)
    const body = new Uint8Array(await response.arrayBuffer())
    expect(verifyResourceSignature(body, signature ?? undefined, 'local marketplace catalog')).toBe('verified')
  })

  it('serves a separate resource update manifest for the local updater', async () => {
    const response = await request('/updates/update.json')
    expect(response.status).toBe(200)
    const body = await response.json() as {
      resources: Array<{ id: string; type: string; version: string; packageUrl: string }>
    }
    expect(body.resources).toHaveLength(1)
    expect(body.resources[0]).toMatchObject({
      id: 'marketplace-catalog',
      type: 'marketplace-catalog',
      version: 'local',
      packageUrl: `${baseUrl}/catalog.json`,
    })
  })

  it('allows publishers to submit and view only their own submission endpoint', async () => {
    const mine = await request('/api/submissions/mine', {
      headers: { 'x-miko-role': 'publisher', 'x-miko-actor': 'publisher-one' },
    })
    expect(mine.status).toBe(200)
    await expect(mine.json()).resolves.toEqual({ submissions: [] })

    const all = await request('/api/submissions', {
      headers: { 'x-miko-role': 'publisher', 'x-miko-actor': 'publisher-one' },
    })
    expect(all.status).toBe(403)

    const malformedUpload = await request('/api/submissions', {
      method: 'POST',
      headers: { 'x-miko-role': 'publisher', 'x-miko-actor': 'publisher-one' },
    })
    expect(malformedUpload.status).toBe(400)
  })

  it('allows reviewers to review without granting publisher submission access', async () => {
    const queue = await request('/api/submissions', {
      headers: { 'x-miko-role': 'reviewer', 'x-miko-actor': 'reviewer-one' },
    })
    expect(queue.status).toBe(200)
    await expect(queue.json()).resolves.toEqual({ submissions: [] })

    const mine = await request('/api/submissions/mine', {
      headers: { 'x-miko-role': 'reviewer', 'x-miko-actor': 'reviewer-one' },
    })
    expect(mine.status).toBe(403)

    const malformedUpload = await request('/api/submissions', {
      method: 'POST',
      headers: { 'x-miko-role': 'reviewer', 'x-miko-actor': 'reviewer-one' },
    })
    expect(malformedUpload.status).toBe(403)

    const missingSubmissionReview = await request('/api/reviews/missing/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-miko-role': 'reviewer',
        'x-miko-actor': 'reviewer-one',
      },
      body: JSON.stringify({ notes: 'not found is after auth' }),
    })
    expect(missingSubmissionReview.status).toBe(404)
  })

  it('keeps the reviewer console behind reviewer or admin roles', async () => {
    const publisher = await request('/reviews', {
      headers: { 'x-miko-role': 'publisher', 'x-miko-actor': 'publisher-one' },
    })
    expect(publisher.status).toBe(403)

    const reviewer = await request('/reviews', {
      headers: { 'x-miko-role': 'reviewer', 'x-miko-actor': 'reviewer-one' },
    })
    expect(reviewer.status).toBe(200)

    const admin = await request('/reviews', {
      headers: { 'x-miko-role': 'admin', 'x-miko-actor': 'admin-one' },
    })
    expect(admin.status).toBe(200)
  })

  it('does not allow an approved resource version to be overwritten', async () => {
    const resourceId = 'skill.rbac-immutable'
    const firstSubmissionId = await submitSkill(resourceId, '1.0.0')
    const firstApprove = await request(`/api/reviews/${firstSubmissionId}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-miko-role': 'reviewer',
        'x-miko-actor': 'reviewer-one',
      },
      body: JSON.stringify({ notes: 'approve first version' }),
    })
    expect(firstApprove.status).toBe(200)

    const secondSubmissionId = await submitSkill(resourceId, '1.0.0')
    const secondApprove = await request(`/api/reviews/${secondSubmissionId}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-miko-role': 'reviewer',
        'x-miko-actor': 'reviewer-one',
      },
      body: JSON.stringify({ notes: 'duplicate version' }),
    })
    expect(secondApprove.status).toBe(400)
    await expect(secondApprove.json()).resolves.toMatchObject({
      error: 'Resource version already published: skill.rbac-immutable@1.0.0',
    })
  })

  it('lets only admins take down and restore published resources without deleting packages', async () => {
    const resourceId = 'skill.rbac-admin-takedown'
    const version = '1.0.0'
    const submissionId = await submitSkill(resourceId, version)
    const approve = await request(`/api/reviews/${submissionId}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-miko-role': 'reviewer',
        'x-miko-actor': 'reviewer-one',
      },
      body: JSON.stringify({ notes: 'approve resource for takedown test' }),
    })
    expect(approve.status).toBe(200)

    const packagePath = `/packages/${encodeURIComponent(resourceId)}/${encodeURIComponent(version)}/package.zip`
    expect((await request(packagePath)).status).toBe(200)

    const publisherTakedown = await request(`/api/admin/resources/${resourceId}/${version}/take-down`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-miko-role': 'publisher',
        'x-miko-actor': 'publisher-one',
      },
      body: JSON.stringify({ notes: 'should fail' }),
    })
    expect(publisherTakedown.status).toBe(403)

    const reviewerTakedown = await request(`/api/admin/resources/${resourceId}/${version}/take-down`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-miko-role': 'reviewer',
        'x-miko-actor': 'reviewer-one',
      },
      body: JSON.stringify({ notes: 'should fail' }),
    })
    expect(reviewerTakedown.status).toBe(403)

    const takedown = await request(`/api/admin/resources/${resourceId}/${version}/take-down`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-miko-role': 'admin',
        'x-miko-actor': 'admin-one',
      },
      body: JSON.stringify({ notes: 'security review' }),
    })
    expect(takedown.status).toBe(200)
    await expect(takedown.json()).resolves.toMatchObject({
      resource: {
        status: 'taken_down',
        takenDownBy: 'admin-one',
      },
    })

    const hiddenCatalog = await (await request('/api/catalog')).json() as { resources: Array<{ id: string }> }
    expect(hiddenCatalog.resources.some(resource => resource.id === resourceId)).toBe(false)
    expect((await request(packagePath)).status).toBe(404)

    const restore = await request(`/api/admin/resources/${resourceId}/${version}/restore`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-miko-role': 'admin',
        'x-miko-actor': 'admin-one',
      },
      body: JSON.stringify({ notes: 'restored after review' }),
    })
    expect(restore.status).toBe(200)
    await expect(restore.json()).resolves.toMatchObject({
      resource: {
        status: 'published',
        restoredBy: 'admin-one',
      },
    })

    const restoredCatalog = await (await request('/api/catalog')).json() as { resources: Array<{ id: string }> }
    expect(restoredCatalog.resources.some(resource => resource.id === resourceId)).toBe(true)
    expect((await request(packagePath)).status).toBe(200)
  })
})
