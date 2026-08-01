import { afterEach, describe, expect, it } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalizeSignedJson, verifyResourceSignature } from '../src/services/resourceSignature.js'
import { signMarketplaceCatalog } from './sign-marketplace-catalog.ts'

const tempDirs: string[] = []
const originalPrivateKey = process.env.KIMO_RESOURCE_SIGNATURE_PRIVATE_KEY
const originalPublicKey = process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY

afterEach(async () => {
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
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function configureSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  process.env.KIMO_RESOURCE_SIGNATURE_PRIVATE_KEY = Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'der' }),
  ).toString('base64')
  process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY = Buffer.from(
    publicKey.export({ type: 'spki', format: 'der' }),
  ).toString('base64')
}

describe('sign-marketplace-catalog', () => {
  it('publishes signed package zips and a signed static catalog', async () => {
    configureSigningKey()
    const source = await makeTempDir('miko-marketplace-source-')
    const output = await makeTempDir('miko-marketplace-signed-')
    const packageDir = join(source, 'local-packages', 'skill.signed-sample', '1.0.0')
    await mkdir(packageDir, { recursive: true })
    await writeFile(
      join(packageDir, 'resource.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'skill.signed-sample',
        type: 'skill',
        name: 'signed-sample',
        version: '1.0.0',
      }),
      'utf-8',
    )
    await writeFile(join(packageDir, 'SKILL.md'), '# Signed Sample\n', 'utf-8')
    await writeFile(
      join(source, 'catalog.local.json'),
      JSON.stringify({
        schemaVersion: 1,
        resources: [{
          id: 'skill.signed-sample',
          type: 'skill',
          name: 'signed-sample',
          version: '1.0.0',
          packagePath: 'local-packages/skill.signed-sample/1.0.0',
        }],
      }),
      'utf-8',
    )

    const catalog = await signMarketplaceCatalog({
      source,
      out: output,
      baseUrl: 'https://market.example.com',
    })

    expect(catalog.resources).toHaveLength(1)
    expect(catalog.resources[0].sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(catalog.resources[0].signature).toMatch(/^ed25519:/)
    expect(catalog.signature).toMatch(/^ed25519:/)
    expect(catalog.resources[0].packageUrl).toBe(
      'https://market.example.com/packages/skill.signed-sample/1.0.0/package.zip',
    )

    const packageZip = await readFile(join(output, 'packages', 'skill.signed-sample', '1.0.0', 'package.zip'))
    expect(verifyResourceSignature(packageZip, catalog.resources[0].signature, 'signed package')).toBe('verified')

    const catalogForVerification = JSON.parse(JSON.stringify(catalog)) as Record<string, unknown>
    delete catalogForVerification.signature
    expect(
      verifyResourceSignature(
        new TextEncoder().encode(canonicalizeSignedJson(catalogForVerification)),
        catalog.signature,
        'signed catalog',
      ),
    ).toBe('verified')
  })
})
