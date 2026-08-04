import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/chatStore', () => {
  const setSessionSecurityMode = vi.fn()
  return {
    useChatStore: (selector: (state: unknown) => unknown) => selector({
      sessions: {
        'session-1': {
          securityModeEnabled: false,
          securityModeTarget: '',
        },
      },
      setSessionSecurityMode,
    }),
  }
})

vi.mock('../../stores/tabStore', () => ({
  useTabStore: (selector: (state: unknown) => unknown) => selector({
    activeTabId: 'session-1',
  }),
}))

import { useChatStore } from '../../stores/chatStore'
import { SecurityModeSelector } from './SecurityModeSelector'

const describeUi = typeof document === 'undefined' ? describe.skip : describe

function getSetSessionSecurityModeMock() {
  return useChatStore((state) => state.setSessionSecurityMode) as ReturnType<typeof vi.fn>
}

afterEach(() => {
  cleanup()
  getSetSessionSecurityModeMock().mockReset()
})

describeUi('SecurityModeSelector', () => {
  it('keeps the menu within the viewport and does not offer a manual target preset', () => {
    render(<SecurityModeSelector />)

    fireEvent.click(screen.getByRole('button', { name: '探索模式' }))

    const menu = screen.getByRole('menu')
    expect(menu.className).toContain('right-0')
    expect(menu.className).toContain('max-w-[calc(100vw-1.5rem)]')
    expect(screen.queryByText('目标（可选，不填则从对话推导）')).toBeNull()
    expect(screen.queryByPlaceholderText('目标 URL / 路径 / 主题…')).toBeNull()
  })

  it('enables exploration without submitting a separate target', () => {
    render(<SecurityModeSelector />)

    fireEvent.click(screen.getByRole('button', { name: '探索模式' }))
    fireEvent.click(screen.getByRole('button', { name: '开启探索模式' }))
    fireEvent.click(screen.getByRole('button', { name: '开启' }))

    expect(getSetSessionSecurityModeMock()).toHaveBeenCalledWith('session-1', true)
  })
})