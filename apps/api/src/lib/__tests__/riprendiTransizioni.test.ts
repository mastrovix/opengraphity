/**
 * LE CHANGE CHE HANNO PERSO L'OCCASIONE RIPRENDONO A CAMMINARE (22 set 2026).
 *
 * Quello che deve restare vero:
 *
 *  - si muovono SOLO le change che la diagnostica elencava già come «ferme con
 *    la strada aperta»: stessa funzione, nessun insieme parallelo;
 *  - il varco si riconsulta un istante prima di muovere, e un suo rifiuto
 *    ferma quella change e nessun'altra;
 *  - una change che va storta non blocca quelle dopo;
 *  - nella storia risulta `ATTORE`, non una persona che non ha cliccato;
 *  - il tetto per giro si rispetta: il resto va al giro dopo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const cambio = (code: string) => ({
  code, changeId: `chg-${code}`, instanceId: `wi-${code}`,
  fromStep: 'assessment', toStep: 'planning', condition: null,
  props: { change_type: 'normal' },
})

let candidate: ReturnType<typeof cambio>[] = []
const varco = vi.fn()
const transition = vi.fn()
const sessioniChiuse = { n: 0 }

vi.mock('../changesStuck.js', () => ({
  changeChePossonoMuoversi: async () => candidate,
}))
vi.mock('../../graphql/resolvers/change/windowGate.js', () => ({
  automaticTransitionOutcome: (...a: unknown[]) => varco(...a),
}))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { transition: (...a: unknown[]) => transition(...a) },
}))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: async () => { sessioniChiuse.n += 1 } }),
  runQuery: async () => [{ tenantId: 't1' }, { tenantId: 't2' }],
}))
vi.mock('../logger.js', () => {
  const finto = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => finto }
  return { logger: finto }
})

const { riprendiTransizioniDi, riprendiTransizioni, ATTORE, MAX_PER_GIRO } =
  await import('../riprendiTransizioni.js')

const ok = { success: true, instance: {}, execution: {}, actionsRun: [] }

beforeEach(() => {
  candidate = []
  sessioniChiuse.n = 0
  varco.mockReset().mockResolvedValue({ allowed: true })
  transition.mockReset().mockResolvedValue(ok)
})

describe('riprendiTransizioniDi', () => {
  it('muove le change ferme, e nella storia risulta il prodotto', async () => {
    candidate = [cambio('CHG1'), cambio('CHG2')]
    const esito = await riprendiTransizioniDi('t1')
    expect(esito).toEqual({ mosse: 2, candidate: 2, rifiutateDalVarco: 0 })
    const comando = transition.mock.calls[0]![1] as Record<string, unknown>
    expect(comando).toMatchObject({
      instanceId: 'wi-CHG1', toStepName: 'planning',
      triggeredBy: ATTORE, triggerType: 'automatic', tenantId: 't1',
    })
    expect(ATTORE).toBe('sistema:ripresa-automatica')
  })

  it('il varco si riconsulta PRIMA di muovere, e un rifiuto ferma solo quella', async () => {
    candidate = [cambio('CHG1'), cambio('CHG2')]
    varco.mockResolvedValueOnce({ allowed: false, reason: 'fuori finestra' })
    varco.mockResolvedValueOnce({ allowed: true })
    const esito = await riprendiTransizioniDi('t1')
    expect(esito).toEqual({ mosse: 1, candidate: 2, rifiutateDalVarco: 1 })
    expect(transition).toHaveBeenCalledTimes(1)
    expect((transition.mock.calls[0]![1] as { instanceId: string }).instanceId).toBe('wi-CHG2')
  })

  it('una change che va storta non ferma quelle dopo', async () => {
    candidate = [cambio('CHG1'), cambio('CHG2'), cambio('CHG3')]
    transition.mockRejectedValueOnce(new Error('workflow rotto'))
    const esito = await riprendiTransizioniDi('t1')
    expect(esito.mosse).toBe(2)
  })

  it('un rifiuto del MOTORE non è un errore: la change resta dov\'è', async () => {
    candidate = [cambio('CHG1')]
    transition.mockResolvedValue({ ...ok, success: false, error: 'condizione non soddisfatta' })
    const esito = await riprendiTransizioniDi('t1')
    expect(esito).toEqual({ mosse: 0, candidate: 1, rifiutateDalVarco: 0 })
  })

  it('il tetto per giro si rispetta: il resto va al giro dopo', async () => {
    candidate = Array.from({ length: MAX_PER_GIRO + 7 }, (_, i) => cambio(`CHG${i}`))
    const esito = await riprendiTransizioniDi('t1')
    expect(esito.mosse).toBe(MAX_PER_GIRO)
    expect(esito.candidate).toBe(MAX_PER_GIRO + 7)
  })

  it('nessuna candidata: non si apre nemmeno il varco', async () => {
    const esito = await riprendiTransizioniDi('t1')
    expect(esito).toEqual({ mosse: 0, candidate: 0, rifiutateDalVarco: 0 })
    expect(varco).not.toHaveBeenCalled()
  })

  it('la sessione si chiude comunque', async () => {
    candidate = [cambio('CHG1')]
    transition.mockRejectedValue(new Error('boom'))
    await riprendiTransizioniDi('t1')
    expect(sessioniChiuse.n).toBe(1)
  })
})

describe('riprendiTransizioni (tutti i clienti)', () => {
  it('somma quello che ha fatto su ogni tenant', async () => {
    candidate = [cambio('CHG1')]
    const esito = await riprendiTransizioni()
    // due tenant dalla query, una change mossa per ciascuno
    expect(esito).toEqual({ mosse: 2, candidate: 2, rifiutateDalVarco: 0 })
  })
})
