import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketplaceResourceCard } from './MarketplaceSettings'

vi.mock('../../stores/marketplaceStore', () => ({
  useMarketplaceStore: () => ({}),
  groupMarketplaceResources: () => ({ skill: [], mcp: [], tool: [], agent: [] }),
}))

vi.mock('../../stores/skillStore', () => ({
  useSkillStore: () => vi.fn(),
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: () => [],
}))

vi.mock('../../stores/uiStore', () => ({
  useUIStore: Object.assign(() => vi.fn(), {
    getState: () => ({ theme: 'light' }),
  }),
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string, values?: Record<string, string>) => {
    if (key === 'settings.marketplace.risk.high') return '高风险'
    if (key === 'settings.marketplace.publisher') return `发布者：${values?.value ?? ''}`
    if (key === 'settings.marketplace.license') return `许可证：${values?.value ?? ''}`
    if (key === 'settings.marketplace.sourceRepository') return '查看上游仓库'
    return key
  },
}))

afterEach(cleanup)

const describeUi = typeof document === 'undefined' ? describe.skip : describe

describeUi('MarketplaceResourceCard', () => {
  it('shows source, license, and authorization risk for reviewed resources', () => {
    render(
      <MarketplaceResourceCard
        resource={{
          id: 'skill.secskills',
          type: 'skill',
          name: 'SecSkills',
          version: '1.1.0',
          publisher: 'Arenbai',
          sourceRepository: 'https://github.com/Arenbai/SecSkills',
          license: 'MIT',
          riskLevel: 'high',
          requiresExplicitAuthorization: true,
        }}
        isApplying={false}
        onInstall={vi.fn()}
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onUninstall={vi.fn()}
      />,
    )

    expect(screen.getByText(/Arenbai/)).toBeTruthy()
    expect(screen.getByText(/MIT/)).toBeTruthy()
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://github.com/Arenbai/SecSkills')
    expect(document.body.textContent).toContain('高风险')
  })
})
