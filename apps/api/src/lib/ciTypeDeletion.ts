/**
 * Cancellare (o disattivare) un tipo di CI — la regola del proprietario, 15 set
 * 2026.
 *
 * ## Il difetto
 * `assertCITypeNotInUse` rifiutava se il tipo aveva CI **o** qualunque
 * riferimento per nome, e fra i riferimenti contava le domande di assessment
 * collegate al tipo. Ma `createCIType` collega da sé a ogni tipo nuovo tutte le
 * domande core (terza revisione): un tipo appena creato, senza CI e senza
 * nessun uso, non si poteva più cancellare — visto dal vivo su c-test.
 *
 * ## La regola
 * Il solo impedimento è che il tipo sia **coinvolto in un ticket**: un CI di
 * quel tipo collegato a un incident, problem, change o richiesta di servizio,
 * anche chiusi (senza il tipo quei CI sparirebbero dallo storico dei ticket).
 * Tutto il resto va via insieme al tipo, nella stessa transazione, e la
 * conferma nel disegnatore lo dice prima con i numeri (`ciTypeDeletionImpact`):
 *  - i CI del tipo, con alias e (se ne hanno) mappa di servizio e cronologia;
 *  - le esclusioni per tipo di ticket che lo citano;
 *  - i gruppi dinamici: il tipo si toglie dai criteri; un gruppo che aveva
 *    SOLO quel tipo si cancella (senza tipi nei criteri varrebbe per tutti i
 *    CI: allargarlo in silenzio sarebbe peggio);
 *  - regole di visibilità e di obbligatorietà, business rule, trigger e widget
 *    sul tipo;
 *  - le sezioni dei report con un nodo del tipo (una sezione senza quel nodo
 *    sarebbe una query spezzata);
 *  - i collegamenti alle domande di assessment (le domande restano).
 *
 * La disattivazione nasconde il tipo senza cancellare nulla: la bloccano i
 * ticket, come la cancellazione, e i CI del tipo (resterebbero nel grafo
 * invisibili a tutto il prodotto finché il tipo non torna attivo — A-8). I
 * riferimenti per nome non la bloccano: il tipo esiste ancora.
 */
import { runQueryOne, type Queryable } from '@opengraphity/neo4j'
import { TICKET_CI_RELATIONSHIPS_PATTERN } from '@opengraphity/types'
import { ValidationError } from './errors.js'

/** Le etichette dei ticket che si collegano ai CI (`TICKET_CI_RELATIONSHIP` in @opengraphity/types). */
export const TICKET_LABELS = ['Incident', 'Problem', 'Change', 'ServiceRequest'] as const

const GROUP_LABEL = 'DynamicCIGroup'

/**
 * I CI del tipo e i gruppi dinamici che sparirebbero con lui, e quanti di
 * questi sono in un ticket. `$label` e `$name` sono parametri, mai
 * interpolati; il pattern delle relazioni viene da una costante del prodotto.
 */
export const CI_TYPE_DELETION_IMPACT_CYPHER = `
  CALL {
    MATCH (ci {tenant_id: $tenantId}) WHERE $label IN labels(ci)
    RETURN collect(ci) AS typeCIs
  }
  CALL {
    MATCH (g:${GROUP_LABEL} {tenant_id: $tenantId})
    WHERE g.criteria_ci_types IS NOT NULL
      AND $name IN [x IN split(g.criteria_ci_types, ',') | trim(x)]
    WITH g, [x IN split(g.criteria_ci_types, ',') WHERE trim(x) <> '' AND trim(x) <> $name] AS rest
    RETURN count(CASE WHEN size(rest) > 0 THEN 1 END) AS groupsUpdated,
           collect(CASE WHEN size(rest) = 0 THEN g END) AS onlyThisType
  }
  WITH typeCIs, groupsUpdated, onlyThisType, typeCIs + onlyThisType AS doomed
  CALL {
    WITH doomed
    UNWIND doomed AS d
    MATCH (d)-[:${TICKET_CI_RELATIONSHIPS_PATTERN}]-(t {tenant_id: $tenantId})
    WHERE ${TICKET_LABELS.map((l) => `t:${l}`).join(' OR ')}
    RETURN count(DISTINCT d) AS ticketCIs, count(DISTINCT t) AS tickets
  }
  RETURN size(typeCIs) AS cis, size(onlyThisType) AS groupsDeleted, groupsUpdated, ticketCIs, tickets,
    COUNT { MATCH (x:TicketCIExclusion {tenant_id: $tenantId}) WHERE x.ci_type = $name }                AS ticketCIExclusions,
    COUNT { MATCH (v:FieldVisibilityRule {tenant_id: $tenantId})  WHERE v.entity_type = $name }         AS fieldVisibilityRules,
    COUNT { MATCH (q:FieldRequirementRule {tenant_id: $tenantId}) WHERE q.entity_type = $name }         AS fieldRequirementRules,
    COUNT { MATCH (b:BusinessRule {tenant_id: $tenantId})         WHERE b.entity_type = $name }         AS businessRules,
    COUNT { MATCH (a:AutoTrigger {tenant_id: $tenantId})          WHERE a.entity_type = $name }         AS autoTriggers,
    COUNT { MATCH (w:CustomWidget {tenant_id: $tenantId})         WHERE w.entity_type = $name }         AS customWidgets,
    COUNT { MATCH (tpl:ReportTemplate {tenant_id: $tenantId})-[:HAS_SECTION]->(s:ReportSection)
            WHERE EXISTS { MATCH (s)-[:HAS_NODE]->(rn:ReportNode) WHERE rn.entity_type = $name } }      AS reportSections,
    COUNT { MATCH (:CITypeDefinition {id: $typeId, tenant_id: $tenantId})-[:HAS_QUESTION]->(:AssessmentQuestion) } AS assessmentQuestionLinks`

export interface CITypeDeletionImpact {
  /** CI del tipo che verrebbero cancellati. */
  cis:                     number
  /** CI (del tipo, o gruppi che sparirebbero) collegati a un ticket: se > 0 non si cancella. */
  ticketCIs:               number
  tickets:                 number
  ticketCIExclusions:      number
  groupsUpdated:           number
  groupsDeleted:           number
  fieldVisibilityRules:    number
  fieldRequirementRules:   number
  businessRules:           number
  autoTriggers:            number
  customWidgets:           number
  reportSections:          number
  assessmentQuestionLinks: number
}

const IMPACT_KEYS: readonly (keyof CITypeDeletionImpact)[] = [
  'cis', 'ticketCIs', 'tickets', 'ticketCIExclusions', 'groupsUpdated', 'groupsDeleted', 'fieldVisibilityRules',
  'fieldRequirementRules', 'businessRules', 'autoTriggers', 'customWidgets', 'reportSections', 'assessmentQuestionLinks',
]

function toCount(value: unknown, key: string): number {
  const n = Number(value)
  if (value == null || !Number.isFinite(n)) throw new Error(`ciTypeDeletion: non-numeric count ${key} (${JSON.stringify(value)})`)
  return n
}

export async function loadCITypeDeletionImpact(
  session: Queryable, tenantId: string, typeId: string, name: string, label: string,
): Promise<CITypeDeletionImpact> {
  const row = await runQueryOne<Record<string, unknown>>(session, CI_TYPE_DELETION_IMPACT_CYPHER, { tenantId, typeId, name, label })
  if (!row) throw new Error(`ciTypeDeletion: reading the impact of deleting type "${name}" returned no rows`)
  return Object.fromEntries(IMPACT_KEYS.map((k) => [k, toCount(row[k], k)])) as unknown as CITypeDeletionImpact
}

/** L'unico impedimento: CI del tipo (o gruppi che sparirebbero) presenti in un ticket, anche chiuso. */
export function assertCITypeNotInTickets(impact: CITypeDeletionImpact, type: { name: string; label: string }, action: 'delete' | 'deactivate'): void {
  if (impact.ticketCIs === 0) return
  const verb = action === 'delete' ? 'deleted' : 'deactivated'
  const suffix = action === 'delete' ? 'Delete' : 'Deactivate'
  throw new ValidationError(
    `Type "${type.label}" (${type.name}) was not ${verb}: ${impact.ticketCIs} of its CIs are linked to ${impact.tickets} ticket(s) (incidents, problems, changes or requests, closed ones included). `
    + `Without the type those CIs would disappear from the tickets' history.`,
    {
      key: `errors.ciType.inTickets${suffix}`,
      params: { label: type.label, name: type.name, cis: impact.ticketCIs, tickets: impact.tickets },
    },
  )
}

/** La disattivazione con CI del tipo: resterebbero nel grafo invisibili (A-8). */
export function assertCITypeHasNoCIsToHide(impact: CITypeDeletionImpact, type: { name: string; label: string; neo4jLabel: string }): void {
  if (impact.cis === 0) return
  throw new ValidationError(
    `Type "${type.label}" (${type.name}) was not deactivated: there are still ${impact.cis} CIs of type ${type.neo4jLabel} in this tenant, and a deactivated type disappears from reads as if it were deleted. Delete the type instead (its CIs go with it), or move those CIs first.`,
    { key: 'errors.ciType.hasCIsDeactivate', params: { label: type.label, name: type.name, count: impact.cis, type: type.neo4jLabel } },
  )
}

/**
 * Le scritture, in ordine, dentro la transazione del chiamante. Ognuna
 * restituisce quanti nodi ha toccato: il chiamante li confronta con
 * l'anteprima letta nella stessa transazione.
 */
export const DELETE_TYPE_CIS_CYPHER = `
  MATCH (n {tenant_id: $tenantId}) WHERE $label IN labels(n)
  OPTIONAL MATCH (a:CIAlias {tenant_id: $tenantId})-[:ALIAS_OF]->(n)
  OPTIONAL MATCH (n)-[:HAS_SERVICE_MAP]->(m:ServiceMap {tenant_id: $tenantId})
  OPTIONAL MATCH (m)-[:HAS_HEALTH_HISTORY]->(h:ServiceHealthEntry {tenant_id: $tenantId})
  WITH collect(DISTINCT n) AS ns, collect(DISTINCT a) AS aliases, collect(DISTINCT m) AS maps, collect(DISTINCT h) AS entries
  WITH ns, aliases, maps, entries, [x IN ns | x.id] AS ids
  FOREACH (x IN entries | DETACH DELETE x)
  FOREACH (x IN maps | DETACH DELETE x)
  FOREACH (x IN aliases | DETACH DELETE x)
  FOREACH (x IN ns | DETACH DELETE x)
  RETURN ids`

export const UPDATE_GROUPS_CYPHER = `
  MATCH (g:${GROUP_LABEL} {tenant_id: $tenantId})
  WHERE g.criteria_ci_types IS NOT NULL
    AND $name IN [x IN split(g.criteria_ci_types, ',') | trim(x)]
  WITH g, [x IN split(g.criteria_ci_types, ',') WHERE trim(x) <> '' AND trim(x) <> $name | trim(x)] AS rest
  WITH collect(CASE WHEN size(rest) > 0 THEN {g: g, rest: rest} END) AS updates,
       collect(CASE WHEN size(rest) = 0 THEN g END) AS deletions
  FOREACH (u IN updates | FOREACH (grp IN [u.g] | SET grp.criteria_ci_types = reduce(acc = head(u.rest), x IN tail(u.rest) | acc + ',' + x)))
  WITH updates, deletions, [x IN deletions | x.id] AS deletedIds
  FOREACH (x IN deletions | DETACH DELETE x)
  RETURN size(updates) AS updated, deletedIds`

export const DELETE_TYPE_REFERENCES_CYPHER = `
  CALL { MATCH (x:TicketCIExclusion {tenant_id: $tenantId}) WHERE x.ci_type = $name
         WITH collect(x) AS xs FOREACH (y IN xs | DETACH DELETE y) RETURN size(xs) AS ticketCIExclusions }
  CALL { MATCH (x:FieldVisibilityRule {tenant_id: $tenantId}) WHERE x.entity_type = $name
         WITH collect(x) AS xs FOREACH (y IN xs | DETACH DELETE y) RETURN size(xs) AS fieldVisibilityRules }
  CALL { MATCH (x:FieldRequirementRule {tenant_id: $tenantId}) WHERE x.entity_type = $name
         WITH collect(x) AS xs FOREACH (y IN xs | DETACH DELETE y) RETURN size(xs) AS fieldRequirementRules }
  CALL { MATCH (x:BusinessRule {tenant_id: $tenantId}) WHERE x.entity_type = $name
         WITH collect(x) AS xs FOREACH (y IN xs | DETACH DELETE y) RETURN size(xs) AS businessRules }
  CALL { MATCH (x:AutoTrigger {tenant_id: $tenantId}) WHERE x.entity_type = $name
         WITH collect(x) AS xs FOREACH (y IN xs | DETACH DELETE y) RETURN size(xs) AS autoTriggers }
  CALL { MATCH (x:CustomWidget {tenant_id: $tenantId}) WHERE x.entity_type = $name
         WITH collect(x) AS xs FOREACH (y IN xs | DETACH DELETE y) RETURN size(xs) AS customWidgets }
  CALL { MATCH (:ReportTemplate {tenant_id: $tenantId})-[:HAS_SECTION]->(s:ReportSection)
         WHERE EXISTS { MATCH (s)-[:HAS_NODE]->(rn:ReportNode) WHERE rn.entity_type = $name }
         OPTIONAL MATCH (s)-[:HAS_NODE]->(n:ReportNode)
         WITH collect(DISTINCT s) AS ss, collect(DISTINCT n) AS ns
         FOREACH (y IN ns | DETACH DELETE y) FOREACH (y IN ss | DETACH DELETE y)
         RETURN size(ss) AS reportSections }
  RETURN ticketCIExclusions, fieldVisibilityRules, fieldRequirementRules, businessRules, autoTriggers, customWidgets, reportSections`

export interface CITypeDeletionResult {
  impact:          CITypeDeletionImpact
  /** Id dei CI cancellati (del tipo e dei gruppi): servono alla risincronizzazione delle mappe. */
  deletedCIIds:    string[]
}

/**
 * Cancella CI e riferimenti del tipo (NON il tipo: lo fa il chiamante, con la
 * sua guardia) nella transazione `tx`. Rilegge l'impatto nella stessa
 * transazione, rifiuta se il tipo è in un ticket, e fa fallire tutto se un
 * conteggio scritto non torna con quello letto.
 */
export async function deleteCITypeDependents(
  tx: Queryable, tenantId: string, type: { id: string; name: string; label: string; neo4jLabel: string },
): Promise<CITypeDeletionResult> {
  const params = { tenantId, typeId: type.id, name: type.name, label: type.neo4jLabel }
  const impact = await loadCITypeDeletionImpact(tx, tenantId, type.id, type.name, type.neo4jLabel)
  assertCITypeNotInTickets(impact, type, 'delete')

  const cis = await runQueryOne<{ ids: string[] }>(tx, DELETE_TYPE_CIS_CYPHER, params)
  const groups = await runQueryOne<{ updated: unknown; deletedIds: string[] }>(tx, UPDATE_GROUPS_CYPHER, params)
  const refs = await runQueryOne<Record<string, unknown>>(tx, DELETE_TYPE_REFERENCES_CYPHER, params)
  const typeIds = cis?.ids ?? []
  const groupIds = groups?.deletedIds ?? []
  const written: Partial<CITypeDeletionImpact> = {
    cis: typeIds.length, groupsDeleted: groupIds.length, groupsUpdated: toCount(groups?.updated ?? 0, 'groupsUpdated'),
    ...Object.fromEntries((['ticketCIExclusions', 'fieldVisibilityRules', 'fieldRequirementRules', 'businessRules', 'autoTriggers', 'customWidgets', 'reportSections'] as const)
      .map((k) => [k, toCount(refs?.[k] ?? 0, k)])),
  }
  const mismatched = (Object.keys(written) as (keyof CITypeDeletionImpact)[]).filter((k) => written[k] !== impact[k])
  if (mismatched.length) {
    throw new Error(`deleteCIType(${type.name}): ${mismatched.map((k) => `${k} ${String(written[k])}/${impact[k]}`).join(', ')} — something changed while deleting: the transaction was rolled back`)
  }
  return { impact, deletedCIIds: [...typeIds, ...groupIds] }
}
