/**
 * Verifica «Cosa resta cablato», ondata 1: le severità del portale sono una
 * scelta dell'amministratore, validata contro il vocabolario del cliente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let stored: unknown = null
const writes: Array<Record<string, unknown>> = []

/** I vocabolari `severity` che il finto database contiene: li decide ogni caso. */
let vocabolari: Array<{ tenantId: string; values: unknown }> = [{ tenantId: 'system', values: ['low', 'medium', 'high', 'critical'] }]
/** `false` = la proprietà è già scritta, quindi il MERGE «solo dove manca» non trova righe. */
let daSeminare = true

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: async () => undefined }),
  runQuery: vi.fn(async (_s: unknown, cypher: string) => {
    if (cypher.includes('MATCH (e:EnumTypeDefinition {name: $nome})')) return vocabolari
    return []
  }),
  runQueryOne: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    if (cypher.includes('WHERE t.portal_severity_options IS NULL')) {
      if (!daSeminare) return null
      writes.push(params)
      return { id: params['tenantId'] }
    }
    if (cypher.includes('SET t.portal_severity_options')) { writes.push(params); return { id: params['tenantId'] } }
    return { raw: stored }
  }),
}))
vi.mock('../domainMatrix.js', () => ({ domainVocabulary: vi.fn(async () => ['blocker', 'high', 'medium', 'low']) }))
vi.mock('../vocabularyEntries.js', () => ({
  loadVocabularyEntries: vi.fn(async () => ({
    values: ['blocker', 'high', 'medium', 'low'],
    labels: { blocker: { en: 'Blocker', it: 'Bloccante' }, high: { en: 'High', it: 'Alta' } },
    colors: { blocker: 'danger' },
  })),
}))
vi.mock('../tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en'), languageForUser: vi.fn(async () => 'en') }))

const { portalSeverityChoices, setPortalSeverityOptions, seedPortalSeverityOptions } = await import('../portalSeverityOptions.js')

beforeEach(() => {
  stored = null
  writes.length = 0
  vocabolari = [{ tenantId: 'system', values: ['low', 'medium', 'high', 'critical'] }]
  daSeminare = true
})

describe('portalSeverityChoices', () => {
  it('non dichiarate → si ferma e dice dove si sceglie (niente valori indovinati)', async () => {
    await expect(portalSeverityChoices('c-test', 'en')).rejects.toThrow(/not configured.*Organization & access → Organization/)
  })

  it('le parole dell\'amministratore vincono; una lingua non scritta usa il Dizionario; il colore è del Dizionario', async () => {
    stored = JSON.stringify([
      { value: 'blocker', labels: { en: 'It stops my work' } },
      { value: 'high', labels: {} },
    ])
    expect(await portalSeverityChoices('c-test', 'en')).toEqual([
      { value: 'blocker', label: 'It stops my work', color: 'danger' },
      { value: 'high', label: 'High', color: null },
    ])
    expect(await portalSeverityChoices('c-test', 'it')).toEqual([
      { value: 'blocker', label: 'Bloccante', color: 'danger' },
      { value: 'high', label: 'Alta', color: null },
    ])
  })

  it('una scelta che il vocabolario non ha più (rinominata nel Dizionario) → errore che la nomina', async () => {
    stored = JSON.stringify([{ value: 'critical', labels: {} }])
    await expect(portalSeverityChoices('c-test', 'en')).rejects.toThrow(/offers critical, which the "severity" dictionary no longer has/)
  })
})

describe('setPortalSeverityOptions', () => {
  it('salva nell\'ordine dato, con le etichette scritte e senza quelle vuote', async () => {
    const saved = await setPortalSeverityOptions('c-test', [
      { value: 'blocker', labels: [{ language: 'en', label: ' It stops my work ' }, { language: 'it', label: '' }] },
      { value: 'low', labels: [] },
    ])
    expect(saved).toEqual([{ value: 'blocker', labels: { en: 'It stops my work' } }, { value: 'low', labels: {} }])
    expect(JSON.parse(writes[0]!['options'] as string)).toEqual(saved)
  })

  it.each([
    [[], /at least one severity/],
    [[{ value: 'critical', labels: [] }], /not a value of the "severity" dictionary/],
    [[{ value: 'low', labels: [] }, { value: 'low', labels: [] }], /appears twice/],
    [[{ value: 'low', labels: [{ language: 'fr', label: 'Bas' }] }], /Unknown language "fr"/],
    [[{ value: 'low', labels: [{ language: 'en', label: 'x'.repeat(81) }] }], /longer than 80 characters/],
  ])('rifiuta %j', async (input, message) => {
    await expect(setPortalSeverityOptions('c-test', input)).rejects.toThrow(message)
    expect(writes).toHaveLength(0)
  })
})

/**
 * IL SEME ALLA NASCITA (17 set 2026).
 *
 * Un tenant appena creato nasceva con `portal_severities_not_set`, gravità
 * ERRORE, e il portale non apriva ticket: il prodotto si creava un errore
 * addosso alla nascita. Il seme è la dichiarazione più neutra possibile —
 * tutti i valori del vocabolario, nessuna etichetta propria — e non viola il
 * divieto di indovinare, che riguarda la LETTURA di una proprietà assente.
 */
describe('seedPortalSeverityOptions', () => {
  const sessione = {} as never

  it('dichiara TUTTI i valori del vocabolario, nel suo ordine', async () => {
    const esito = await seedPortalSeverityOptions(sessione, 'nuovo')
    expect(esito.seeded).toEqual(['low', 'medium', 'high', 'critical'])
    expect(JSON.parse(writes[0]!['options'] as string)).toEqual([
      { value: 'low', labels: {} },
      { value: 'medium', labels: {} },
      { value: 'high', labels: {} },
      { value: 'critical', labels: {} },
    ])
  })

  it('NESSUNA etichetta propria: la parola resta quella del Dizionario', async () => {
    // Scriverne una qui creerebbe una seconda fonte per le parole di quei
    // valori, e la prima rinomina nel Dizionario le farebbe divergere.
    await seedPortalSeverityOptions(sessione, 'nuovo')
    for (const o of JSON.parse(writes[0]!['options'] as string) as Array<{ labels: unknown }>) {
      expect(o.labels).toEqual({})
    }
  })

  it('la copia del tenant vince sul vocabolario spedito, come in lettura', async () => {
    vocabolari = [
      { tenantId: 'system', values: ['low', 'medium', 'high', 'critical'] },
      { tenantId: 'suo', values: ['bloccante', 'normale'] },
    ]
    const esito = await seedPortalSeverityOptions(sessione, 'suo')
    expect(esito.seeded).toEqual(['bloccante', 'normale'])
  })

  it('chi ha GIÀ scelto non viene toccato', async () => {
    daSeminare = false
    const esito = await seedPortalSeverityOptions(sessione, 'vecchio')
    expect(esito.seeded).toBeNull()
    expect(esito.reason).toBe('already chosen')
    expect(writes).toHaveLength(0)
  })

  it('senza vocabolario NON scrive una lista vuota, e dice perché', async () => {
    // Una lista vuota sarebbe peggio dell'assenza: il portale mostrerebbe una
    // tendina senza scelte invece di dire che manca la configurazione.
    vocabolari = []
    const esito = await seedPortalSeverityOptions(sessione, 'senza')
    expect(esito.seeded).toBeNull()
    expect(esito.reason).toMatch(/no "severity" vocabulary/)
    expect(writes).toHaveLength(0)
  })

  it('un vocabolario con valori non testuali non passa per buono', async () => {
    vocabolari = [{ tenantId: 'system', values: 'low,medium' }]
    const esito = await seedPortalSeverityOptions(sessione, 'storto')
    expect(esito.seeded).toBeNull()
    expect(writes).toHaveLength(0)
  })
})
