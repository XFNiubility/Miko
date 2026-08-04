import { describe, expect, it } from 'vitest'
import { CHAT_TOOLBAR_COMPACT_WIDTH, shouldCompactChatToolbar } from './chatInputLayout'

describe('shouldCompactChatToolbar', () => {
  it('uses icon controls before the toolbar can wrap or overflow', () => {
    expect(shouldCompactChatToolbar(CHAT_TOOLBAR_COMPACT_WIDTH - 1)).toBe(true)
    expect(shouldCompactChatToolbar(CHAT_TOOLBAR_COMPACT_WIDTH)).toBe(false)
  })

  it('ignores unavailable measurements', () => {
    expect(shouldCompactChatToolbar(0)).toBe(false)
    expect(shouldCompactChatToolbar(Number.NaN)).toBe(false)
  })
})
