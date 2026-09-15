/**
 * I tipi di CI che un tipo di ticket NON può coinvolgere (revisione del 15 set
 * 2026 · CM-8, decisione del proprietario).
 *
 * ## Com'era
 * Le «regole ITIL → CI» elencavano i tipi AMMESSI, con un tipo di relazione e
 * una direzione che nessuno leggeva: il collegamento era sempre lo stesso. E
 * valevano in due punti soli — aggiungere un CI a un incident o a un problem
 * già aperti —, non alla creazione dei ticket né per le change: le cinque
 * regole «change» di c-one non erano mai state applicate.
 *
 * ## Com'è
 * Si dichiara il contrario: per ogni tipo di ticket, i tipi di CI esclusi.
 * Nessuna esclusione = tutti ammessi. Un CI di un tipo escluso non si collega
 * al ticket né alla creazione né dopo, **da nessuna strada**: web, API REST,
 * portale, Slack, e anche gli incident che apre il prodotto (monitoraggio,
 * servizi monitorati, tempeste) — scelta esplicita del proprietario: il job
 * fallisce col motivo finché l'amministratore non toglie l'esclusione.
 *
 * Il dato: un nodo `(:TicketCIExclusion {tenant_id, ticket_type, ci_type})`
 * per esclusione, con `ci_type` = NOME del tipo CI (come lo citano le altre
 * configurazioni, e come la toglie `lib/ciTypeDeletion.ts` quando si cancella il tipo).
 */
import { getSession, runQuery } from '@opengraphity/neo4j'
import { loadMetamodel } from '@opengraphity/schema-generator'
import { TICKET_CI_TYPES, isTicketCIType, type TicketCIType } from '@opengraphity/types'
import { ENUM_SCOPE } from './enumScope.js'
import { ValidationError } from './errors.js'
import { createMetamodelCache } from './metamodelCache.js'
import { invalidateSchema } from './schemaInvalidator.js'

export { TICKET_CI_TYPES, type TicketCIType }

export function assertTicketCIType(value: unknown): TicketCIType {
  if (isTicketCIType(value)) return value
  throw new ValidationError(
    `Ticket type "${String(value)}" does not link CIs. Allowed: ${TICKET_CI_TYPES.join(', ')}.`,
    { key: 'errors.ticketCI.unknownTicketType', params: { type: String(value), allowed: TICKET_CI_TYPES.join(', ') } },
  )
}

const cache = createMetamodelCache<readonly string[]>({
  name: 'ticket-ci-exclusions',
  load: (tenantId, ticketType) => loadExcluded(tenantId, ticketType),
})

async function loadExcluded(tenantId: string, ticketType: string): Promise<readonly string[]> {
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{ ciType: string }>(session, `
      MATCH (x:TicketCIExclusion {tenant_id: $tenantId, ticket_type: $ticketType})
      RETURN x.ci_type AS ciType ORDER BY x.ci_type
    `, { tenantId, ticketType })
    return rows.map((r) => r.ciType)
  } finally {
    await session.close()
  }
}

/** I nomi dei tipi di CI esclusi per questo tipo di ticket (vuoto = tutti ammessi). */
export function excludedCITypes(tenantId: string, ticketType: TicketCIType): Promise<readonly string[]> {
  return cache.get(tenantId, ticketType)
}

/**
 * Sostituisce le esclusioni di un tipo di ticket. Ogni nome deve essere un
 * tipo CI attivo di questo cliente: un'esclusione verso un tipo che non esiste
 * non escluderebbe niente, in silenzio.
 */
export async function setTicketCIExclusions(
  tenantId: string, ticketType: unknown, ciTypes: readonly string[],
): Promise<{ ticketType: TicketCIType; ciTypes: string[] }> {
  const type = assertTicketCIType(ticketType)
  const names = new Set((await loadMetamodel(tenantId, ENUM_SCOPE)).map((t) => t.name))
  const wanted = [...new Set(ciTypes.map((c) => c.trim()).filter(Boolean))].sort()
  const unknown = wanted.filter((c) => !names.has(c))
  if (unknown.length) {
    throw new ValidationError(
      `Not CI types of this tenant: ${unknown.join(', ')}. Allowed: ${[...names].sort().join(', ')}.`,
      { key: 'errors.ticketCI.unknownCIType', params: { types: unknown.join(', '), allowed: [...names].sort().join(', ') } },
    )
  }
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite(async (tx) => {
      await tx.run(`
        MATCH (x:TicketCIExclusion {tenant_id: $tenantId, ticket_type: $ticketType})
        WHERE NOT x.ci_type IN $wanted
        DELETE x
      `, { tenantId, ticketType: type, wanted })
      await tx.run(`
        UNWIND $wanted AS ciType
        MERGE (x:TicketCIExclusion {tenant_id: $tenantId, ticket_type: $ticketType, ci_type: ciType})
          ON CREATE SET x.id = randomUUID(), x.created_at = $now
      `, { tenantId, ticketType: type, wanted, now: new Date().toISOString() })
    })
  } finally {
    await session.close()
  }
  invalidateSchema(tenantId)
  return { ticketType: type, ciTypes: wanted }
}

/**
 * I CI dati si possono collegare a un ticket di questo tipo? Se anche uno solo è
 * di un tipo escluso, niente si collega e l'errore li nomina tutti, con il tipo
 * e dove si toglie l'esclusione. Un id che non è un CI di questo tenant non è
 * affare di questa funzione: lo dice chi collega, che conta le righe scritte.
 */
export async function assertCIsLinkable(tenantId: string, ticketType: TicketCIType, ciIds: readonly string[]): Promise<void> {
  if (ciIds.length === 0) return
  const excluded = new Set(await excludedCITypes(tenantId, ticketType))
  if (excluded.size === 0) return
  const byLabel = new Map((await loadMetamodel(tenantId, ENUM_SCOPE)).map((t) => [t.neo4jLabel, t]))
  const session = getSession(undefined, 'READ')
  let rows: { id: string; name: string; labels: string[] }[]
  try {
    rows = await runQuery(session, `
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId}) WHERE ci.id IN $ids
      RETURN ci.id AS id, ci.name AS name, labels(ci) AS labels
    `, { tenantId, ids: [...ciIds] })
  } finally {
    await session.close()
  }
  const blocked: { name: string; type: string }[] = []
  for (const r of rows) {
    const type = r.labels.map((l) => byLabel.get(l)).find(Boolean)
    if (type && excluded.has(type.name)) blocked.push({ name: r.name, type: type.label || type.name })
  }
  if (blocked.length === 0) return
  const cis = blocked.map((b) => `${b.name} (${b.type})`).join(', ')
  throw new ValidationError(
    `These CIs cannot be linked to this ${ticketType}: their type is excluded for this ticket type (${cis}). `
    + `Exclusions are set in Settings → ITIL Type Designer.`,
    { key: 'errors.ticketCI.excluded', params: { ticketType, cis } },
  )
}
