/**
 * I CONTRATTI OLA/UC CHE NON MISURANO NIENTE (secondo giro UI del 15 set 2026,
 * punto 3). Un contratto misura il tempo in cui il ticket è del suo team
 * (`olaAttainment.ts`), e lo scopre dai dati, non da una regola cablata:
 *  - senza team il contratto non avvisa mai (la passata lo salta) e il report
 *    lo conta dall'apertura per chiunque;
 *  - su un tipo di ticket che nessuno assegna a un team (ci sono ticket, e
 *    nessuno ne ha mai avuto uno) non c'è tempo del team da contare: il
 *    contratto resta a zero per sempre.
 * Lo usa la diagnostica.
 */
import type { Queryable } from '@opengraphity/neo4j'
import { OLA_CONCLUDED_FIELD, olaEntityTypes } from './olaAttainment.js'

export interface OLAMeasurability {
  /** Contratti attivi senza team. */
  withoutTeam:   string[]
  /** Contratti attivi i cui tipi di ticket non passano mai per un team: «nome (tipi)». */
  unmeasurable:  string[]
}

export async function olaContractsMeasurability(session: Queryable, tenantId: string): Promise<OLAMeasurability> {
  const res = await session.run(`
    MATCH (o:OLAContract {tenant_id: $tenantId})
    WHERE coalesce(o.enabled, true) = true
    RETURN o.name AS name, coalesce(o.entity_type, 'incident') AS entityType, o.team_id IS NOT NULL AS hasTeam
    ORDER BY name`, { tenantId })
  const out: OLAMeasurability = { withoutTeam: [], unmeasurable: [] }
  const teamless = new Map<string, boolean>()
  for (const r of res.records) {
    const name = String(r.get('name'))
    if (r.get('hasTeam') !== true) { out.withoutTeam.push(name); continue }
    const types = olaEntityTypes(String(r.get('entityType')))
    const never: string[] = []
    for (const type of types) {
      if (!teamless.has(type)) teamless.set(type, await neverWithTeam(session, tenantId, type))
      if (teamless.get(type)) never.push(type)
    }
    // Un contratto su più tipi conta se almeno uno passa per un team.
    if (never.length > 0 && never.length === types.length) out.unmeasurable.push(`${name} (${never.join(', ')})`)
  }
  return out
}

/** Ci sono ticket del tipo, e nessuno è mai stato di un team. */
async function neverWithTeam(session: Queryable, tenantId: string, entityType: string): Promise<boolean> {
  const label = OLA_CONCLUDED_FIELD[entityType]!.label
  // Una change ha il team sui suoi task (olaChangeUnits.ts): si guarda lì.
  const withTeam = entityType === 'change'
    ? 'EXISTS { (w)-[:HAS_ASSESSMENT|HAS_DEPLOY_PLAN]->()-[:ASSIGNED_TO_TEAM]->(:Team) }'
    : 'EXISTS { (w)-[:ASSIGNED_TO_TEAM]->(:Team) } OR EXISTS { (w)-[:TEAM_SEGMENT]->(:TicketTeamSegment) }'
  const res = await session.run(`
    OPTIONAL MATCH (e:${label} {tenant_id: $tenantId})
    WITH count(e) AS tickets
    OPTIONAL MATCH (w:${label} {tenant_id: $tenantId})
    WHERE ${withTeam}
    RETURN tickets, count(w) AS withTeam`, { tenantId })
  const rec = res.records[0]
  return Number(rec?.get('tickets') ?? 0) > 0 && Number(rec?.get('withTeam') ?? 0) === 0
}
