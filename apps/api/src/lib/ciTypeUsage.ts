/**
 * «Questo tipo di CI è in uso?» — la domanda che nessuno faceva prima di
 * cancellarlo o disattivarlo (ondata 6 · A-8 / D-10).
 *
 * ## Il difetto
 * `deleteCIType` faceva `DETACH DELETE t, f, rel, sr` **senza contare i CI**
 * con quell'etichetta, e `active = false` ha lo stesso effetto sulle letture
 * (il tipo sparisce da `loadMetamodel`, quindi da schema, `ciTypes`, `allCIs`,
 * `ciById`, `blastRadius` e da ogni predicato per etichetta). I CI restavano
 * nel grafo con tutte le loro relazioni — verso incident, change, mappe dei
 * servizi — e **non comparivano più da nessuna parte**. Per l'amministratore
 * era una perdita di dati, silenziosa, recuperabile solo ricreando un tipo con
 * lo STESSO nome (perché l'etichetta si deriva dal nome).
 *
 * Non ci sono solo i CI: il nome di un tipo è citato per stringa da regole di
 * relazione ITIL, criteri dei gruppi dinamici, regole di visibilità e di
 * obbligatorietà, regole di dominio, automazioni, widget e nodi dei report;
 * e le domande di assessment sono agganciate al tipo con una relazione, che il
 * `DETACH DELETE` portava via in silenzio.
 *
 * ## La regola
 * Prima di cancellare o disattivare si conta, e il risultato si dice: il
 * numero dei CI e, uno per uno, i riferimenti. Questo modulo è **solo
 * lettura** — decide il chiamante (`resolvers/ciTypeMetamodel.ts`).
 */
import { runQueryOne, type Queryable } from '@opengraphity/neo4j'

/** Un riferimento al tipo per NOME (o per relazione), con quanti sono. */
export interface CITypeReference {
  /** Chiave stabile per i test e i log; il messaggio all'utente lo compone `describeCITypeUsage`. */
  kind:  string
  count: number
}

export interface CITypeUsage {
  /** CI del tenant che portano l'etichetta del tipo. */
  cis:        number
  references: CITypeReference[]
}

/**
 * Come si chiama in italiano ogni riferimento. È una tabella e non una stringa
 * costruita a caso perché il messaggio è la parte utile: dice all'admin **dove
 * andare** a togliere il riferimento.
 */
const REFERENCE_LABELS: Readonly<Record<string, string>> = {
  itil_relation_rules:    'regole di relazione ITIL (Impostazioni → Relazioni ITIL)',
  assessment_questions:   'domande di assessment agganciate al tipo (Impostazioni → Domande di valutazione)',
  dynamic_ci_groups:      'gruppi dinamici che lo elencano nei criteri',
  field_visibility_rules: 'regole di visibilità dei campi',
  field_requirement_rules:'regole di obbligatorietà dei campi',
  business_rules:         'regole di dominio',
  auto_triggers:          'automazioni',
  custom_widgets:         'widget della dashboard',
  report_nodes:           'nodi dei template di report',
}

/**
 * Conteggi in UNA lettura. `label` è l'etichetta Neo4j del tipo (parametro,
 * mai interpolata: il confronto è `$label IN labels(ci)`), `name` il suo nome
 * — quello che i riferimenti citano per stringa.
 */
export const CI_TYPE_USAGE_CYPHER = `
  RETURN
    COUNT { MATCH (ci {tenant_id: $tenantId}) WHERE $label IN labels(ci) }                                        AS cis,
    COUNT { MATCH (r:ITILCIRelationRule {tenant_id: $tenantId}) WHERE r.ci_type = $name }                          AS itil_relation_rules,
    COUNT { MATCH (:CITypeDefinition {id: $typeId})-[:HAS_QUESTION]->(q:AssessmentQuestion {tenant_id: $tenantId}) } AS assessment_questions,
    COUNT { MATCH (g:DynamicCIGroup {tenant_id: $tenantId})
            WHERE g.criteria_ci_types IS NOT NULL
              AND $name IN [x IN split(g.criteria_ci_types, ',') | trim(x)] }                                      AS dynamic_ci_groups,
    COUNT { MATCH (v:FieldVisibilityRule {tenant_id: $tenantId})  WHERE v.entity_type = $name }                    AS field_visibility_rules,
    COUNT { MATCH (q:FieldRequirementRule {tenant_id: $tenantId}) WHERE q.entity_type = $name }                    AS field_requirement_rules,
    COUNT { MATCH (b:BusinessRule {tenant_id: $tenantId})         WHERE b.entity_type = $name }                    AS business_rules,
    COUNT { MATCH (a:AutoTrigger {tenant_id: $tenantId})          WHERE a.entity_type = $name }                    AS auto_triggers,
    COUNT { MATCH (w:CustomWidget {tenant_id: $tenantId})         WHERE w.entity_type = $name }                    AS custom_widgets,
    COUNT { MATCH (tpl:ReportTemplate {tenant_id: $tenantId})
            MATCH (s:ReportSection {template_id: tpl.id})     // tenant-ok: la sezione non porta tenant_id, il suo template sì (MATCH precedente)
            MATCH (rn:ReportNode {section_id: s.id})          // tenant-ok: il nodo appartiene alla sezione, che appartiene al template del tenant
            WHERE rn.entity_type = $name }                                                                         AS report_nodes`

function toCount(value: unknown): number {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) throw new Error(`ciTypeUsage: conteggio non numerico (${JSON.stringify(value)})`)
  return n
}

/** Quanto è usato il tipo `typeId` (nome `name`, etichetta `label`) in questo tenant. */
export async function loadCITypeUsage(
  session: Queryable, tenantId: string, typeId: string, name: string, label: string,
): Promise<CITypeUsage> {
  const row = await runQueryOne<Record<string, unknown>>(session, CI_TYPE_USAGE_CYPHER, { tenantId, typeId, name, label })
  if (!row) throw new Error(`ciTypeUsage: la lettura dei conteggi per il tipo "${name}" non ha restituito righe`)
  const references = Object.keys(REFERENCE_LABELS)
    .map((kind) => ({ kind, count: toCount(row[kind]) }))
    .filter((r) => r.count > 0)
  return { cis: toCount(row['cis']), references }
}

/** Il pezzo di messaggio che elenca i riferimenti trovati (stringa vuota se nessuno). */
export function describeCITypeUsage(usage: CITypeUsage): string {
  if (usage.references.length === 0) return ''
  return usage.references
    .map((r) => `${String(r.count)} ${REFERENCE_LABELS[r.kind] ?? r.kind}`)
    .join('; ')
}
