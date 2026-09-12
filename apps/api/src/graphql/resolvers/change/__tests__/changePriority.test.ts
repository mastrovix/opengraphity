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
 * Le SOGLIE (30 / 60) restano nel codice — `riskBandOf` — ed è un limite
 * dichiarato: sono un modello di punteggio, non una traduzione fra valori di
 * dominio. Configurabili sono i NOMI delle fasce e la matrice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const executeRead = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
const loadTenantEnumOverrides = vi.fn()

vi.mock('@opengraphity/neo4j', () => ({ getSession: () => ({ executeRead, close }) }))
vi.mock('../../../../lib/enumScope.js', () => ({ loadTenantEnumOverrides }))

const { deriveChangePriority, riskBandOf, determineApprovalRoute } = await import('../scoring.js')
const { clearDomainCaches, DOMAIN_MATRIX_SEEDS } = await import('../../../../lib/domainMatrix.js')

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
  executeRead.mockReset()
  executeRead.mockResolvedValue({ records: [] })
}

beforeEach(() => {
  vi.clearAllMocks(); clearDomainCaches()
  loadTenantEnumOverrides.mockResolvedValue(vocab())
  factoryMatrix()
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
    executeRead.mockReset()
    executeRead.mockResolvedValue({
      records: [{ get: (k: string) => (k === 'entries' ? JSON.stringify({ ...DOMAIN_MATRIX_SEEDS.change_priority, 'major|low': 'high', 'major|medium': 'critical', 'major|high': 'critical' }) : null) }],
    })
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

describe('riskBandOf — le soglie restano nel codice, i nomi no', () => {
  it('i nomi delle fasce vengono dal vocabolario del cliente', () => {
    expect(riskBandOf(10, ['bassa', 'media', 'alta'])).toBe('bassa')
    expect(riskBandOf(45, ['bassa', 'media', 'alta'])).toBe('media')
    expect(riskBandOf(90, ['bassa', 'media', 'alta'])).toBe('alta')
  })

  it('rischio non valutato non ha una fascia: chi lo chiede sbaglia strada', () => {
    // «Non valutato» non è «basso»: ha la sua matrice
    // (`change_priority_initial`). Se qualcuno lo facesse cadere nella fascia
    // più bassa, ogni change a rischio basso cambierebbe priorità in silenzio.
    expect(() => riskBandOf(null, ['low', 'medium', 'high'])).toThrow(/change_priority_initial/)
    expect(() => riskBandOf(undefined, ['low', 'medium', 'high'])).toThrow(/change_priority_initial/)
  })

  it('le soglie coincidono con determineApprovalRoute (30 / 60 inclusivi)', () => {
    const bands = ['low', 'medium', 'high'] as const
    for (const score of [0, 10, 30, 31, 60, 61, 90]) {
      expect(riskBandOf(score, bands), `score ${score}`).toBe(determineApprovalRoute(score))
    }
  })

  it('un vocabolario con meno di tre fasce è un errore che spiega cosa serve', () => {
    expect(() => riskBandOf(50, ['bassa', 'alta']))
      .toThrow(/servono almeno tre fasce.*trovate 2: bassa, alta/)
  })
})
