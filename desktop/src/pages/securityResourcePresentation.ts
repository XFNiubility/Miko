import type { ResourceExtraction, SecurityResource } from '../api/security'

export type SecurityResourcePresentation = {
  preparedContent: string
  sourceContent: string
  sourceLabel: string
}

export function buildSecurityResourcePresentation(
  resource: SecurityResource,
  extraction: ResourceExtraction | null,
): SecurityResourcePresentation {
  return {
    preparedContent: extraction?.content?.trim() ?? '',
    sourceContent: resource.content.trim(),
    sourceLabel: resource.meta.sourceType === 'session_ref' ? '原始会话材料' : '原始材料',
  }
}
