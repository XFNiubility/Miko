export const CHAT_TOOLBAR_COMPACT_WIDTH = 780

export function shouldCompactChatToolbar(width: number): boolean {
  return Number.isFinite(width) && width > 0 && width < CHAT_TOOLBAR_COMPACT_WIDTH
}
