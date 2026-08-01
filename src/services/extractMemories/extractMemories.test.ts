import { afterEach, describe, expect, it } from 'bun:test'

import { shouldAttemptExtractMemoriesForMainAgent } from './extractMemories.js'

const originalKimoMemoryExtract = process.env.KIMO_MEMORY_EXTRACT

afterEach(() => {
  if (originalKimoMemoryExtract === undefined) {
    delete process.env.KIMO_MEMORY_EXTRACT
  } else {
    process.env.KIMO_MEMORY_EXTRACT = originalKimoMemoryExtract
  }
})

describe('extractMemories desktop auto-memory gate', () => {
  it('honors the desktop auto-memory env override without the official GrowthBook gate', () => {
    process.env.KIMO_MEMORY_EXTRACT = '1'

    expect(shouldAttemptExtractMemoriesForMainAgent(undefined)).toBe(true)
  })

  it('keeps subagents out of background memory extraction', () => {
    process.env.KIMO_MEMORY_EXTRACT = '1'

    expect(shouldAttemptExtractMemoriesForMainAgent('subagent-1')).toBe(false)
  })
})
