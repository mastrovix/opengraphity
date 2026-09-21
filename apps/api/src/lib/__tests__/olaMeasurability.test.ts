/** I contratti OLA/UC che non misurano niente, scoperti dai dati (secondo giro UI del 15 set 2026, punto 3). */
import { describe, it, expect, vi } from 'vitest'
import { olaContractsMeasurability } from '../olaMeasurability.js'

const rec = (o: Record<string, unknown>) => ({ get: (k: string) => o[k] })

const cyphers: string[] = []
function session(contracts: Array<Record<string, unknown>>, perLabel: Record<string, { tickets: number; withTeam: number }>) {
  return {
    run: vi.fn(async (cypher: string) => {
      if (cypher.includes('OLAContract')) return { records: contracts.map(rec) }
      const label = /OPTIONAL MATCH \(e:(\w+)/.exec(cypher)![1]!
      cyphers.push(cypher)
      return { records: [rec(perLabel[label] ?? { tickets: 0, withTeam: 0 })] }
    }),
  }
}

describe('olaContractsMeasurability', () => {
  it('distingue senza team, tipi mai assegnati a un team, tipi senza ticket e contratti su più tipi', async () => {
    const s = session([
      { name: 'Rete entro 4h', entityType: 'incident', hasTeam: true },
      { name: 'Richieste entro 1 giorno', entityType: 'service_request', hasTeam: true },
      { name: 'Problem entro 5 giorni', entityType: 'problem', hasTeam: true },
      { name: 'Tutto entro 2 giorni', entityType: 'any', hasTeam: true },
      { name: 'Vecchio', entityType: 'incident', hasTeam: false },
    ], {
      Incident: { tickets: 10, withTeam: 8 },
      ServiceRequest: { tickets: 4, withTeam: 0 },
      Change: { tickets: 3, withTeam: 0 },
      Problem: { tickets: 0, withTeam: 0 },
    })
    const r = await olaContractsMeasurability(s as never, 't1')
    expect(r.withoutTeam).toEqual(['Vecchio'])
    // Nessun problem ancora: non si sa, e non si accusa. «any» passa per gli incident.
    expect(r.unmeasurable).toEqual(['Richieste entro 1 giorno (service_request)'])
  })

  it('una change si guarda sui suoi task, gli altri ticket sul loro team', async () => {
    cyphers.length = 0
    await olaContractsMeasurability(session([
      { name: 'Change', entityType: 'change', hasTeam: true },
      { name: 'Incident', entityType: 'incident', hasTeam: true },
    ], { Change: { tickets: 3, withTeam: 3 }, Incident: { tickets: 1, withTeam: 1 } }) as never, 't1')
    expect(cyphers.find((c) => c.includes(':Change'))).toContain('(w)-[:HAS_ASSESSMENT|HAS_DEPLOY_PLAN]->()-[:ASSIGNED_TO_TEAM]->(:Team)')
    expect(cyphers.find((c) => c.includes(':Incident'))).toContain('EXISTS { (w)-[:ASSIGNED_TO_TEAM]->(:Team) }')
  })
})
