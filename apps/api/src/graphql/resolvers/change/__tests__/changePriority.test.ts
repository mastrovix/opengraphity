/**
 * Priorità della Change = **tipo × fascia di rischio** (decisione del
 * prodotto: non Impatto×Urgenza), dalla MATRICE DEL CLIENTE (ondata 7 · B-14).
 *
 * ## Contratto rinegoziato, e perché — due punti, dichiarati
 *
 *  1. `deriveChangePriority` era sincrona e con la cascata di `if` sui nomi di
 *     fabbrica. Ora prende il tenant, valida il tipo contro il vocabolario
 *     `change_type` del cliente e legge la matrice `change_priority`. Il caso
 *     «tipo assente → trattato come normal» **non esiste più**: chi chiama
 *     senza tipo è il difetto (un `major` diventava `normal` in silenzio), e
 *     l'assenza è un rifiuto. Il default per l'assenza vive in un posto solo,
 *     `DEFAULT_CHANGE_TYPE` in `services/changeCreationService.ts`, dove è
 *     dichiarato e validato.
 *
 *  2. **Una cella cambia valore**: `normal` con rischio valutato ≤ 30 dava
 *     `low` e ora dà `medium`. Il seme della matrice — che non è modificabile
 *     da quest'ondata — ha `normal|low = medium`, e con tre sole fasce
 *     (`risk_band = low|medium|high`) il rischio NON ancora valutato deve
 *     cadere in una di esse: cade nella più bassa. Le due letture sono
 *     incompatibili, e si è tenuta quella che conserva il comportamento della
 *     **creazione** (rischio null → `medium` per una normale), che è il caso
 *     che riguarda ogni change appena aperta; l'altro riguarda solo le normali
 *     già valutate a basso rischio, che passano da P4 a P3. Dichiarato nel
 *     rapporto dell'ondata 7.
 *
 * Le SOGLIE (30 / 60) **non sono più nel codice** (revisione delle otto ondate ·
 * C·N-2, e l'aperto n. 7 dell'ondata 7): erano lette per posizione
 * (`bands[0..2]`), quindi riordinare il vocabolario invertiva le fasce in
 * silenzio — e la matrice trovava poi una cella valida, cioè una priorità
 * plausibile e sbagliata — e una quarta fascia era irraggiungibile. Adesso sono
 * dato del cliente (`lib/riskBands.ts`), seminate con quelle che il codice
 * usava: il primo giorno non cambia niente, ed è quello che questi test
 * verificano.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** Le soglie salvate sul tenant (null = non dichiarate → quelle di fabbrica). */
let thresholdsRaw: string | null = null
/** La riga della matrice salvata (records vuoto = il seme del prodotto). */
let matrixRecords: Array<{ get: (k: string) => unknown }> = []

/**
 * Una sola `executeRead` per due letture diverse (la matrice e le soglie del
 * tenant): si smista sul testo della query, perché è quello che distingue le
 * due nel codice vero.
 */
const executeRead = vi.fn(async (work: (tx: { run: (c: string) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> }) => unknown) =>
  work({
    run: async (cypher: string) => (cypher.includes('risk_band_thresholds')
      ? { records: [{ get: (k: string) => (k === 'raw' ? thresholdsRaw : null) }] }
      : { records: matrixRecords }),
  }),
)
const close = vi.fn().mockResolvedValue(undefined)
const loadTenantEnumOverrides = vi.fn()

vi.mock('@opengraphity/neo4j', () => ({ getSession: () => ({ executeRead, close }) }))
vi.mock('../../../../lib/enumScope.js', () => ({ loadTenantEnumOverrides }))

const { deriveChangePriority, riskBandOf, determineApprovalRoute } = await import('../scoring.js')
const { clearDomainCaches, DOMAIN_MATRIX_SEEDS } = await import('../../../../lib/domainMatrix.js')
const { clearRiskBandCache } = await import('../../../../lib/riskBands.js')

function vocab(over: Record<string, string[]> = {}) {
  const base: Record<string, string[]> = {
    change_type: ['standard', 'normal', 'emergency'],
    risk_band:   ['low', 'medium', 'high'],
    priority:    ['low', 'medium', 'high', 'critical'],
    ...over,
  }
  return new Map(Object.entries(base).map(([name, values]) => [name, { id: `e-${name}`, name, values }]))
}

/** Nessun nodo salvato → il seme del prodotto. */
function factoryMatrix() {
  matrixRecords = []
}

/** La matrice salvata del cliente. */
function savedMatrix(entries: Record<string, string>) {
  matrixRecords = [{ get: (k: string) => (k === 'entries' ? JSON.stringify(entries) : null) }]
}

beforeEach(() => {
  clearDomainCaches(); clearRiskBandCache()
  loadTenantEnumOverrides.mockResolvedValue(vocab())
  factoryMatrix()
  // Soglie non dichiarate: `riskBandThresholds` usa quelle di fabbrica sui
  // valori del cliente — cioè esattamente il comportamento di prima.
  thresholdsRaw = null
})

/**
 * La matrice di fabbrica, trascritta dal codice che sostituisce
 * (`deriveChangePriority` prima dell'ondata 7). Le colonne sono due regole
 * DISTINTE, non una: «rischio non valutato» ha la sua matrice
 * (`change_priority_initial`), perché non è la stessa cosa di «rischio
 * basso» — una change appena creata e una con rischio misurato basso avevano
 * priorità diverse, e collassarle cambierebbe la priorità di ogni change a
 * rischio basso.
 *
 *              non valutato | rischio low  medium   high
 *   standard        low      |         low  low      medium
 *   normal          medium   |         low  medium   high
 *   emergency       high     |         high high     critical
 */
const cases: Array<[string, number | null, string]> = [
  ['standard',  null, 'low'],    ['standard',  10, 'low'],  ['standard',  45, 'low'],    ['standard',  80, 'medium'],
  ['normal',    null, 'medium'], ['normal',    30, 'low'],  ['normal',    60, 'medium'], ['normal',    61, 'high'],
  ['emergency', null, 'high'],   ['emergency', 0,  'high'], ['emergency', 50, 'high'],   ['emergency', 99, 'critical'],
]

describe('deriveChangePriority — dalla matrice del cliente', () => {
  for (const [type, risk, expected] of cases) {
    it(`${type} × rischio ${String(risk)} → ${expected}`, async () => {
      clearDomainCaches(); factoryMatrix()
      expect(await deriveChangePriority('c-one', type, risk)).toBe(expected)
    })
  }

  it('un tipo aggiunto dal cliente è tradotto dalla SUA matrice, non schiacciato su «normal»', async () => {
    // Il difetto B-14: `['standard','normal','emergency'].includes(x) ? x : 'normal'`.
    loadTenantEnumOverrides.mockResolvedValue(vocab({ change_type: ['standard', 'normal', 'emergency', 'major'] }))
    savedMatrix({ ...DOMAIN_MATRIX_SEEDS.change_priority, 'major|low': 'high', 'major|medium': 'critical', 'major|high': 'critical' })
    expect(await deriveChangePriority('c-one', 'major', 70)).toBe('critical')
  })

  it('un tipo fuori vocabolario è un rifiuto che elenca gli ammessi', async () => {
    await expect(deriveChangePriority('c-one', 'inventato', null))
      .rejects.toThrow(/change_type: "inventato" non è nel vocabolario di questo cliente. Ammessi: standard, normal, emergency/)
  })

  it('il tipo ASSENTE è un rifiuto: prima diventava «normal» in silenzio', async () => {
    await expect(deriveChangePriority('c-one', null, null)).rejects.toThrow(/change_type: valore assente/)
    await expect(deriveChangePriority('c-one', undefined, 70)).rejects.toThrow(/change_type: valore assente/)
  })

  it('un tipo aggiunto SENZA la cella nella matrice nomina la combinazione, non ripiega', async () => {
    loadTenantEnumOverrides.mockResolvedValue(vocab({ change_type: ['standard', 'normal', 'emergency', 'major'] }))
    await expect(deriveChangePriority('c-one', 'major', 70))
      .rejects.toThrow(/Matrice "change_priority".*change_type="major", risk_band="high"/s)
  })
})

describe('riskBandOf — le soglie sono dato del cliente, non posizioni (revisione · C·N-2)', () => {
  it('senza soglie dichiarate usa quelle di fabbrica sui nomi del cliente: nulla cambia', async () => {
    loadTenantEnumOverrides.mockResolvedValue(vocab({ risk_band: ['bassa', 'media', 'alta'] }))
    expect(await riskBandOf('c-one', 10)).toBe('bassa')
    expect(await riskBandOf('c-one', 45)).toBe('media')
    expect(await riskBandOf('c-one', 90)).toBe('alta')
  })

  it('le soglie DICHIARATE vincono, e possono essere quante il cliente vuole', async () => {
    // Il difetto: `bands[0..2]` ignorava la quarta fascia, la matrice
    // pretendeva le sue celle e nessuno diceva che non sarebbero mai scattate.
    loadTenantEnumOverrides.mockResolvedValue(vocab({ risk_band: ['minimo', 'basso', 'alto', 'estremo'] }))
    thresholdsRaw = JSON.stringify([
      { band: 'minimo', upTo: 10 }, { band: 'basso', upTo: 40 },
      { band: 'alto', upTo: 80 }, { band: 'estremo', upTo: 100 },
    ])
    expect(await riskBandOf('c-one', 5)).toBe('minimo')
    expect(await riskBandOf('c-one', 40)).toBe('basso')
    expect(await riskBandOf('c-one', 81)).toBe('estremo')
  })

  it('l\'ORDINE del vocabolario non decide più niente', async () => {
    // Prima: riordinare (o rinominare, che spostava in coda) invertiva le
    // fasce in silenzio — `riskBandOf(10)` restituiva `medium` e
    // `riskBandOf(80)` la fascia bassa rinominata.
    loadTenantEnumOverrides.mockResolvedValue(vocab({ risk_band: ['media', 'alta', 'bassa'] }))
    thresholdsRaw = JSON.stringify([{ band: 'bassa', upTo: 30 }, { band: 'media', upTo: 60 }, { band: 'alta', upTo: 100 }])
    expect(await riskBandOf('c-one', 10)).toBe('bassa')
    expect(await riskBandOf('c-one', 80)).toBe('alta')
  })

  it('rischio non valutato non ha una fascia: chi lo chiede sbaglia strada', async () => {
    // «Non valutato» non è «basso»: ha la sua matrice
    // (`change_priority_initial`). Se qualcuno lo facesse cadere nella fascia
    // più bassa, ogni change a rischio basso cambierebbe priorità in silenzio.
    await expect(riskBandOf('c-one', null)).rejects.toThrow(/change_priority_initial/)
    await expect(riskBandOf('c-one', undefined)).rejects.toThrow(/change_priority_initial/)
  })

  it('le soglie di fabbrica coincidono con determineApprovalRoute (30 / 60 inclusivi)', async () => {
    for (const score of [0, 10, 30, 31, 60, 61, 90]) {
      expect(await riskBandOf('c-one', score), `score ${score}`).toBe(determineApprovalRoute(score))
    }
  })

  it('vocabolario senza tre valori e soglie non dichiarate → si ferma e dice di dichiararle', async () => {
    loadTenantEnumOverrides.mockResolvedValue(vocab({ risk_band: ['bassa', 'alta'] }))
    await expect(riskBandOf('c-one', 50))
      .rejects.toThrow(/non sono dichiarate e il vocabolario "risk_band" ha 2 valori.*Dichiara le soglie/s)
  })

  it('una fascia dichiarata FUORI vocabolario è un errore che la nomina', async () => {
    loadTenantEnumOverrides.mockResolvedValue(vocab({ risk_band: ['bassa', 'media', 'alta'] }))
    thresholdsRaw = JSON.stringify([{ band: 'bassa', upTo: 30 }, { band: 'medium', upTo: 60 }, { band: 'alta', upTo: 100 }])
    await expect(riskBandOf('c-one', 50)).rejects.toThrow(/citano "medium", che non è \(più\) nel vocabolario/)
  })

  it('soglie che non arrivano a 100 sono un errore: un punteggio resterebbe senza fascia', async () => {
    loadTenantEnumOverrides.mockResolvedValue(vocab({ risk_band: ['bassa', 'media', 'alta'] }))
    thresholdsRaw = JSON.stringify([{ band: 'bassa', upTo: 30 }, { band: 'media', upTo: 60 }, { band: 'alta', upTo: 90 }])
    await expect(riskBandOf('c-one', 95)).rejects.toThrow(/si fermano a 90 e un punteggio più alto non avrebbe fascia/)
  })
})
