/**
 * IL CATALOGO CHIUSO È DAVVERO CHIUSO (20 set 2026).
 *
 * Il rilievo della revisione che questo test tiene fermo: «il catalogo chiuso
 * ha un catalogo aperto dentro». Il progetto prometteva «niente script,
 * niente webhook», ma l'azione che crea un'automazione porta le sue azioni in
 * un JSON — e fra i tipi ammessi da `actionExecutor.ts` ci sono
 * `execute_script` e `call_webhook`. Bastava che un domani un analista
 * componesse quei parametri leggendo il titolo di un incident scritto da un
 * cliente, e l'admin accettasse.
 *
 * La sbarra è qui, PRIMA che qualcosa si esegua, e guarda anche dentro i
 * parametri annidati.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: () => ({ close: async () => undefined }) }))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({ runQueryOne: async () => ({ id: 't1' }) }))
vi.mock('../portalSeverityOptions.js', () => ({
  PORTAL_SEVERITY_VOCABULARY: 'severity',
  portalSeverityOptions: async () => finto.opzioni,
}))
vi.mock('../domainMatrix.js', () => ({ domainVocabulary: async () => finto.vocabolario }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const finto = vi.hoisted(() => ({
  opzioni: [] as Array<{ value: string; labels: Record<string, string> }>,
  vocabolario: [] as string[],
}))

const { assertAzioneAmmessa, eseguiAzione, azioneDisfabile } = await import('../proposalActions.js')

describe('la sbarra del catalogo chiuso', () => {
  it('un tipo che non è nel catalogo si rifiuta', () => {
    expect(() => assertAzioneAmmessa('set_field', {})).toThrow(/not an action of the closed catalogue/)
  })

  it('SCRIPT E WEBHOOK si rifiutano anche ANNIDATI nei parametri', () => {
    // È il caso vero: «crea un'automazione disattivata» porterebbe le sue
    // azioni dentro un JSON, e il tipo non si vedrebbe in superficie.
    expect(() => assertAzioneAmmessa('portal_severities.remove_stale', {
      rule: { actions: [{ type: 'call_webhook', url: 'https://esterno.example.com' }] },
    })).toThrow(/may never carry "call_webhook"/)

    expect(() => assertAzioneAmmessa('portal_severities.remove_stale', {
      nested: { deep: [{ t: 'execute_script' }] },
    })).toThrow(/may never carry "execute_script"/)

    expect(() => assertAzioneAmmessa('portal_severities.remove_stale', {
      x: 'transition_workflow',
    })).toThrow(/may never carry "transition_workflow"/)
  })

  it('l\'azione buona passa', () => {
    expect(assertAzioneAmmessa('portal_severities.remove_stale', {})).toBe('portal_severities.remove_stale')
  })
})

describe('togliere le severità stantie dal portale', () => {
  const opz = (...v: string[]) => v.map((value) => ({ value, labels: {} }))

  it('toglie quelle che il Dizionario non ha più, e tiene le altre', async () => {
    finto.opzioni = opz('low', 'high', 'blocker')
    finto.vocabolario = ['low', 'high']

    const esito = await eseguiAzione('t1', { type: 'portal_severities.remove_stale', params: {} })
    expect(esito.details['removed']).toEqual(['blocker'])
    expect(esito.details['kept']).toEqual(['low', 'high'])
  })

  it('SALVA LO STATO PRECEDENTE, non una chiusura: fra accettare e disfare il processo si riavvia', async () => {
    finto.opzioni = opz('low', 'blocker')
    finto.vocabolario = ['low']

    const esito = await eseguiAzione('t1', { type: 'portal_severities.remove_stale', params: {} })
    expect(esito.undoState).not.toBeNull()
    // Dentro c'è tutto quello che serve a riscrivere com'era, compreso il
    // valore stantio: si ripristina quello che c'era, non quello che sarebbe valido.
    expect(String(esito.undoState?.['options'])).toContain('blocker')
  })

  it('NON SVUOTA IL PORTALE: togliere tutto lascerebbe un errore al posto di un altro', async () => {
    finto.opzioni = opz('blocker', 'showstopper')
    finto.vocabolario = ['low', 'high']

    await expect(eseguiAzione('t1', { type: 'portal_severities.remove_stale', params: {} }))
      .rejects.toThrow(/no severity at all/)
  })

  it('se non c\'è niente di stantio lo dice, invece di scrivere a vuoto', async () => {
    finto.opzioni = opz('low', 'high')
    finto.vocabolario = ['low', 'high']

    await expect(eseguiAzione('t1', { type: 'portal_severities.remove_stale', params: {} }))
      .rejects.toThrow(/nothing to do/)
  })

  it('RICALCOLA da sé: fra la notte e il click il Dizionario può essere cambiato', async () => {
    // La proposta era nata quando «blocker» era stantio; adesso è tornato nel
    // vocabolario e «high» non c'è più. L'azione lavora su ADESSO.
    finto.opzioni = opz('low', 'high', 'blocker')
    finto.vocabolario = ['low', 'blocker']

    const esito = await eseguiAzione('t1', { type: 'portal_severities.remove_stale', params: {} })
    expect(esito.details['removed']).toEqual(['high'])
  })

  it('si sa disfare, e la pagina lo può chiedere prima di offrire il bottone', () => {
    expect(azioneDisfabile('portal_severities.remove_stale')).toBe(true)
    expect(azioneDisfabile('qualcosa_che_non_esiste')).toBe(false)
  })
})
