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
    // CONTRATTO RINEGOZIATO (revisione totale · G-MON-6): il conteggio dei non
    // operativi viene dal motore (`unhealthyCount`), non dalle cause, che sono
    // tagliate a 20. Senza quel campo si resta alla frase generica.
    const text = explanationSentence(t, { health: 'operational', explanation: [cause] as never, unhealthyCount: 1, impactScore: 22, rules: { degradedSharePct: 1, minNodes: 2 } })
    expect(text).toBe('Operational: 1 component is not operational, fewer than the 2 needed for the thresholds to apply. Not operational: SRV-APP-01 is down')
    expect(text).not.toContain('impact score')
  })

  it('operativo col punteggio sotto la soglia «degradato»: dice punteggio e soglia', () => {
    const text = explanationSentence(t, { health: 'operational', explanation: [cause] as never, unhealthyCount: 1, impactScore: 22, rules: { degradedSharePct: 30, minNodes: 1 } })
    expect(text).toBe('Operational: the impact score 22 is below the degraded threshold of 30%. Not operational: SRV-APP-01 is down')
  })

  /**
   * G-MON-6: con 22 componenti non operativi e 20 cause, la frase diceva «20
   * componenti non operativi, meno dei 25 previsti» — un numero che non
   * esisteva. Ora il numero e quello del motore.
   */
  it('oltre 20 cause il conteggio e quello del motore, non la lunghezza delle cause', () => {
    const venti = Array.from({ length: 20 }, () => cause)
    const text = explanationSentence(t, { health: 'operational', explanation: venti as never, unhealthyCount: 22, impactScore: 22, rules: { degradedSharePct: 1, minNodes: 25 } })
    expect(text).toContain('22 components are not operational, fewer than the 25 needed')
    expect(text).not.toContain('20 components are not operational')
  })

  /** Una mappa non ancora rivalutata non ha il conteggio: frase generica, nessun numero inventato. */
  it('senza unhealthyCount resta la frase generica', () => {
    const text = explanationSentence(t, { health: 'operational', explanation: [cause] as never, unhealthyCount: null, impactScore: 22, rules: { degradedSharePct: 1, minNodes: 2 } })
    expect(text).toBe('Operational: SRV-APP-01 is down')
  })

  it('degradato resta la frase di sempre', () => {
    expect(explanationSentence(t, { health: 'degraded', explanation: [cause] as never, impactScore: 40, rules: { degradedSharePct: 30, minNodes: 1 } })).toBe('Degraded: SRV-APP-01 is down')
  })
})
