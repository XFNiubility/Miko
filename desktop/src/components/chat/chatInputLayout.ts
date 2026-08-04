export const CHAT_TOOLBAR_COMPACT_WIDTH = 780

export function shouldCompactChatToolbar(width: number): boolean {
  return Number.isFinite(width) && width > 0 && width < CHAT_TOOLBAR_COMPACT_WIDTH
}

type ChatToolbarCompactionOptions = {
  forcedCompact: boolean
  isMobileComposer: boolean
  measuredCompact: boolean
}

export function resolveChatToolbarCompaction({
  forcedCompact,
  isMobileComposer,
  measuredCompact,
}: ChatToolbarCompactionOptions) {
  return {
    secondaryControls: forcedCompact || isMobileComposer || measuredCompact,
    primaryControls: isMobileComposer,
  }
}
