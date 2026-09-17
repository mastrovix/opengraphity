import { describe, it, expect, vi } from 'vitest'

vi.mock('../tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it'), languageForUser: vi.fn(async () => 'it') }))

const { SYSTEM_TEXTS, systemTextIn, systemText, formatInstantIn, LINGUE } = await import('../systemText.js')

describe('systemText: i testi che il prodotto scrive nei ticket', () => {
  it('ogni chiave ha ogni lingua, e gli stessi parametri in ogni lingua', () => {
    for (const [key, byLang] of Object.entries(SYSTEM_TEXTS)) {
      const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
      for (const l of LINGUE) {
        expect((byLang as Record<string, string>)[l], `${key}.${l}`).toBeTruthy()
        expect(params((byLang as Record<string, string>)[l]!), `${key}.${l}`).toEqual(params(byLang.en))
      }
    }
  })

  it('risolve nella lingua del cliente e sostituisce i parametri', async () => {
    expect(systemTextIn('en', 'incident.reassignedTeam', { team: 'Service Desk' })).toBe('Reassigned to team Service Desk')
    expect(await systemText('t1', 'incident.reassignedTeam', { team: 'Service Desk' })).toBe('Riassegnato al team Service Desk')
  })

  it('un parametro mancante è un errore', () => {
    expect(() => systemTextIn('en', 'incident.reassignedTeam')).toThrow(/missing parameter "team"/)
  })

  it('le date nella lingua e nel fuso del cliente, non ISO', () => {
    // Giro del 14 set 2026 (#51): «Sep 14, 2026, 1:07 AM» era la convenzione americana.
    expect(formatInstantIn('en', '2026-09-13T11:30:11.938Z', 'Europe/Rome')).toMatch(/^13 Sept? 2026, 13:30$/)
    expect(formatInstantIn('it', '2026-09-13T11:30:11.938Z', 'Europe/Rome')).toBe('13 set 2026, 13:30')
  })
})
