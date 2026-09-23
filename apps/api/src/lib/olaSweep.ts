/**
 * LA PASSATA OLA/UC, OGNI MINUTO (secondo giro UI del 15 set 2026, decisione
 * del proprietario).
 *
 * Prima un controllo per contratto si armava all'apertura del ticket e
 * scattava una volta sola: un ticket arrivato al team dopo la scadenza non
 * avvisava mai, un obiettivo cambiato non raggiungeva i ticket aperti, un
 * contratto riattivato non controllava più niente. Qui, a ogni passata:
 *  1. per ogni contratto attivo con un team, i ticket aperti del suo tipo che
 *     in questo momento sono di quel team e per cui non si è ancora avvisato;
 *  2. il tempo del team con le regole di ADESSO (`olaTeamMeasure`: tratti di
 *     assegnazione, obiettivo, calendario, fuso);
 *  3. oltre l'obiettivo → `ola.breached` e il contratto si segna sul ticket
 *     (`ola_alerted`), così non si avvisa due volte.
 * Un contratto senza team (dato vecchio) non avvisa: il report lo conta
 * dall'apertura, e il contratto va completato col suo team.
 * Sulle change la passata guarda le misure dei task (`olaChangeUnits.ts`) e
 * segna l'avviso sul task (`ola_alerted` con `olaUnitAlertKey`).
 */
import type { Session } from 'neo4j-driver'
import { getSession, runQuery, toNumber } from '@opengraphity/neo4j'
import { calendarFor, getTenantTimezone, type ServiceCalendar } from '@opengraphity/sla'
import { AUTOMATION_ACTOR } from '@opengraphity/types'
import { OLA_CONCLUDED_FIELD, olaEntityTypes, olaTeamMeasure, type OLATicketFacts } from './olaAttainment.js'
import { publishEvent } from './publishEvent.js'
import { loadChangeUnits, olaUnitAlertKey, type OLAChangeUnit } from './olaChangeUnits.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'ola-sweep' })

export interface OLASweepSummary { contracts: number; candidates: number; alerted: number; failed: number }

interface ContractRow {
  id: string; tenantId: string; name: string; type: string; entityType: string; teamId: string
  resolveMinutes: unknown; businessHours: boolean; calendarId: string | null; createdAt: string | null
  /** The contract's own zone; null = the organization's. */
  timezone: string | null
}

/** I ticket aperti del tipo, del team, non ancora avvisati per il contratto, con i tratti di quel team. */
export function olaOpenTicketsCypher(entityType: string): string {
  const m = OLA_CONCLUDED_FIELD[entityType]
  if (!m) throw new Error(`olaOpenTicketsCypher: unknown ticket type "${entityType}"`)
  if (entityType === 'change') throw new Error('olaOpenTicketsCypher: a change is measured on its tasks (olaChangeUnits.ts), it has no team of its own')
  /**
   * Anche i ticket che il team NON ha più (revisione totale · C-32): la
   * passata partiva da «assegnato adesso a questo team», quindi un ticket il
   * cui tempo del team aveva superato l'obiettivo e che era stato passato ad
   * altri prima della passata successiva — o durante una passata fallita — non
   * produceva mai `ola.breached`, benché il report lo contasse violato.
   * Il tempo si misura sui SEGMENTI (`TicketTeamSegment`), che restano anche
   * dopo il passaggio di mano: basta che il team ne abbia almeno uno.
   */
  return `
    MATCH (e:${m.label} {tenant_id: $tenantId})
    WHERE e.${m.field} IS NULL AND coalesce(e.deleted, false) = false
      AND NOT $contractId IN coalesce(e.ola_alerted, [])
    OPTIONAL MATCH (e)-[:ASSIGNED_TO_TEAM]->(ct:Team {tenant_id: $tenantId})
    OPTIONAL MATCH (e)-[:TEAM_SEGMENT]->(s:TicketTeamSegment {team_id: $teamId})
    WITH e, ct, collect(DISTINCT s) AS segs
    WHERE ct.id = $teamId OR size(segs) > 0
    RETURN e.id AS id, e.number AS number, e.title AS title, e.created_at AS createdAt, null AS concludedAt, ct.id AS currentTeamId,
           [x IN segs | {teamId: x.team_id, startedAt: x.started_at, endedAt: x.ended_at, inferred: coalesce(x.inferred, false)}] AS segments`
}

export async function runOLASweep(now: Date = new Date()): Promise<OLASweepSummary> {
  const summary: OLASweepSummary = { contracts: 0, candidates: 0, alerted: 0, failed: 0 }
  const session = getSession(undefined, 'WRITE')
  try {
    const contracts = await runQuery<ContractRow>(session, `
      // tenant-ok(piattaforma): passata di manutenzione su tutti i tenant; ogni contratto è poi letto e scritto nel suo tenant.
      MATCH (o:OLAContract)
      WHERE coalesce(o.enabled, true) = true AND o.team_id IS NOT NULL
      RETURN o.id AS id, o.tenant_id AS tenantId, o.name AS name, o.type AS type, o.entity_type AS entityType, o.team_id AS teamId,
             o.resolve_minutes AS resolveMinutes, coalesce(o.business_hours, false) AS businessHours,
             o.calendar_id AS calendarId, o.created_at AS createdAt, o.timezone AS timezone
      ORDER BY o.tenant_id, o.id
    `, {})
    summary.contracts = contracts.length
    const timezones = new Map<string, string>()
    for (const c of contracts) {
      try {
        const calendar: ServiceCalendar | null = await calendarFor(c.tenantId, { name: c.name, businessHours: c.businessHours, calendarId: c.calendarId })
        /**
         * Il fuso si legge SOLO quando il contratto usa l'orario di servizio
         * (revisione totale · C-11): `olaTeamMeasure` lo ignora per un 24×7,
         * ma `getTenantTimezone` LANCIA se il tenant non ne ha uno — quindi un
         * tenant appena creato con contratti 24×7 contava ogni contratto come
         * «failed» e scriveva una riga di errore al minuto, senza che nessun
         * avviso OLA partisse.
         */
        // A contract with its own zone does not need the organization's (tour of 23 Sep 2026).
        if (c.businessHours && !c.timezone && !timezones.has(c.tenantId)) {
          timezones.set(c.tenantId, await getTenantTimezone(c.tenantId))
        }
        const timezone = timezones.get(c.tenantId) ?? 'UTC'
        const rule = { teamId: c.teamId, createdAt: c.createdAt, resolveMinutes: toNumber(c.resolveMinutes), businessHours: c.businessHours, calendar, timezone: c.timezone ?? null }
        for (const entityType of olaEntityTypes(c.entityType || 'incident')) {
          if (entityType === 'change') {
            const units = (await loadChangeUnits(session, c.tenantId, { by: 'open', teamId: c.teamId }))
              .filter((u) => !u.alerted.includes(olaUnitAlertKey(c.id, u)))
            summary.candidates += units.length
            for (const u of units) {
              const m = olaTeamMeasure(u, rule, timezone, now)
              if (m.state !== 'breached') continue
              await alertUnit(session, c, u, m.usedMinutes, rule.resolveMinutes, now)
              summary.alerted++
            }
            continue
          }
          const tickets = await runQuery<OLATicketFacts & { id: string; number: string | null; title: string | null }>(session, olaOpenTicketsCypher(entityType), {
            tenantId: c.tenantId, teamId: c.teamId, contractId: c.id,
          })
          summary.candidates += tickets.length
          for (const t of tickets) {
            const m = olaTeamMeasure(t, rule, timezone, now)
            if (m.state !== 'breached') continue
            await alert(session, c, entityType, t, m.usedMinutes, rule.resolveMinutes, now)
            summary.alerted++
          }
        }
      } catch (err) {
        // Un contratto che non si riesce a valutare (calendario sparito, fuso mancante) non ferma gli altri, e si dice.
        summary.failed++
        log.error({ err, tenantId: c.tenantId, contractId: c.id }, 'OLA sweep: contract could not be evaluated')
      }
    }
  } finally {
    await session.close()
  }
  return summary
}

async function alert(
  session: Session, c: ContractRow, entityType: string,
  t: { id: string; number: string | null; title: string | null }, usedMinutes: number, targetMinutes: number, now: Date,
): Promise<void> {
  // Prima il segno sul ticket, poi l'evento: un evento perso si vede nei log,
  // un evento ripetuto a ogni minuto riempirebbe le notifiche.
  const label = OLA_CONCLUDED_FIELD[entityType]!.label
  await session.executeWrite((tx) => tx.run(
    `MATCH (e:${label} {id: $id, tenant_id: $tenantId})
     SET e.ola_alerted = coalesce(e.ola_alerted, []) + $contractId`,
    { id: t.id, tenantId: c.tenantId, contractId: c.id },
  ))
  await publishEvent('ola.breached', c.tenantId, AUTOMATION_ACTOR, {
    entity_id: t.id, entity_type: entityType, number: t.number, title: t.title,
    contract_id: c.id, contract_name: c.name, contract_type: c.type,
    used_minutes: usedMinutes, target_minutes: targetMinutes, breached_at: now.toISOString(),
  }, now.toISOString())
  log.info({ tenantId: c.tenantId, contractId: c.id, entityType, entityId: t.id, usedMinutes, targetMinutes }, 'OLA/UC breached')
}

async function alertUnit(session: Session, c: ContractRow, u: OLAChangeUnit, usedMinutes: number, targetMinutes: number, now: Date): Promise<void> {
  const key = olaUnitAlertKey(c.id, u)
  await session.executeWrite((tx) => tx.run(
    `MATCH (n:${u.node.label} {id: $id, tenant_id: $tenantId})
     SET n.ola_alerted = coalesce(n.ola_alerted, []) + $key`,
    { id: u.node.id, tenantId: c.tenantId, key },
  ))
  await publishEvent('ola.breached', c.tenantId, AUTOMATION_ACTOR, {
    entity_id: u.ticketId, entity_type: 'change', number: u.ticketNumber, title: u.ticketTitle,
    contract_id: c.id, contract_name: c.name, contract_type: c.type,
    unit_kind: u.kind, unit_key: u.key, ci_name: u.ciName, step_title: u.stepTitle,
    used_minutes: usedMinutes, target_minutes: targetMinutes, breached_at: now.toISOString(),
  }, now.toISOString())
  log.info({ tenantId: c.tenantId, contractId: c.id, entityId: u.ticketId, unit: u.key, usedMinutes, targetMinutes }, 'OLA/UC breached on a change task')
}
