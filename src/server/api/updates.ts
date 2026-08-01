import {
  applyResourceUpdates,
  checkLocalUpdateManifest,
  getResourceUpdateStatus,
  refreshUpdateManifest,
  rollbackResourceUpdates,
  UpdateServiceError,
} from '../../services/updateService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

function mapUpdateError(error: unknown): never {
  if (error instanceof UpdateServiceError) {
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

async function readOptionalJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text()
  if (!text.trim()) return {}
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ApiError.badRequest('Invalid JSON body')
  }
  return parsed as Record<string, unknown>
}

export async function handleUpdatesApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const sub = segments[2]

    if (req.method === 'GET') {
      switch (sub) {
        case undefined:
        case 'check':
          return Response.json(await checkLocalUpdateManifest())
        case 'status':
          return Response.json(await getResourceUpdateStatus())
        default:
          throw ApiError.notFound(`Unknown updates endpoint: ${sub}`)
      }
    }

    if (req.method === 'POST') {
      try {
        switch (sub) {
          case 'refresh': {
            const body = await readOptionalJsonBody(req)
            const manifestUrl = typeof body.manifestUrl === 'string' ? body.manifestUrl.trim() : undefined
            return Response.json(await refreshUpdateManifest(manifestUrl || undefined))
          }
          case 'apply': {
            const body = await readOptionalJsonBody(req)
            const resourceIds = Array.isArray(body.resourceIds)
              ? body.resourceIds.filter((item): item is string => typeof item === 'string')
              : undefined
            return Response.json(await applyResourceUpdates(resourceIds))
          }
          case 'rollback':
            return Response.json(await rollbackResourceUpdates())
          default:
            throw ApiError.notFound(`Unknown updates endpoint: ${sub}`)
        }
      } catch (error) {
        mapUpdateError(error)
      }
    }

    throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
  } catch (error) {
    return errorResponse(error)
  }
}
