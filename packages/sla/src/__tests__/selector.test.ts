/**
 * Revisione del 14 set 2026 · F7: la policy copiava il fuso del cliente alla
 * creazione, così cambiare il fuso del cliente non spostava nessuna policy. Una
 * policy senza fuso proprio ora segue quello del cliente; un fuso proprio resta
 * una scelta esplicita.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const run = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeRead: async (fn: (tx: { run: typeof run }) => unknown) => fn({ run }),
    close: vi.fn(async () => {}),
  })),
}))

const { selectSLAForEntity } = await import('../selector.js')

function rows(props: Record<string, unknown>, tenantTimezone: string | null) {
  return {
    records: [{
      get: (k: string) => k === 'p' ? { properties: props } : k === 'tenantTimezone' ? tenantTimezone : null,
    }],
  }
}
const base = { id: 'p1', name: 'Tutti', entity_type: 'incident', response_minutes: 60, resolve_minutes: 240, warning_minutes: 30 }

describe('selectSLAForEntity — fuso', () => {
  beforeEach(() => { run.mockReset() })

  it('policy senza fuso proprio → il fuso del cliente', async () => {
    run.mockResolvedValueOnce(rows({ ...base }, 'America/New_York'))
    const p = await selectSLAForEntity('t1', 'incident', 'high', null, null)
    expect(p?.timezone).toBe('America/New_York')
    expect(String(run.mock.calls[0]![0])).toContain('Tenant')
  })

  it('policy con fuso proprio → il suo', async () => {
    run.mockResolvedValueOnce(rows({ ...base, timezone: 'Asia/Tokyo' }, 'America/New_York'))
    const p = await selectSLAForEntity('t1', 'incident', 'high', null, null)
    expect(p?.timezone).toBe('Asia/Tokyo')
  })

  it('né la policy né il cliente hanno un fuso → errore che lo dice', async () => {
    run.mockResolvedValueOnce(rows({ ...base }, null))
    await expect(selectSLAForEntity('t1', 'incident', 'high', null, null)).rejects.toThrow(/time ?zone/i)
  })
})

/**
 * Revisione totale del 16 set 2026 · E-1: la specificità conta i criteri che la
 * policy fissa, non elenca cinque combinazioni. Prima una policy «priorità +
 * team» o «solo team» cadeva in ELSE 99 ed era esclusa: non veniva scelta mai,
 * e il ticket riceveva la policy generica senza un avviso.
 */
describe('selectSLAForEntity — specificità per numero di criteri (E-1)', () => {
  beforeEach(() => { run.mockReset() })

  it('la query non esclude nessuna combinazione e ordina per numero di criteri', async () => {
    run.mockResolvedValueOnce({ records: [] })
    await selectSLAForEntity('t1', 'incident', 'critical', 'network', 'team-rete').catch(() => null)
    const cypher = run.mock.calls[0]![0] as string
    expect(cypher).not.toContain('ELSE 99')
    expect(cypher).toContain('ORDER BY criteria DESC, weight DESC')
    // Ogni criterio dichiarato deve combaciare; quelli non dichiarati non vincolano.
    expect(cypher).toContain('p.priority IS NULL OR p.priority = $priority')
    expect(cypher).toContain('p.category IS NULL OR p.category = $category')
    expect(cypher).toContain('p.team_id  IS NULL OR p.team_id  = $teamId')
  })

  it('una policy «priorità + team» (senza categoria) è ammessa dalla query e scelta', async () => {
    run.mockResolvedValueOnce(rows({ ...base, name: 'P1 del team Rete', priority: 'critical', team_id: 'team-rete' }, 'Europe/Rome'))
    const policy = await selectSLAForEntity('t1', 'incident', 'critical', null, 'team-rete')
    expect(policy?.name).toBe('P1 del team Rete')
  })
})

/**
 * A CORRUPT POLICY FAILS LOUDLY INSTEAD OF PRODUCING A ZERO-MINUTE SLA.
 *
 * `Number(undefined)` is NaN and `Number(null)` is 0: either one, taken at
 * face value, gives a deadline equal to the start instant — an SLA breached
 * the moment the ticket is created, on every ticket that policy covers. The
 * customer sees a wall of breaches and no cause, which is why each of these
 * throws naming the policy.
 */
describe('selectSLAForEntity — a policy that cannot produce a deadline', () => {
  beforeEach(() => { run.mockReset() })

  it.each([undefined, null, 0, -30, 'sessanta', NaN])(
    'response_minutes %s is refused, naming the policy and the value', async (response_minutes) => {
      run.mockResolvedValue(rows({ ...base, response_minutes }, 'Europe/Rome'))
      await expect(selectSLAForEntity('c-one', 'incident', 'high', null, null))
        .rejects.toThrow(/SLA policy "Tutti" \(p1\) has invalid response_minutes/)
    })

  it.each([undefined, null, 0, -1, 'quattro'])(
    'resolve_minutes %s is refused the same way', async (resolve_minutes) => {
      run.mockResolvedValue(rows({ ...base, resolve_minutes }, 'Europe/Rome'))
      await expect(selectSLAForEntity('c-one', 'incident', 'high', null, null))
        .rejects.toThrow(/has invalid resolve_minutes/)
    })

  it.each([undefined, null, 0, -5, 1.5, 'trenta'])(
    'warning_minutes %s is refused: the warning lead must be a whole number of minutes', async (warning_minutes) => {
      // Unlike the other two this one must be an INTEGER: a fractional lead
      // would schedule the warning at a sub-minute offset nobody configured.
      run.mockResolvedValue(rows({ ...base, warning_minutes }, 'Europe/Rome'))
      await expect(selectSLAForEntity('c-one', 'incident', 'high', null, null))
        .rejects.toThrow(/has invalid warning_minutes/)
    })

  it('a policy with all three valid comes back', async () => {
    run.mockResolvedValue(rows(base, 'Europe/Rome'))
    await expect(selectSLAForEntity('c-one', 'incident', 'high', null, null)).resolves.toBeTruthy()
  })
})
