/**
 * I VALORI DI UN REPORT con la loro etichetta (giro nel browser del 14 set 2026).
 *
 * Un report raggruppato per severità mostrava «medium» e «critical», una
 * tabella di incident «in_progress»: il valore interno, in qualunque lingua.
 * Qui passano TUTTE le esecuzioni (pagina, widget di dashboard, invio
 * programmato, PDF, Excel), quindi l'etichetta si mette una volta sola, nella
 * lingua del tenant:
 *
 * - un campo agganciato a un vocabolario (`USES_ENUM`) si legge con le
 *   etichette per valore del vocabolario (quello del tenant vince);
 * - lo `status` di un ticket si legge con l'etichetta del PASSO del workflow,
 *   perché i suoi valori sono i nomi dei passi (`VOCABULARIES_WITHOUT_LABELS`);
 * - un campo della LIBRERIA dei moduli del catalogo (`:FormField`) si legge con
 *   il suo vocabolario, come gli altri (moduli del catalogo, ondata 5): sta su
 *   un nodo diverso dal metamodello dei CI, quindi la query qui sotto non lo
 *   trovava e una tabella diceva «development» dove la colonna della lista
 *   delle richieste diceva «Sviluppo»;
 * - una LISTA di valori (selezione multipla) si legge valore per valore: prima
 *   usciva grezza perché il labeler guardava solo le stringhe;
 * - tutto il resto (testo, date, numeri, un valore che il vocabolario non
 *   conosce più) resta com'è: meglio il valore vero che un'etichetta inventata.
 */
import type { Session } from 'neo4j-driver'
import { toPascalCase } from '@opengraphity/schema-generator'
import { getWorkflowSteps } from './workflowHelpers.js'
import { SYSTEM_TENANT } from './enumScope.js'
import { labelFor, parseValueLabels, type EnumValueLabels, type Lingua } from './enumValueLabels.js'
import { languageFor } from './tenantLanguage.js'
import { logger } from './logger.js'

/** Da dove viene un valore: l'etichetta Neo4j del nodo e il nome del campo come nel metamodello. */
export interface ReportValueSource {
  neo4jLabel: string
  field:      string
}

export type ReportValueLabeler = (source: ReportValueSource | null, value: unknown) => unknown

export const identityLabeler: ReportValueLabeler = (_source, value) => value

const snake = (s: string) => s.replace(/([A-Z])/g, '_$1').toLowerCase()

/** L'unico nodo che porta le risposte di un modulo del catalogo. */
const FORM_ANSWER_LABEL = 'ServiceRequest'
const sourceKey = (s: ReportValueSource) => `${s.neo4jLabel}.${snake(s.field)}`

export async function loadReportValueLabeler(
  session: Session, tenantId: string, sources: ReadonlyArray<ReportValueSource | null>,
  /**
   * La lingua di chi guarda (secondo giro UI del 15 set 2026 · V-20): con
   * l'interfaccia in italiano il widget «Incident per priorità» diceva
   * «Medium, Critical», perché le etichette si mettevano nella lingua del
   * cliente. Assente = quella del cliente (invio programmato, PDF, Excel).
   */
  language?: Lingua,
): Promise<ReportValueLabeler> {
  const wanted = sources.filter((s): s is ReportValueSource => s !== null)
  if (wanted.length === 0) return identityLabeler

  const types = await session.executeRead((tx) => tx.run(`
    MATCH (t:CITypeDefinition)-[:HAS_FIELD]->(f:CIFieldDefinition)
    WHERE t.active = true AND t.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
      AND f.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
    OPTIONAL MATCH (f)-[:USES_ENUM]->(e:EnumTypeDefinition)
      WHERE e.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
    RETURN t.name AS typeName, t.scope AS scope, t.neo4j_label AS neo4jLabel, f.name AS field, e.name AS vocabulary
  `, { tenantId }))

  const rows = types.records.map((r) => ({
    typeName:   r.get('typeName') as string,
    scope:      r.get('scope') as string | null,
    neo4jLabel: (r.get('neo4jLabel') as string | null) ?? toPascalCase(r.get('typeName') as string),
    field:      r.get('field') as string,
    vocabulary: r.get('vocabulary') as string | null,
  }))

  // sorgente → come si legge: i passi di un workflow o un vocabolario
  /**
   * I campi della libreria dei moduli, con il loro vocabolario. Solo se il
   * report chiede almeno una colonna di una RICHIESTA: sono le sole che
   * compilano un modulo, e su un report di incident sarebbe una lettura
   * inutile a ogni esecuzione.
   */
  const moduli = new Map<string, string>()
  if (wanted.some((s) => s.neo4jLabel === FORM_ANSWER_LABEL)) {
    const f = await session.executeRead((tx) => tx.run(`
      MATCH (f:FormField {tenant_id: $tenantId})
      WHERE f.vocabulary IS NOT NULL AND f.vocabulary <> ''
      RETURN f.name AS name, f.vocabulary AS vocabulary
    `, { tenantId }))
    for (const r of f.records) moduli.set(String(r.get('name')), String(r.get('vocabulary')))
  }

  const readers = new Map<string, { kind: 'steps'; itilType: string } | { kind: 'vocabulary'; name: string }>()
  for (const s of wanted) {
    // Prima la libreria dei moduli: il nome di un campo della libreria è unico
    // fra le proprietà della richiesta (`assertFormFieldName` lo garantisce),
    // quindi non può essere anche un campo del metamodello.
    const daModulo = s.neo4jLabel === FORM_ANSWER_LABEL ? moduli.get(snake(s.field)) : undefined
    if (daModulo) { readers.set(sourceKey(s), { kind: 'vocabulary', name: daModulo }); continue }
    const own = rows.find((r) => r.neo4jLabel === s.neo4jLabel && snake(r.field) === snake(s.field))
    // I campi di sistema dei CI (status, environment) stanno sul tipo `__base__`.
    const row = own ?? rows.find((r) => r.typeName === '__base__' && snake(r.field) === snake(s.field) && !rows.some((x) => x.neo4jLabel === s.neo4jLabel && x.scope === 'itil'))
    if (!row) continue
    if (row.scope === 'itil' && snake(row.field) === 'status') readers.set(sourceKey(s), { kind: 'steps', itilType: row.typeName })
    else if (row.vocabulary) readers.set(sourceKey(s), { kind: 'vocabulary', name: row.vocabulary })
  }
  if (readers.size === 0) return identityLabeler

  const lingua: Lingua = language ?? await languageFor(tenantId)

  const vocabularyNames = [...new Set([...readers.values()].flatMap((r) => (r.kind === 'vocabulary' ? [r.name] : [])))]
  const vocabularies = new Map<string, { tenant: string; labels: EnumValueLabels }>()
  if (vocabularyNames.length > 0) {
    const v = await session.executeRead((tx) => tx.run(`
      MATCH (e:EnumTypeDefinition)
      WHERE e.name IN $names AND e.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
      RETURN e.name AS name, e.tenant_id AS tenant, e.value_labels AS labels
    `, { names: vocabularyNames, tenantId }))
    for (const r of v.records) {
      const name = r.get('name') as string
      const tenant = r.get('tenant') as string
      // Il vocabolario del tenant vince su quello spedito (`enumScope`).
      if (vocabularies.get(name)?.tenant === tenantId) continue
      const parsed = parseValueLabels(r.get('labels'))
      if (parsed.error) logger.warn({ tenantId, vocabulary: name, error: parsed.error }, '[report] etichette del vocabolario illeggibili: i valori restano grezzi')
      vocabularies.set(name, { tenant, labels: parsed.labels })
    }
  }

  const stepLabels = new Map<string, Map<string, string>>()
  for (const r of readers.values()) {
    if (r.kind !== 'steps' || stepLabels.has(r.itilType)) continue
    const steps = await getWorkflowSteps(session, tenantId, r.itilType)
    // V-20: il passo nella lingua di chi legge, se il passo ha la traduzione; altrimenti la sua etichetta.
    stepLabels.set(r.itilType, new Map(steps.filter((s) => s.label).map((s) => [s.name, s.labels.find((l) => l.language === lingua)?.label || s.label!])))
  }

  return (source, value) => {
    if (source === null) return value
    const reader = readers.get(sourceKey(source))
    if (!reader) return value
    const uno = (v: unknown): unknown => {
      if (typeof v !== 'string' || v === '') return v
      if (reader.kind === 'steps') return stepLabels.get(reader.itilType)?.get(v) ?? v
      const vocabulary = vocabularies.get(reader.name)
      if (!vocabulary || !vocabulary.labels[v]) return v
      return labelFor(v, vocabulary.labels, lingua, lingua)
    }
    // Una LISTA si legge valore per valore (selezione multipla dei moduli):
    // prima cadeva nel ramo «non è una stringa» e usciva grezza.
    return Array.isArray(value) ? value.map(uno) : uno(value)
  }
}
