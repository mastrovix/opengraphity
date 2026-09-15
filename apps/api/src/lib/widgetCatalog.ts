/**
 * IL CATALOGO DEI WIDGET della dashboard, dal metamodello del cliente (verifica
 * «Cosa resta cablato», ondata 5).
 *
 * ## Il difetto
 * Entità e campi dei widget erano due liste scritte a mano, una nell'API
 * (`WIDGET_ENTITY_LABELS`, `WIDGET_ALLOWED_FIELDS`, `NUMERIC_FIELDS`) e una
 * copia nel web tenuta uguale da un test. Un tipo di CI creato dal cliente
 * (`firewall`), un campo aggiunto a un ticket (`outcome`) o un campo numerico
 * non comparivano mai, e i numerici erano tre nomi (`cpu_cores`, `ram_gb`,
 * `size_gb`) che nessun tipo spedito dichiara.
 *
 * ## La regola
 * Il catalogo si costruisce dal metamodello: i quattro tipi ITIL e i tipi di CI
 * attivi del cliente, ciascuno con i suoi campi (personalizzati compresi). La
 * PROTEZIONE DELLE QUERY resta: un'entità o un campo fuori catalogo è un
 * rifiuto, e nella Cypher arrivano solo l'etichetta del tipo e la proprietà di
 * un campo del catalogo — mai un nome scritto dall'utente.
 *
 *  - raggruppabili (e filtrabili): vocabolari, sì/no, e i testi dei campi del
 *    cliente; non i testi di sistema (titolo, descrizione: testo libero) né le
 *    date;
 *  - numerici (medie e somme): i campi `number`, più il punteggio di rischio
 *    aggregato della change, che è un campo calcolato dal prodotto.
 *
 * Il web legge lo stesso catalogo (`widgetCatalog`): non c'è più una copia.
 */
import { getSession } from '@opengraphity/neo4j'
import { loadMetamodel } from '@opengraphity/schema-generator'
import { ENUM_SCOPE } from './enumScope.js'
import { loadITILTypes } from './itilTypes.js'
import { createMetamodelCache } from './metamodelCache.js'
import { propertyForField } from './fieldProperty.js'

export interface WidgetCatalogField {
  name:         string
  label:        string
  fieldType:    string
  enumTypeName: string | null
  enumValues:   string[]
  /** La proprietà del nodo (snake_case, con gli alias di `fieldProperty.ts`). */
  property:     string
  groupable:    boolean
  numeric:      boolean
  /** Campo aggiunto dal cliente (non spedito col prodotto). */
  custom:       boolean
}

export interface WidgetCatalogEntity {
  entityType: string
  label:      string
  neo4jLabel: string
  group:      'itsm' | 'cmdb'
  fields:     WidgetCatalogField[]
}

/**
 * Campi del metamodello ITIL spedito che il ticket NON salva: la change non ha
 * un `risk` (il suo rischio è `aggregate_risk_score`) né un `impact` (l'impatto
 * è per CI, nell'assessment). Offrirli darebbe un widget con tutto sotto «N/A».
 */
export const WIDGET_UNSTORED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  change: ['risk', 'impact'],
}

/** Campi calcolati dal prodotto, che non stanno nel metamodello ma sul nodo sì. */
export const WIDGET_PRODUCT_FIELDS: Readonly<Record<string, readonly WidgetCatalogField[]>> = {
  change: [{
    name: 'aggregate_risk_score', label: 'Aggregate risk score', fieldType: 'number', enumTypeName: null, enumValues: [],
    property: 'aggregate_risk_score', groupable: false, numeric: true, custom: false,
  }],
}

const LABEL_RE = /^[A-Za-z][A-Za-z0-9_]*$/
const PROPERTY_RE = /^[a-z][a-z0-9_]*$/

interface RawField { name: unknown; label?: unknown; fieldType?: unknown; enumTypeName?: unknown; enumValues?: unknown; isSystem?: unknown }

function catalogField(neo4jLabel: string, f: RawField, custom: boolean): WidgetCatalogField | null {
  const name = String(f.name)
  const fieldType = String(f.fieldType ?? 'string')
  const property = propertyForField(neo4jLabel, name)
  // Un nome che non diventa una proprietà sicura non entra nel catalogo (e quindi mai in una Cypher).
  if (!PROPERTY_RE.test(property)) return null
  const system = f.isSystem === true
  const groupable = fieldType === 'enum' || fieldType === 'boolean' || (fieldType === 'string' && !system)
  const numeric = fieldType === 'number'
  if (!groupable && !numeric) return null
  return {
    name, label: String(f.label ?? name), fieldType,
    enumTypeName: (f.enumTypeName ?? null) as string | null,
    enumValues: Array.isArray(f.enumValues) ? (f.enumValues as string[]) : [],
    property, groupable, numeric, custom,
  }
}

async function loadCatalog(tenantId: string): Promise<WidgetCatalogEntity[]> {
  const session = getSession(undefined, 'READ')
  let itil: Awaited<ReturnType<typeof loadITILTypes>>
  try {
    itil = await loadITILTypes(session, tenantId)
  } finally {
    await session.close()
  }
  const ciTypes = await loadMetamodel(tenantId, ENUM_SCOPE)

  const tickets: WidgetCatalogEntity[] = itil
    .filter((t) => t.neo4jLabel && LABEL_RE.test(t.neo4jLabel))
    .map((t) => {
      const unstored = WIDGET_UNSTORED_FIELDS[t.name] ?? []
      const fields = (t.fields as RawField[])
        .filter((f) => !unstored.includes(String(f.name)))
        .map((f) => catalogField(t.neo4jLabel!, f, f.isSystem !== true))
        .filter((f): f is WidgetCatalogField => f !== null)
      return { entityType: t.name, label: t.label, neo4jLabel: t.neo4jLabel!, group: 'itsm' as const, fields: [...fields, ...(WIDGET_PRODUCT_FIELDS[t.name] ?? [])] }
    })

  const cis: WidgetCatalogEntity[] = ciTypes
    .filter((t) => t.neo4jLabel && LABEL_RE.test(t.neo4jLabel))
    .map((t) => ({
      entityType: t.name, label: t.label ?? t.name, neo4jLabel: t.neo4jLabel, group: 'cmdb' as const,
      fields: t.fields
        .map((f) => catalogField(t.neo4jLabel, f as RawField, t.scope === 'tenant' || (f as { scope?: string }).scope === 'tenant'))
        .filter((f): f is WidgetCatalogField => f !== null),
    }))

  return [...tickets, ...cis.sort((a, b) => a.label.localeCompare(b.label))]
}

const cache = createMetamodelCache<WidgetCatalogEntity[]>({
  name: 'widget-catalog',
  load: (tenantId) => loadCatalog(tenantId),
})

export function widgetCatalog(tenantId: string): Promise<WidgetCatalogEntity[]> {
  return cache.get(tenantId)
}

/** Solo per i test. */
export function clearWidgetCatalogCache(): void { cache.clear() }
