/**
 * I DUE CAPI DELLA CATENA (21 set 2026).
 *
 * Quello che va pinnato non è «chiama GitHub»: è l'ORDINE con cui succedono
 * le cose — il numero della issue si scrive prima di chiedere l'analisi, se
 * no un ritentativo avvierebbe un'analisi su una issue che il Problem non
 * conosce — e che cosa NON succede: una PR non unita, o un agente che dice
 * «niente da fare», non risolvono niente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const ordine: string[] = []

const cfg = { valore: { repo: 'mastrovix/opengraphity', token: 'ghp_finto' } as { repo: string; token: string } | null }
const fascicolo = { valore: '## Firme\n…' as string | null }
const stato = vi.fn()
const segnaRisoltoMock = vi.fn()
const apriIssue = vi.fn()
const dispatch = vi.fn()
let inAttesa: Array<Record<string, unknown>> = []

vi.mock('../../lib/autoanalisiGitHub.js', () => ({
  configurazioneAutoanalisi: () => cfg.valore,
  apriIssueDelFascicolo: (...a: unknown[]) => { ordine.push('issue'); return apriIssue(...a) },
  chiediAnalisi:         (...a: unknown[]) => { ordine.push('dispatch'); return dispatch(...a) },
  statoDellAnalisi:      (...a: unknown[]) => stato(...a),
}))

vi.mock('../../lib/problemDossier.js', () => ({
  fascicoloDelProblem: async () => fascicolo.valore,
}))

vi.mock('../../lib/indagineAutomatica.js', () => ({
  segnaRisolto: (...a: unknown[]) => segnaRisoltoMock(...a),
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ run: async () => { ordine.push('scrivi-numero') }, close: async () => {} }),
  runQuery:   async () => inAttesa,
  runQueryOne: async () => null,
}))

vi.mock('../../lib/bullmq.js', () => ({
  getQueue: () => ({ add: vi.fn(), upsertJobScheduler: vi.fn() }),
  createWorker: vi.fn(),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const { _perITest, INTERVALLO_CONTROLLO_MS, ATTORE } = await import('../autoanalisiWorker.js')

const DATI = { tenantId: 'opengrafo', problemId: 'prb-1', problemNumber: 'PRB00000003', titolo: 'metamodel-bus' }

beforeEach(() => {
  ordine.length = 0
  cfg.valore = { repo: 'mastrovix/opengraphity', token: 'ghp_finto' }
  fascicolo.valore = '## Firme\n…'
  inAttesa = []
  apriIssue.mockReset().mockResolvedValue(25)
  dispatch.mockReset().mockResolvedValue(undefined)
  stato.mockReset()
  segnaRisoltoMock.mockReset().mockResolvedValue({ fatto: true, passo: 'resolved', percorsi: ['known_error', 'resolved'], motivo: 'fatto' })
})

describe('porta-il-fascicolo', () => {
  it('il numero della issue si scrive PRIMA di chiedere l\'analisi', async () => {
    await _perITest.portaIlFascicolo(DATI)
    expect(ordine).toEqual(['issue', 'scrivi-numero', 'dispatch'])
    expect(apriIssue).toHaveBeenCalledWith(cfg.valore, {
      problemNumber: 'PRB00000003', titolo: 'metamodel-bus', fascicolo: '## Firme\n…',
    })
    expect(dispatch).toHaveBeenCalledWith(cfg.valore, { issue: 25, problemNumber: 'PRB00000003' })
  })

  it('senza repository configurato non si chiama GitHub, e non è un errore', async () => {
    cfg.valore = null
    await expect(_perITest.portaIlFascicolo(DATI)).resolves.toBeUndefined()
    expect(ordine).toEqual([])
  })

  it('un fascicolo che non si costruisce è un difetto, non un caso normale', async () => {
    fascicolo.valore = null
    await expect(_perITest.portaIlFascicolo(DATI)).rejects.toThrow(/dossier of PRB00000003 could not be built/)
    expect(ordine).toEqual([])
  })
})

describe('controlla', () => {
  const problemi = [
    { id: 'prb-1', number: 'PRB00000003', issue: 25, passo: 'under_investigation' },
    { id: 'prb-2', number: 'PRB00000004', issue: 30, passo: 'under_investigation' },
  ]

  it('una PR UNITA chiude il giro', async () => {
    inAttesa = [problemi[0]!]
    stato.mockResolvedValue({ pr: 26, prUnita: true })
    await _perITest.controlla()
    expect(segnaRisoltoMock).toHaveBeenCalledWith('opengrafo', 'prb-1', 'PRB00000003', ATTORE)
  })

  it('una PR chiusa SENZA essere unita non risolve niente', async () => {
    inAttesa = [problemi[0]!]
    stato.mockResolvedValue({ pr: 26, prUnita: false })
    await _perITest.controlla()
    expect(segnaRisoltoMock).not.toHaveBeenCalled()
  })

  it('«non c\'è niente da cambiare»: nessuna PR, il Problem resta aperto e in analisi', async () => {
    inAttesa = [problemi[0]!]
    stato.mockResolvedValue({ pr: null, prUnita: null })
    await _perITest.controlla()
    expect(segnaRisoltoMock).not.toHaveBeenCalled()
  })

  it('un Problem che va storto non ferma quelli dopo', async () => {
    inAttesa = [...problemi]
    stato.mockRejectedValueOnce(new Error('issue cancellata a mano'))
    stato.mockResolvedValueOnce({ pr: 31, prUnita: true })
    await _perITest.controlla()
    expect(segnaRisoltoMock).toHaveBeenCalledTimes(1)
    expect(segnaRisoltoMock).toHaveBeenCalledWith('opengrafo', 'prb-2', 'PRB00000004', ATTORE)
  })

  it('senza repository configurato non si interroga niente', async () => {
    cfg.valore = null
    inAttesa = [...problemi]
    await _perITest.controlla()
    expect(stato).not.toHaveBeenCalled()
  })

  it('il quarto d\'ora è dichiarato, non sparso nel codice', () => {
    expect(INTERVALLO_CONTROLLO_MS).toBe(15 * 60_000)
  })
})
