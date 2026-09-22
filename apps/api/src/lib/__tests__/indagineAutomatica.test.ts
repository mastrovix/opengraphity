/**
 * IL PROBLEM CHE CAMMINA DA SOLO (21 set 2026).
 *
 * Quello che deve restare vero:
 *
 *  - il passo si trova per RUOLO (scopo o categoria), quindi regge alla
 *    rinomina del cliente;
 *  - si percorre il cammino che il cliente ha DISEGNATO, anche quando è lungo
 *    più di un passo — nel workflow di fabbrica la chiusura ne chiede due, e
 *    la prima stesura a un passo solo non sarebbe scattata mai;
 *  - ci si ferma al primo rifiuto, e il Problem resta dov'è arrivato;
 *  - non esce mai un'eccezione, perché il chiamante ha già creato il Problem.
 *
 * NOTA SUL PERCHÉ IL DIFETTO ERA PASSATO: qui la query è finta, quindi questi
 * test non possono dire se il cammino ESISTE nel workflow. Quella verifica sta
 * in `camminoDelProblemDiFabbrica.test.ts`, che legge il seed vero.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const chiuse = { close: 0 }
let riga: Record<string, unknown> | null = null
const transition = vi.fn()

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: async () => { chiuse.close += 1 } }),
  runQueryOne: async () => riga,
}))

vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { transition: (...a: unknown[]) => transition(...a) },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { avviaIndagine, segnaRisolto, SCOPO_INDAGINE, CATEGORIA_RISOLTO, MAX_PASSI } = await import('../indagineAutomatica.js')

const ok = { success: true, instance: {}, execution: {}, actionsRun: [] }

beforeEach(() => {
  chiuse.close = 0
  transition.mockReset()
  transition.mockResolvedValue(ok)
  riga = { instanceId: 'wi-1', passoAttuale: 'new', passi: ['under_investigation'] }
})

describe('avviaIndagine', () => {
  it('porta il Problem nel passo di analisi, e nella storia risulta AUTOMATICA', async () => {
    const esito = await avviaIndagine('opengrafo', 'prb-1', 'PRB00000003', 'u-1')
    expect(esito).toEqual({ fatto: true, passo: 'under_investigation', percorsi: ['under_investigation'], motivo: 'fatto' })
    expect(transition).toHaveBeenCalledTimes(1)
    const [, comando, contesto] = transition.mock.calls[0]!
    expect(comando).toMatchObject({
      instanceId: 'wi-1', toStepName: 'under_investigation',
      triggeredBy: 'u-1', triggerType: 'automatic', tenantId: 'opengrafo',
    })
    expect(contesto).toEqual({ userId: 'u-1', entityData: {} })
  })

  it('il passo si riconosce dal RUOLO: un tenant che lo ha rinominato funziona lo stesso', async () => {
    riga = { instanceId: 'wi-9', passoAttuale: 'appena_arrivato', passi: ['sotto_esame'] }
    const esito = await avviaIndagine('opengrafo', 'prb-2', 'PRB00000004', 'u-1')
    expect(esito.fatto).toBe(true)
    expect(esito.passo).toBe('sotto_esame')
    expect(transition.mock.calls[0]![1]).toMatchObject({ toStepName: 'sotto_esame' })
    expect(SCOPO_INDAGINE).toBe('investigation')
    expect(CATEGORIA_RISOLTO).toBe('resolved')
  })

  it('nessun cammino: il Problem resta dov\'è, e non si tenta nessuna transizione', async () => {
    riga = { instanceId: 'wi-1', passoAttuale: 'new', passi: [] }
    const esito = await avviaIndagine('opengrafo', 'prb-3', 'PRB00000005', 'u-1')
    expect(esito).toEqual({ fatto: false, passo: 'new', percorsi: [], motivo: 'nessun_cammino' })
    expect(transition).not.toHaveBeenCalled()
  })

  it('senza istanza di workflow non si inventa niente', async () => {
    riga = null
    const esito = await avviaIndagine('opengrafo', 'prb-4', 'PRB00000006', 'u-1')
    expect(esito).toEqual({ fatto: false, passo: null, percorsi: [], motivo: 'nessun_cammino' })
    expect(transition).not.toHaveBeenCalled()
  })

  it('transizione rifiutata da una guardia: il motivo arriva a chi legge', async () => {
    transition.mockResolvedValue({ ...ok, success: false, error: 'condition has_owner not satisfied' })
    const esito = await avviaIndagine('opengrafo', 'prb-5', 'PRB00000007', 'u-1')
    expect(esito).toEqual({
      fatto: false, passo: 'new', percorsi: [], motivo: 'transizione_rifiutata',
      dettaglio: 'condition has_owner not satisfied',
    })
  })

  it('un errore del motore non esce: il chiamante ha già creato il Problem', async () => {
    transition.mockRejectedValue(new Error('neo4j giù'))
    const esito = await avviaIndagine('opengrafo', 'prb-6', 'PRB00000008', 'u-1')
    expect(esito).toMatchObject({ fatto: false, motivo: 'errore', dettaglio: 'neo4j giù' })
  })

  it('la sessione si chiude su ogni cammino, compreso quello che fallisce', async () => {
    await avviaIndagine('opengrafo', 'prb-7', 'PRB00000009', 'u-1')
    transition.mockRejectedValue(new Error('boom'))
    await avviaIndagine('opengrafo', 'prb-8', 'PRB00000010', 'u-1')
    riga = null
    await avviaIndagine('opengrafo', 'prb-9', 'PRB00000011', 'u-1')
    expect(chiuse.close).toBe(3)
  })
})

describe('segnaRisolto: il cammino può essere LUNGO', () => {
  it('percorre tutti i passi che il cliente ha disegnato, in ordine', async () => {
    riga = { instanceId: 'wi-1', passoAttuale: 'under_investigation', passi: ['known_error', 'resolved'] }
    const esito = await segnaRisolto('opengrafo', 'prb-1', 'PRB00000003', 'autoanalisi')
    expect(esito).toEqual({ fatto: true, passo: 'resolved', percorsi: ['known_error', 'resolved'], motivo: 'fatto' })
    expect(transition).toHaveBeenCalledTimes(2)
    expect(transition.mock.calls.map((c) => (c[1] as { toStepName: string }).toStepName))
      .toEqual(['known_error', 'resolved'])
  })

  it('un rifiuto A META\' STRADA lascia il Problem dove è arrivato, non dove era', async () => {
    riga = { instanceId: 'wi-1', passoAttuale: 'under_investigation', passi: ['known_error', 'resolved'] }
    transition.mockResolvedValueOnce(ok)
    transition.mockResolvedValueOnce({ ...ok, success: false, error: 'serve una verifica' })
    const esito = await segnaRisolto('opengrafo', 'prb-1', 'PRB00000003', 'autoanalisi')
    expect(esito).toEqual({
      fatto: false, passo: 'known_error', percorsi: ['known_error'],
      motivo: 'transizione_rifiutata', dettaglio: 'serve una verifica',
    })
  })

  it('il tetto ai passi è dichiarato, e le query ci camminano fin lì', () => {
    expect(MAX_PASSI).toBe(3)
  })
})
