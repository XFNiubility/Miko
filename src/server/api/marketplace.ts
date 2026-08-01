import {
  getMarketplaceInstallPreview,
  getMarketplaceCatalog,
  getMarketplaceInstalled,
  installMarketplaceResource,
  MarketplaceServiceError,
  refreshMarketplaceCatalog,
  setMarketplaceResourceEnabled,
  uninstallMarketplaceResource,
} from '../../services/marketplaceService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

function mapMarketplaceError(error: unknown): never {
  if (error instanceof MarketplaceServiceError) {
    switch (error.code) {
      case 'BAD_REQUEST':
      case 'UNSUPPORTED':
        throw ApiError.badRequest(error.message)
      case 'NOT_FOUND':
        throw ApiError.notFound(error.message)
      case 'CONFLICT':
        throw ApiError.conflict(error.message)
    }
  }
  throw error
}

async function readIdBody(req: Request): Promise<string> {
  const body = await req.json().catch(() => {
    throw ApiError.badRequest('Invalid JSON body')
  }) as Record<string, unknown>
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (!id) throw ApiError.badRequest('Missing "id"')
  return id
}

async function readOptionalCatalogUrlBody(req: Request): Promise<string | undefined> {
  const text = await req.text()
  if (!text.trim()) return undefined
  const body = JSON.parse(text) as Record<string, unknown>
  const catalogUrl = typeof body.catalogUrl === 'string' ? body.catalogUrl.trim() : ''
  return catalogUrl || undefined
}

export async function handleMarketplaceApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const sub = segments[2]

    if (req.method === 'GET') {
      switch (sub) {
        case undefined:
        case 'catalog':
          return Response.json(await getMarketplaceCatalog())
        case 'installed':
          return Response.json(await getMarketplaceInstalled())
        default:
          throw ApiError.notFound(`Unknown marketplace endpoint: ${sub}`)
      }
    }

  if (req.method === 'POST') {
      if (!['refresh', 'preview', 'install', 'uninstall', 'enable', 'disable'].includes(sub ?? '')) {
        throw ApiError.notFound(`Unknown marketplace endpoint: ${sub}`)
      }

      try {
        if (sub === 'refresh') {
          return Response.json(await refreshMarketplaceCatalog(await readOptionalCatalogUrlBody(req)))
        }

        const id = await readIdBody(req)
        switch (sub) {
          case 'preview':
            return Response.json(await getMarketplaceInstallPreview(id))
          case 'install':
            return Response.json({ installed: await installMarketplaceResource(id) })
          case 'uninstall':
            await uninstallMarketplaceResource(id)
            return Response.json({ ok: true })
          case 'enable':
            return Response.json({ installed: await setMarketplaceResourceEnabled(id, true) })
          case 'disable':
            return Response.json({ installed: await setMarketplaceResourceEnabled(id, false) })
          default:
            throw ApiError.notFound(`Unknown marketplace endpoint: ${sub}`)
        }
      } catch (error) {
        mapMarketplaceError(error)
      }
    }

    throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
  } catch (error) {
    return errorResponse(error)
  }
}
