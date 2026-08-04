import { describe, expect, it } from 'vitest'
import type { ResourceExtraction, SecurityResource } from '../api/security'
import { buildSecurityResourcePresentation } from './securityResourcePresentation'

const resource: SecurityResource = {
  meta: {
    id: 'resource-1',
    title: '会话提取',
    kind: 'recon_result',
    tags: ['session'],
    summary: '',
    projectIds: [],
    sourceType: 'session_ref',
    sourceRefs: [{ type: 'session', id: 'session-1', title: '测试会话' }],
    createdAt: 1,
    updatedAt: 1,
  },
  content: '### 用户\n原始聊天记录',
  files: [],
}

const extraction: ResourceExtraction = {
  status: 'done',
  summary: '已整理目标和范围',
  content: '# 目标资产\n- example.net',
  items: [],
  warnings: [],
  updatedAt: 2,
}

describe('buildSecurityResourcePresentation', () => {
  it('presents agent-prepared content separately from the session transcript', () => {
    expect(buildSecurityResourcePresentation(resource, extraction)).toEqual({
      preparedContent: '# 目标资产\n- example.net',
      sourceContent: '### 用户\n原始聊天记录',
      sourceLabel: '原始会话材料',
    })
  })
})
