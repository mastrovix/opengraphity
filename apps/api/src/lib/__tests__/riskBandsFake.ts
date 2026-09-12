/**
 * Il doppio di `lib/riskBands.ts` per i test che NON parlano di soglie.
 *
 * Stessa ragione di `domainMatrixFake.ts`: dal rimedio 3 le soglie delle fasce
 * di rischio sono **dato del cliente**, quindi `deriveChangePriority` legge il
 * tenant anche solo per sapere che fascia è un punteggio. I test che misurano
 * altro (la rotta d'approvazione, la creazione di una change) mockano la
 * sessione con le sole query che loro guardano: far passare anche questa da lì
 * vorrebbe dire insegnare a ognuno una query in più.
 *
 * Questo modulo risponde con le soglie **di fabbrica** (≤30, ≤60, il resto) sui
 * valori del vocabolario spedito, senza grafo:
 *
 *     vi.mock('../../lib/riskBands.js', () => import('../../lib/__tests__/riskBandsFake.js'))
 *
 * Il fail-loud resta dov'era: «rischio non valutato» lancia con lo stesso
 * messaggio del vero. I numeri sono ricopiati a mano (un mock non può importare
 * ciò che sostituisce) e `domainMatrixFake.test.ts` li confronta con la fonte
 * vera, quindi non possono divergere in silenzio.
 */
export const MAX_RISK_SCORE = 100
export const FACTORY_RISK_THRESHOLDS: readonly number[] = [30, 60, MAX_RISK_SCORE]

export interface RiskBandThreshold { band: string; upTo: number }

/** I nomi spediti col prodotto, nell'ordine della scala. */
const SHIPPED_BANDS = ['low', 'medium', 'high'] as const

export function factoryThresholdsFor(bands: readonly string[]): RiskBandThreshold[] | null {
  if (bands.length !== FACTORY_RISK_THRESHOLDS.length) return null
  return bands.map((band, i) => ({ band, upTo: FACTORY_RISK_THRESHOLDS[i]! }))
}

export function riskBandThresholds(_tenantId: string): Promise<readonly RiskBandThreshold[]> {
  return Promise.resolve(factoryThresholdsFor(SHIPPED_BANDS)!)
}

export function riskBandOf(_tenantId: string, aggregateRiskScore: number | null | undefined): Promise<string> {
  if (aggregateRiskScore == null) {
    return Promise.reject(new Error('riskBandOf: il rischio non valutato non ha una fascia — usa la matrice change_priority_initial'))
  }
  const hit = factoryThresholdsFor(SHIPPED_BANDS)!.find((t) => aggregateRiskScore <= t.upTo)
  if (!hit) return Promise.reject(new Error(`riskBandOf: punteggio ${String(aggregateRiskScore)} oltre l'ultima soglia`))
  return Promise.resolve(hit.band)
}

export function setRiskBandThresholds(): Promise<readonly RiskBandThreshold[]> {
  return Promise.reject(new Error('riskBandsFake: questo doppio non scrive. Il test che misura la scrittura usi il modulo vero.'))
}

export function clearRiskBandCache(): void { /* il doppio non ha cache */ }
