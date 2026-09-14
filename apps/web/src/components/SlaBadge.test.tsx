/** Giro nel browser del 14 set 2026 (#25): «1g 23h» con l'interfaccia inglese. */
import { describe, it, expect } from 'vitest'
import { screen, cleanup } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import i18n from '@/i18n/i18n'
import { SlaBadge } from './SlaBadge'

const sla = (hoursLeft: number) => {
  const now = Date.now()
  return {
    startedAt: new Date(now - 3600_000).toISOString(),
    responseDeadline: new Date(now - 60_000).toISOString(),
    resolveDeadline: new Date(now + hoursLeft * 3600_000 + 30_000).toISOString(),
    responseMet: true, resolveMet: false, breached: false, pausedAt: null,
  }
}

describe('SlaBadge — durata nella lingua attiva', () => {
  it('in inglese i giorni sono «d», in italiano «gg»', async () => {
    renderWithProviders(<SlaBadge sla={sla(47)} />)
    expect(screen.getByText(/1 d 23 h/)).toBeTruthy()
    cleanup()
    await i18n.changeLanguage('it')
    try {
      renderWithProviders(<SlaBadge sla={sla(47)} />)
      expect(screen.getByText(/1 gg 23 h/)).toBeTruthy()
    } finally {
      await i18n.changeLanguage('en')
    }
  })
})
