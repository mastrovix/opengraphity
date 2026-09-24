/** Giro nel browser del 14 set 2026 (#25): «1g 23h» con l'interfaccia inglese. */
import { describe, it, expect } from 'vitest'
import { screen, cleanup } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import i18n from '@/i18n/i18n'
import { SlaBadge } from './SlaBadge'

const sla = (hoursLeft: number, warningMinutes = 30) => {
  const now = Date.now()
  return {
    startedAt: new Date(now - 3600_000).toISOString(),
    responseDeadline: new Date(now - 60_000).toISOString(),
    resolveDeadline: new Date(now + hoursLeft * 3600_000 + 30_000).toISOString(),
    responseMet: true, resolveMet: false, breached: false, pausedAt: null, warningMinutes,
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

/**
 * Verifica «Cosa resta cablato», ondata 1: il giallo seguiva una soglia del
 * badge (25% della finestra o 30 minuti), mentre l'avviso inviato usa i minuti
 * di preavviso della policy. Ora badge e avviso concordano.
 */
describe('SlaBadge — preavviso della policy', () => {
  const background = (text: RegExp) => (screen.getByText(text).closest('span') as HTMLElement).style.background

  it('3 ore alla scadenza: in scadenza con preavviso di 240 minuti, nei tempi con 60', () => {
    renderWithProviders(<SlaBadge sla={sla(3, 240)} />)
    const warning = background(/3 h/)
    cleanup()
    renderWithProviders(<SlaBadge sla={sla(3, 60)} />)
    const ontrack = background(/3 h/)
    expect(warning).not.toBe(ontrack)
    expect(warning).toContain('warning')
  })

  it('20 minuti alla scadenza con preavviso di 10: nei tempi (prima diventava gialla ai 30 minuti fissi)', () => {
    renderWithProviders(<SlaBadge sla={sla(20 / 60, 10)} />)
    expect(background(/min/)).not.toContain('warning')
  })
})

/** Tour of 24 Sep 2026, G14: a late response left no trace once the ticket was taken. */
describe('SlaBadge — a late response stays said', () => {
  it('after the response: the resolve countdown, and «response late by» when it came after its deadline', () => {
    const late = { ...sla(30), respondedAt: new Date(Date.parse(sla(30).responseDeadline) + 37 * 60_000).toISOString() }
    renderWithProviders(<SlaBadge sla={late} />)
    expect(screen.getByText(/1 d 6 h left/)).toBeTruthy()
    expect(screen.getByText(/response late by 37 min/)).toBeTruthy()
  })

  it('an answer in time, one of an older SLA with no instant, and the compact badge say nothing more', () => {
    const inTime = { ...sla(30), respondedAt: new Date(Date.parse(sla(30).responseDeadline) - 5 * 60_000).toISOString() }
    renderWithProviders(<SlaBadge sla={inTime} />)
    renderWithProviders(<SlaBadge sla={{ ...sla(30), respondedAt: null }} />)
    const late = { ...sla(30), respondedAt: new Date(Date.parse(sla(30).responseDeadline) + 37 * 60_000).toISOString() }
    renderWithProviders(<SlaBadge sla={late} compact />)
    expect(screen.queryByText(/response late/)).toBeNull()
  })
})
