import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')
const defaultArtifactsDir = path.join(root, 'desktop', 'build-artifacts', 'windows-x64')

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i++) {
  const item = process.argv[i]
  if (!item.startsWith('--')) continue
  const key = item.slice(2)
  const value = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true'
  args.set(key, value)
}

const artifactsDir = path.resolve(args.get('dir') ?? process.env.LOCAL_UPDATE_ARTIFACT_DIR ?? defaultArtifactsDir)
const host = args.get('host') ?? process.env.LOCAL_UPDATE_HOST ?? '127.0.0.1'
const port = Number(args.get('port') ?? process.env.LOCAL_UPDATE_PORT ?? '8789')
const tlsCertPath = args.get('tls-cert') ?? process.env.LOCAL_UPDATE_TLS_CERT
const tlsKeyPath = args.get('tls-key') ?? process.env.LOCAL_UPDATE_TLS_KEY
const protocol = tlsCertPath && tlsKeyPath ? 'https' : 'http'
const baseUrl = `${protocol}://${host}:${port}`

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.sig') return 'text/plain; charset=utf-8'
  if (ext === '.msi') return 'application/octet-stream'
  if (ext === '.zip') return 'application/zip'
  if (ext === '.exe') return 'application/octet-stream'
  return 'application/octet-stream'
}

function assertInside(parent: string, child: string): void {
  const relative = path.relative(parent, child)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes artifact directory: ${child}`)
  }
}

async function listArtifacts(): Promise<string[]> {
  if (!existsSync(artifactsDir)) return []
  const entries = await readdir(artifactsDir, { withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
}

export function rewriteManifestUrls(value: unknown, baseUrl: string): unknown {
  return rewriteManifestUrlsWithArtifacts(value, baseUrl, [])
}

function updaterArtifactKind(fileName: string): string | null {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.msi.zip')) return 'msi.zip'
  if (lower.endsWith('.exe')) return 'exe'
  if (lower.endsWith('.msi')) return 'msi'
  if (lower.endsWith('.app.tar.gz')) return 'app.tar.gz'
  if (lower.endsWith('.appimage.tar.gz')) return 'appimage.tar.gz'
  return null
}

export function resolveLocalArtifactName(fileName: string, artifacts: string[]): string {
  if (artifacts.includes(fileName)) return fileName

  const kind = updaterArtifactKind(fileName)
  if (!kind) return fileName

  const candidates = artifacts.filter((artifact) => updaterArtifactKind(artifact) === kind).sort()
  return candidates.at(-1) ?? fileName
}

export function parseUpdaterManifest(raw: string): unknown {
  return JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown
}

export function rewriteManifestUrlsWithArtifacts(
  value: unknown,
  baseUrl: string,
  artifacts: string[],
): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteManifestUrlsWithArtifacts(item, baseUrl, artifacts))
  if (!value || typeof value !== 'object') return value

  const next: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'url' && typeof raw === 'string') {
      const fileName = path.basename(new URL(raw, baseUrl).pathname)
      next[key] = `${baseUrl}/download/${encodeURIComponent(resolveLocalArtifactName(fileName, artifacts))}`
    } else {
      next[key] = rewriteManifestUrlsWithArtifacts(raw, baseUrl, artifacts)
    }
  }
  return next
}

async function serveLatestJson(): Promise<Response> {
  const latestPath = path.join(artifactsDir, 'latest.json')
  if (!existsSync(latestPath)) {
    return Response.json({
      error: 'latest.json not found',
      artifactsDir,
      hint: 'Build updater artifacts first. TAURI_SIGNING_PRIVATE_KEY must be set.',
    }, { status: 404 })
  }

  const manifest = parseUpdaterManifest(await readFile(latestPath, 'utf-8'))
  return Response.json(rewriteManifestUrlsWithArtifacts(manifest, baseUrl, await listArtifacts()))
}

async function serveFile(fileName: string): Promise<Response> {
  const targetPath = path.join(artifactsDir, fileName)
  assertInside(artifactsDir, targetPath)
  const info = await stat(targetPath).catch(() => null)
  if (!info?.isFile()) return new Response('not found', { status: 404 })
  const bytes = await readFile(targetPath)
  return new Response(bytes, {
    headers: {
      'content-type': contentType(targetPath),
      'content-length': String(bytes.byteLength),
    },
  })
}

if (import.meta.main) {
  Bun.serve({
    hostname: host,
    port,
    tls: tlsCertPath && tlsKeyPath ? {
      cert: Bun.file(tlsCertPath),
      key: Bun.file(tlsKeyPath),
    } : undefined,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/' || url.pathname === '/health') {
        return Response.json({
          ok: true,
          latestJson: `${baseUrl}/latest.json`,
          artifactsDir,
          artifacts: await listArtifacts(),
        })
      }
      if (url.pathname === '/latest.json') return serveLatestJson()
      if (url.pathname.startsWith('/download/')) {
        return serveFile(decodeURIComponent(url.pathname.slice('/download/'.length)))
      }
      return new Response('not found', { status: 404 })
    },
  })

  console.log(`[local-update] serving ${artifactsDir}`)
  console.log(`[local-update] latest.json: ${baseUrl}/latest.json`)
  if (protocol === 'http') {
    console.log('[local-update] warning: Tauri updater endpoints compiled into a packaged app must use https')
  }
}
