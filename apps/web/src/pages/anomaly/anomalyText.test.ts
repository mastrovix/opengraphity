/** Giro nel browser del 14 set 2026 (#57): titoli e frasi delle anomalie in italiano con l'interfaccia inglese. */
import { describe, it, expect } from 'vitest'
import i18n from '@/i18n/i18n'
import { anomalyTitle, anomalyDescription } from './AnomalyPage'

const t = i18n.t.bind(i18n) as unknown as (k: string, o?: Record<string, string>) => string
const spof = { ruleKey: 'spof', title: 'Single Point of Failure', description: 'CI con 7 dipendenti diretti — potenziale SPOF', descriptionParams: [{ key: 'count', value: '7' }] }

describe('testo delle anomalie', () => {
  it('la frase si compone nella lingua attiva dai parametri', async () => {
    expect(anomalyDescription(t, spof)).toBe('CI with 7 direct dependents: potential single point of failure')
    await i18n.changeLanguage('it')
    try {
      expect(anomalyTitle(t, { ruleKey: 'missing_owner', title: 'CI Without Owner' })).toBe('CI Senza Owner')
      expect(anomalyDescription(t, spof)).toBe('CI con 7 dipendenti diretti: potenziale single point of failure')
    } finally { await i18n.changeLanguage('en') }
  })

  it('un\'anomalia storica senza parametri mostra la frase registrata', () => {
    expect(anomalyDescription(t, { ...spof, descriptionParams: null })).toBe(spof.description)
  })
})
