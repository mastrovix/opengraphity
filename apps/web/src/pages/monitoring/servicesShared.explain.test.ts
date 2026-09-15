/**
 * Secondo giro UI del 15 set 2026 · V-9: a servizio «Operativo» per il minimo
 * di componenti la testata diceva «Operativo: SRV-APP-01 è giù (via …)», che
 * sembrava una contraddizione. Si dice quale regola tiene il servizio operativo
 * — e solo quella: dal vivo la prima versione diceva «soglie non raggiunte,
 * punteggio 22 contro una soglia dell'1%», cioè una soglia superata.
 */
import { describe, it, expect } from 'vitest'
import i18n from '@/i18n/i18n'
import { explanationSentence } from './servicesShared'

const t = i18n.t.bind(i18n)
const cause = { ci: { id: 'srv', name: 'SRV-APP-01', type: 'server', status: null, health: 'down' }, health: 'down', weight: 5, critical: false, path: [] }

describe('explanationSentence', () => {
  it('operativo sotto il minimo di componenti: dice il conteggio e il minimo, non il punteggio', () => {
    const text = explanationSentence(t, { health: 'operational', explanation: [cause] as never, impactScore: 22, rules: { degradedSharePct: 1, minNodes: 2 } })
    expect(text).toBe('Operational: 1 component is not operational, fewer than the 2 needed for the thresholds to apply. Not operational: SRV-APP-01 is down')
    expect(text).not.toContain('impact score')
  })

  it('operativo col punteggio sotto la soglia «degradato»: dice punteggio e soglia', () => {
    const text = explanationSentence(t, { health: 'operational', explanation: [cause] as never, impactScore: 22, rules: { degradedSharePct: 30, minNodes: 1 } })
    expect(text).toBe('Operational: the impact score 22 is below the degraded threshold of 30%. Not operational: SRV-APP-01 is down')
  })

  it('degradato resta la frase di sempre', () => {
    expect(explanationSentence(t, { health: 'degraded', explanation: [cause] as never, impactScore: 40, rules: { degradedSharePct: 30, minNodes: 1 } })).toBe('Degraded: SRV-APP-01 is down')
  })
})
