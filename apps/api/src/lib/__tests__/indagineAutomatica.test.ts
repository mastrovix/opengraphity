/**
 * L'INDAGINE CHE PARTE DA SOLA (21 set 2026).
 *
 * Il Problem nato da una proposta non deve aspettare che qualcuno clicchi
 * «Inizia analisi». Qui si pinnano le quattro cose che devono restare vere:
 *
 *  - il passo si trova per SCOPO, quindi regge alla rinomina del cliente;
 *  - si guarda solo fra i passi raggiungibili dal passo attuale: un workflow
 *    disegnato diversamente vince, non viene scavalcato;
 *  - quando non si può, il Problem RESTA dov'è e l'esito lo dice;
 *  - non esce mai un'eccezione, perché il chiamante ha già creato il Problem.
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

const { avviaIndagine, SCOPO_INDAGINE } = await import('../indagineAutomatica.js')

const ok = { success: true, instance: {}, execution: {}, actionsRun: [] }

beforeEach(() => {
  chiuse.close = 0
  transition.mockReset()
  transition.mockResolvedValue(ok)
  riga = { instanceId: 'wi-1', passoAttuale: 'new', passoDiAnalisi: 'under_investigation' }
})

describe('avviaIndagine', () => {
  it('porta il Problem nel passo di analisi, e nella storia risulta AUTOMATICA', async () => {
    const esito = await avviaIndagine('opengrafo', 'prb-1', 'PRB00000003', 'u-1')
    expect(esito).toEqual({ avviata: true, passo: 'under_investigation', motivo: 'avviata' })
    expect(transition).toHaveBeenCalledTimes(1)
    const [, comando, contesto] = transition.mock.calls[0]!
    expect(comando).toMatchObject({
      instanceId: 'wi-1', toStepName: 'under_investigation',
      triggeredBy: 'u-1', triggerType: 'automatic', tenantId: 'opengrafo',
    })
    expect(contesto).toEqual({ userId: 'u-1', entityData: {} })
  })

  it('il passo si riconosce dallo SCOPO: un tenant che lo ha rinominato funziona lo stesso', async () => {
    riga = { instanceId: 'wi-9', passoAttuale: 'appena_arrivato', passoDiAnalisi: 'sotto_esame' }
    const esito = await avviaIndagine('opengrafo', 'prb-2', 'PRB00000004', 'u-1')
    expect(esito.avviata).toBe(true)
    expect(esito.passo).toBe('sotto_esame')
    expect(transition.mock.calls[0]![1]).toMatchObject({ toStepName: 'sotto_esame' })
    expect(SCOPO_INDAGINE).toBe('investigation')
  })

  it('nessun passo di analisi raggiungibile: il Problem resta dov\'è, e non si tenta nessuna transizione', async () => {
    riga = { instanceId: 'wi-1', passoAttuale: 'new', passoDiAnalisi: null }
    const esito = await avviaIndagine('opengrafo', 'prb-3', 'PRB00000005', 'u-1')
    expect(esito).toEqual({ avviata: false, passo: 'new', motivo: 'nessun_passo_di_analisi' })
    expect(transition).not.toHaveBeenCalled()
  })

  it('senza istanza di workflow non si inventa niente', async () => {
    riga = null
    const esito = await avviaIndagine('opengrafo', 'prb-4', 'PRB00000006', 'u-1')
    expect(esito).toEqual({ avviata: false, passo: null, motivo: 'nessun_passo_di_analisi' })
    expect(transition).not.toHaveBeenCalled()
  })

  it('transizione rifiutata da una guardia: il motivo arriva a chi legge', async () => {
    transition.mockResolvedValue({ ...ok, success: false, error: 'condition has_owner not satisfied' })
    const esito = await avviaIndagine('opengrafo', 'prb-5', 'PRB00000007', 'u-1')
    expect(esito).toEqual({
      avviata: false, passo: 'new', motivo: 'transizione_rifiutata',
      dettaglio: 'condition has_owner not satisfied',
    })
  })

  it('un errore del motore non esce: il chiamante ha già creato il Problem', async () => {
    transition.mockRejectedValue(new Error('neo4j giù'))
    const esito = await avviaIndagine('opengrafo', 'prb-6', 'PRB00000008', 'u-1')
    expect(esito).toMatchObject({ avviata: false, motivo: 'errore', dettaglio: 'neo4j giù' })
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
