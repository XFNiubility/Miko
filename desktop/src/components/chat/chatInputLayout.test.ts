import { describe, expect, it } from 'vitest'
import {
  CHAT_TOOLBAR_COMPACT_WIDTH,
  resolveChatToolbarCompaction,
  shouldCompactChatToolbar,
} from './chatInputLayout'

describe('shouldCompactChatToolbar', () => {
  it('compacts secondary controls before the toolbar can overflow', () => {
    expect(shouldCompactChatToolbar(CHAT_TOOLBAR_COMPACT_WIDTH - 1)).toBe(true)
    expect(shouldCompactChatToolbar(CHAT_TOOLBAR_COMPACT_WIDTH)).toBe(false)
  })

  it('ignores unavailable measurements', () => {
    expect(shouldCompactChatToolbar(0)).toBe(false)
    expect(shouldCompactChatToolbar(Number.NaN)).toBe(false)
  })

  it('keeps primary control labels on narrow desktop composers', () => {
    expect(resolveChatToolbarCompaction({
      forcedCompact: false,
      isMobileComposer: false,
      measuredCompact: true,
    })).toEqual({ secondaryControls: true, primaryControls: false })
  })

  it('keeps primary control labels when a desktop side panel forces compact layout', () => {
    expect(resolveChatToolbarCompaction({
      forcedCompact: true,
      isMobileComposer: false,
      measuredCompact: false,
    })).toEqual({ secondaryControls: true, primaryControls: false })
  })

  it('uses icon-only primary controls only in the mobile composer', () => {
    expect(resolveChatToolbarCompaction({
      forcedCompact: false,
      isMobileComposer: true,
      measuredCompact: false,
    })).toEqual({ secondaryControls: true, primaryControls: true })
  })
})
