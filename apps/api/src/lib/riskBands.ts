/**
 * Le **soglie** delle fasce di rischio come dato del cliente (revisione delle
 * otto ondate · C·N-2, punto 2 dei «modi di rompere»; e l'aperto n. 7
 * dell'ondata 7, «soglie del punteggio di rischio in codice»).
 *
 * ## Il difetto
 * `riskBandOf` leggeva il vocabolario `risk_band` per **posizione**:
 * `bands[0]` = fascia bassa, `bands[1]` = media, `bands[2]` = alta, con le
 * soglie 30 e 60 scritte nel codice. Due conseguenze, misurate nella revisione:
 *
 *  1. rinominare un valore lo spostava in fondo (il Dizionario sapeva solo
 *     aggiungere in coda), e le fasce si **invertivano**: `riskBandOf(10)`
 *     restituiva `medium` e `riskBandOf(80)` restituiva il valore rinominato.
 *     `deriveChangePriority` trovava poi una cella valida della matrice e
 *     restituiva una priorità plausibile e sbagliata — nessun errore, da
 *     nessuna parte. (La rinomina ora conserva la posizione, ma la dipendenza
 *     dalla posizione restava.)
 *  2. una **quarta** fascia era irraggiungibile: `bands[0..2]` la ignora, la
 *     matrice `change_priority` pretendeva 3×4 = 12 celle, tre delle quali non
 *     sarebbero mai scattate, e nessuno lo diceva. L'admin le compilava e
 *     credeva che valessero. Il caso `bands.length < 3` era un errore
 *     esplicito; «più di tre» era stato dimenticato.
 *
 * ## La regola
 * Una lista ordinata sul tenant: `[{band, upTo}]`, dove `upTo` è il punteggio
 * **massimo** incluso in quella fascia. La lista copre 0..100, ogni banda è un
 * valore del vocabolario `risk_band` **del cliente**, e le soglie crescono.
 * Quante fasce vuole il cliente non lo decide più il codice.
 *
 * Il primo giorno non cambia niente: la migrazione semina esattamente le soglie
 * che il codice usava (≤30, ≤60, il resto) sui primi tre valori del vocabolario.
 */
import { getSession } from '@opengraphity/neo4j'
import { ValidationError } from './errors.js'
import { assertDomainValue, domainVocabulary } from './domainMatrix.js'
import { createMetamodelCache } from './metamodelCache.js'
import { invalidateSchema } from './schemaInvalidator.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'risk-bands' })

/** Il punteggio massimo: il rischio aggregato è una percentuale. */
export const MAX_RISK_SCORE = 100

export interface RiskBandThreshold {
  band: string
  /** Punteggio massimo incluso in questa fascia (l'ultima arriva sempre a 100). */
  upTo: number
}

/** Le soglie che il codice usava: `≤ 30` bassa, `≤ 60` media, il resto alta. */
export const FACTORY_RISK_THRESHOLDS: readonly number[] = [30, 60, MAX_RISK_SCORE]

/**
 * Le soglie di fabbrica per un vocabolario: i primi tre valori con 30/60/100.
 * Se il vocabolario ha più (o meno) di tre valori non si inventa niente — è il
 * caso in cui il cliente deve dichiararle, e chi chiama lo dice.
 */
export function factoryThresholdsFor(bands: readonly string[]): RiskBandThreshold[] | null {
  if (bands.length !== FACTORY_RISK_THRESHOLDS.length) return null
  return bands.map((band, i) => ({ band, upTo: FACTORY_RISK_THRESHOLDS[i]! }))
}

const cache = createMetamodelCache<readonly RiskBandThreshold[]>({
  name: 'risk-band-thresholds',
  load: (tenantId) => loadThresholds(tenantId),
})

/** Solo per i test. */
export function clearRiskBandCache(): void {
  cache.clear()
  notDeclared.clear()
}

/** Tenant per cui si è già detto che le soglie non sono dichiarate (un log per processo). */
const notDeclared = new Set<string>()

/**
 * Le soglie di questo cliente, in ordine crescente.
 *
 * La proprietà assente (tenant creato prima della migrazione) **non** è una
 * lista vuota: si usano quelle di fabbrica sui suoi valori, che è il
 * comportamento di prima, e si dice nei log. Se però il suo vocabolario non ha
 * tre valori, le soglie di fabbrica non esistono e l'operazione si ferma:
 * inventare una divisione del punteggio sarebbe la stessa scelta silenziosa di
 * prima, con un nome nuovo.
 */
export async function riskBandThresholds(tenantId: string): Promise<readonly RiskBandThreshold[]> {
  return cache.get(tenantId)
}

async function loadThresholds(tenantId: string): Promise<readonly RiskBandThreshold[]> {
  const session = getSession()
  try {
    const r = await session.executeRead((tx) =>
      tx.run('MATCH (t:Tenant {id: $tenantId}) RETURN t.risk_band_thresholds AS raw', { tenantId }),
    )
    if (!r.records.length) throw new Error(`Tenant ${tenantId} inesistente: non si possono stabilire le fasce di rischio`)
    const raw = r.records[0].get('raw')

    const bands = await domainVocabulary(tenantId, 'risk_band')
    if (raw == null) {
      const factory = factoryThresholdsFor(bands)
      if (!factory) {
        throw new ValidationError(
          `Le fasce di rischio di questo cliente non sono dichiarate e il vocabolario "risk_band" ha ` +
          `${String(bands.length)} valori (${bands.join(', ')}), non tre: non c'è una divisione del punteggio ` +
          `da usare di fabbrica. Dichiara le soglie in Impostazioni → Matrici di dominio.`,
        )
      }
      if (!notDeclared.has(tenantId)) {
        notDeclared.add(tenantId)
        log.info({ tenantId, thresholds: factory },
          'Le fasce di rischio non sono dichiarate sul tenant: si usano le soglie di fabbrica (≤30, ≤60, il resto), ' +
          'come prima (applica la migrazione 20260919_1610_risk_band_thresholds per renderle esplicite e modificabili)')
      }
      return factory
    }
    return parseThresholds(raw, tenantId, bands)
  } finally {
    await session.close()
  }
}

function parseThresholds(raw: unknown, tenantId: string, bands: readonly string[]): readonly RiskBandThreshold[] {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) }
    catch (e) { throw new Error(`Tenant ${tenantId}: risk_band_thresholds non è JSON valido (${e instanceof Error ? e.message : String(e)})`) }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Tenant ${tenantId}: risk_band_thresholds deve essere una lista non vuota di {band, upTo}`)
  }
  const out: RiskBandThreshold[] = []
  let previous = -1
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') throw new Error(`Tenant ${tenantId}: fascia di rischio non è un oggetto`)
    const e = entry as Record<string, unknown>
    const band = e['band']
    const upTo = e['upTo']
    if (typeof band !== 'string' || band === '') throw new Error(`Tenant ${tenantId}: fascia di rischio senza nome`)
    if (typeof upTo !== 'number' || !Number.isInteger(upTo)) throw new Error(`Tenant ${tenantId}: soglia di "${band}" non è un intero`)
    if (upTo <= previous) throw new Error(`Tenant ${tenantId}: le soglie devono crescere (${band} = ${String(upTo)} dopo ${String(previous)})`)
    if (!bands.includes(band)) {
      throw new ValidationError(
        `Le fasce di rischio di questo cliente citano "${band}", che non è (più) nel vocabolario "risk_band" ` +
        `(${bands.join(', ')}): correggile in Impostazioni → Matrici di dominio.`,
      )
    }
    previous = upTo
    out.push({ band, upTo })
  }
  const last = out[out.length - 1]!
  if (last.upTo < MAX_RISK_SCORE) {
    throw new Error(
      `Tenant ${tenantId}: le fasce di rischio si fermano a ${String(last.upTo)} e un punteggio più alto non ` +
      `avrebbe fascia. L'ultima deve arrivare a ${String(MAX_RISK_SCORE)}.`,
    )
  }
  return out
}

/**
 * La fascia per questo punteggio, secondo le soglie del cliente.
 *
 * Il rischio **non ancora valutato** (`null`) non passa da qui: è una regola
 * distinta, la matrice `change_priority_initial`. «Non valutato» e «basso» sono
 * due cose diverse, e collassarle cambierebbe in silenzio la priorità di ogni
 * change a rischio basso.
 */
export async function riskBandOf(tenantId: string, aggregateRiskScore: number | null | undefined): Promise<string> {
  if (aggregateRiskScore == null) {
    throw new Error('riskBandOf: il rischio non valutato non ha una fascia — usa la matrice change_priority_initial')
  }
  const thresholds = await riskBandThresholds(tenantId)
  const hit = thresholds.find((t) => aggregateRiskScore <= t.upTo)
  // Non può succedere (l'ultima soglia arriva a 100 e il punteggio è una
  // percentuale), ma se il punteggio uscisse dalla scala lo si dice invece di
  // ripiegare sulla fascia più alta.
  if (!hit) {
    throw new Error(
      `riskBandOf: punteggio ${String(aggregateRiskScore)} oltre l'ultima soglia ` +
      `(${String(thresholds[thresholds.length - 1]!.upTo)}) del cliente ${tenantId}.`,
    )
  }
  return hit.band
}

/**
 * Valida e salva le soglie. Ogni fascia deve essere nel vocabolario del
 * cliente, le soglie devono crescere e l'ultima arrivare a 100: una scala con
 * un buco lascerebbe dei punteggi senza fascia, cioè un errore nel momento
 * peggiore (l'apertura di una change).
 */
export async function setRiskBandThresholds(
  tenantId: string, entries: readonly RiskBandThreshold[],
): Promise<readonly RiskBandThreshold[]> {
  if (entries.length === 0) throw new ValidationError('Serve almeno una fascia di rischio.')
  const seen = new Set<string>()
  let previous = -1
  for (const e of entries) {
    await assertDomainValue(tenantId, 'risk_band', e.band)
    if (seen.has(e.band)) throw new ValidationError(`La fascia "${e.band}" compare due volte.`)
    seen.add(e.band)
    if (!Number.isInteger(e.upTo) || e.upTo < 0) {
      throw new ValidationError(`La soglia di "${e.band}" deve essere un intero ≥ 0 (ricevuto ${String(e.upTo)}).`)
    }
    if (e.upTo <= previous) {
      throw new ValidationError(
        `Le soglie devono crescere: "${e.band}" arriva a ${String(e.upTo)}, che non è più della fascia precedente ` +
        `(${String(previous)}). Le fasce si dichiarano dalla più bassa alla più alta.`,
      )
    }
    previous = e.upTo
  }
  const last = entries[entries.length - 1]!
  if (last.upTo !== MAX_RISK_SCORE) {
    throw new ValidationError(
      `L'ultima fascia ("${last.band}") deve arrivare a ${String(MAX_RISK_SCORE)}: altrimenti un punteggio più alto ` +
      `resterebbe senza fascia, e la priorità della change non si potrebbe calcolare.`,
    )
  }

  const session = getSession()
  try {
    const r = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (t:Tenant {id: $tenantId})
         SET t.risk_band_thresholds = $value, t.updated_at = $now
         RETURN t.risk_band_thresholds AS value`,
        { tenantId, value: JSON.stringify(entries), now: new Date().toISOString() },
      ),
    )
    if (!r.records.length) throw new ValidationError(`Tenant ${tenantId} inesistente`)
    // La leva unica (rimedio 1): svuota le cache di questo processo e lo dice
    // agli altri, worker compresi — è il worker che calcola le priorità.
    invalidateSchema(tenantId)
    return entries
  } finally {
    await session.close()
  }
}
