/**
 * I CONFLITTI DI RILASCIO DI UNA CHANGE.
 *
 * La domanda del proprietario, e quindi del CAB: «quali change, per il SOLO
 * deploy, operano su uno stesso CI in una finestra che si sovrappone alla
 * mia?». Tre asserzioni valgono più delle altre, e sono quelle che separano
 * un conflitto da un affollamento:
 *
 *  - due VALIDAZIONI sullo stesso CI non sono un conflitto (sono due prove);
 *  - due rilasci su CI DIVERSI non sono un conflitto (il calendario li segna
 *    in ambra, è affollamento);
 *  - una change CONCLUSA non confligge, e lo si decide dalla categoria del
 *    passo — non dal suo nome, che il cliente può rinominare.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** Le righe che il finto database restituisce: le decide ogni caso. */
let mieiPiani: Array<{ ciId: string; steps: unknown }> = []
let candidati: Array<Record<string, unknown>> = []
const query: string[] = []

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, q: string) => {
    query.push(q)
    if (q.includes('MATCH (c:Change {id: $changeId')) return mieiPiani
    if (q.includes('MATCH (o:Change {tenant_id: $tenantId})')) return candidati
    return []
  }),
}))
vi.mock('../logger.js', () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) } }))

const { deployConflictsForChange, CATEGORIE_CONCLUSE, MAX_PIANI_CANDIDATI } = await import('../changeDeployConflicts.js')

const session = {} as never

/** Un piano con una validazione e un rilascio, in date che si scelgono. */
const piano = (validazione: [string, string], rilascio: [string, string]) => JSON.stringify([{
  title: 'Step 1',
  validationWindow: { start: validazione[0], end: validazione[1] },
  releaseWindow:    { start: rilascio[0],    end: rilascio[1] },
}])

const altra = (over: Record<string, unknown> = {}) => ({
  changeId: 'chg-2', code: 'CHG00000002', title: 'Aggiornamento kernel',
  currentStep: 'scheduled', categoria: 'active',
  ciId: 'ci-1', ciName: 'srv-web-01',
  steps: piano(['2026-10-01T06:00:00.000Z', '2026-10-01T08:00:00.000Z'], ['2026-10-01T22:00:00.000Z', '2026-10-02T02:00:00.000Z']),
  ...over,
})

beforeEach(() => {
  query.length = 0
  // La mia change: rilascio dalle 23:00 all'01:00 sul CI «ci-1».
  mieiPiani = [{ ciId: 'ci-1', steps: piano(['2026-10-01T09:00:00.000Z', '2026-10-01T10:00:00.000Z'], ['2026-10-01T23:00:00.000Z', '2026-10-02T01:00:00.000Z']) }]
  candidati = [altra()]
})

describe('deployConflictsForChange', () => {
  it('trova la change che rilascia sullo stesso CI in una finestra sovrapposta', async () => {
    const out = await deployConflictsForChange(session, 't1', 'chg-1')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ code: 'CHG00000002', ciId: 'ci-1', ciName: 'srv-web-01', currentStep: 'scheduled' })
    // La parte in comune: dalle 23:00 (la mia inizia dopo) alle 02:00 (la sua finisce prima)… no:
    // la mia finisce all'01:00, quindi il comune è 23:00 → 01:00.
    expect(out[0]!.overlap).toEqual({ start: '2026-10-01T23:00:00.000Z', end: '2026-10-02T01:00:00.000Z' })
  })

  it('porta ENTRAMBE le finestre: chi legge deve poter spostare la sua o chiedere all\'altro', async () => {
    const out = await deployConflictsForChange(session, 't1', 'chg-1')
    expect(out[0]!.mine).toEqual({ start: '2026-10-01T23:00:00.000Z', end: '2026-10-02T01:00:00.000Z' })
    expect(out[0]!.theirs).toEqual({ start: '2026-10-01T22:00:00.000Z', end: '2026-10-02T02:00:00.000Z' })
  })

  it('due VALIDAZIONI sovrapposte sullo stesso CI NON sono un conflitto', async () => {
    // La sua validazione cade in pieno nella mia; i rilasci non si toccano.
    candidati = [altra({
      steps: piano(['2026-10-01T09:30:00.000Z', '2026-10-01T09:45:00.000Z'], ['2026-10-05T22:00:00.000Z', '2026-10-06T02:00:00.000Z']),
    })]
    expect(await deployConflictsForChange(session, 't1', 'chg-1')).toEqual([])
  })

  it('la mia validazione sovrapposta al suo RILASCIO non è un conflitto', async () => {
    // Il confronto è rilascio↔rilascio: mescolarli farebbe comparire conflitti
    // che non esistono, e il CAB imparerebbe a ignorare la sezione.
    candidati = [altra({
      steps: piano(['2026-10-02T09:00:00.000Z', '2026-10-02T10:00:00.000Z'], ['2026-10-01T09:30:00.000Z', '2026-10-01T09:45:00.000Z']),
    })]
    expect(await deployConflictsForChange(session, 't1', 'chg-1')).toEqual([])
  })

  it('CI diversi non confliggono: è affollamento, non collisione', async () => {
    candidati = [altra({ ciId: 'ci-2', ciName: 'srv-db-09' })]
    expect(await deployConflictsForChange(session, 't1', 'chg-1')).toEqual([])
  })

  it('finestre CONSECUTIVE non confliggono: la mia finisce quando la sua comincia', async () => {
    candidati = [altra({ steps: piano(['2026-09-30T06:00:00.000Z', '2026-09-30T07:00:00.000Z'], ['2026-10-02T01:00:00.000Z', '2026-10-02T03:00:00.000Z']) })]
    expect(await deployConflictsForChange(session, 't1', 'chg-1')).toEqual([])
  })

  it('una change CONCLUSA non confligge', async () => {
    for (const categoria of CATEGORIE_CONCLUSE) {
      candidati = [altra({ categoria })]
      expect(await deployConflictsForChange(session, 't1', 'chg-1'), categoria).toEqual([])
    }
  })

  it('una categoria SCONOSCIUTA conta come in corso: meglio un conflitto in più da leggere', async () => {
    // Le change più vecchie non hanno istanza di workflow: tacere su quelle
    // vorrebbe dire scoprirle il giorno del rilascio.
    for (const categoria of [null, 'fase_del_cliente']) {
      candidati = [altra({ categoria })]
      expect(await deployConflictsForChange(session, 't1', 'chg-1'), String(categoria)).toHaveLength(1)
    }
  })

  it('senza rilasci miei non interroga nemmeno il database per i candidati', async () => {
    // Una change senza piano non può confliggere con nessuno, e la seconda
    // query sarebbe una lettura buttata su ogni apertura di dettaglio.
    mieiPiani = []
    expect(await deployConflictsForChange(session, 't1', 'chg-1')).toEqual([])
    expect(query).toHaveLength(1)
  })

  it('un piano illeggibile non diventa «nessun conflitto»: esce dal confronto e resta nei log', async () => {
    candidati = [altra({ steps: '{non JSON' })]
    expect(await deployConflictsForChange(session, 't1', 'chg-1')).toEqual([])
    // E se è il MIO piano a essere rotto, non si inventa un intervallo.
    mieiPiani = [{ ciId: 'ci-1', steps: 'neanche questo' }]
    expect(await deployConflictsForChange(session, 't1', 'chg-1')).toEqual([])
  })

  it('più conflitti: in ordine di quando si pestano i piedi, non di codice', async () => {
    candidati = [
      altra({ changeId: 'chg-9', code: 'CHG00000009', steps: piano(['2026-09-30T06:00:00.000Z', '2026-09-30T07:00:00.000Z'], ['2026-10-01T23:30:00.000Z', '2026-10-02T04:00:00.000Z']) }),
      altra({ changeId: 'chg-3', code: 'CHG00000003', steps: piano(['2026-09-30T06:00:00.000Z', '2026-09-30T07:00:00.000Z'], ['2026-10-01T22:00:00.000Z', '2026-10-02T00:30:00.000Z']) }),
    ]
    const out = await deployConflictsForChange(session, 't1', 'chg-1')
    expect(out.map((c) => c.code)).toEqual(['CHG00000003', 'CHG00000009'])
  })

  it('la query scarta nel DATABASE: stesso CI, inviluppo che tocca il mio, non cancellata', async () => {
    await deployConflictsForChange(session, 't1', 'chg-1')
    const candidatiQuery = query[1]!
    expect(candidatiQuery).toContain('dp.ci_id IN $ciIds')
    expect(candidatiQuery).toContain('dp.window_start <= $fine AND dp.window_end >= $inizio')
    expect(candidatiQuery).toContain('coalesce(o.deleted, false) = false')
    expect(candidatiQuery).toContain('o.id <> $changeId')
    // Il tetto è interpolato, non un parametro: un numero JS è un float per
    // Neo4j e `LIMIT` vuole un intero (lezione del 17 set).
    expect(candidatiQuery).toContain(`LIMIT ${String(MAX_PIANI_CANDIDATI)}`)
  })

  it('la stessa change non confligge con sé stessa nemmeno se il finto la restituisse', async () => {
    candidati = [altra({ changeId: 'chg-1', code: 'CHG00000001' })]
    const out = await deployConflictsForChange(session, 't1', 'chg-1')
    // La query lo esclude; qui si pinna che il filtro sia nella query e non
    // una gentilezza del chiamante.
    expect(query[1]).toContain('o.id <> $changeId')
    expect(out).toHaveLength(1)   // il finto non filtra: è il database a farlo
  })
})
