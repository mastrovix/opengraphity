import { ValidationError } from './errors.js'
// Shared advanced-filter WHERE builder — used by all list resolvers

export interface AdvFilterRule {
  field:    string
  operator: string
  value:    string | string[] | null
  value2?:  string
  logic:    'AND' | 'OR'
}

export interface AdvFilterGroup {
  rules: AdvFilterRule[]
}

export const FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/

/** Defines how a relation-based field should be queried (EXISTS subquery) */
export interface RelationFieldDef {
  relType:     string   // Neo4j relationship type, e.g. 'ASSIGNED_TO_TEAM'
  targetLabel: string   // Neo4j label of the target node, e.g. 'Team'
  searchProp:  string   // Property to match on, e.g. 'name'
  /**
   * Vincolo sulle PROPRIETÀ della relazione (moduli del catalogo, ondata 2).
   *
   * Serve quando lo stesso tipo di relazione porta più campi: due campi di un
   * modulo che puntano entrambi a un CI usano `FORM_REFERS_TO_CI`, e si
   * distinguono per `rel.field`. Senza questo vincolo un filtro su un campo
   * troverebbe i riferimenti dell'ALTRO.
   *
   * Le chiavi vengono dal codice (mai dall'input) e i valori passano come
   * parametri.
   */
  relProps?:   Readonly<Record<string, string>>
}

import { propertyForField } from './fieldProperty.js'

/**
 * Builds a Cypher WHERE fragment from a JSON-encoded FilterGroup.
 *
 * @param filtersJson   - JSON string of { rules: AdvFilterRule[] }
 * @param params        - Mutated in-place: query parameters are added here
 * @param allowedFields - Field whitelist; rules with unknown fields are skipped
 * @param nodeAlias     - The Cypher node variable name (default 'n')
 * @param relationFields - Optional relation-based fields (e.g. ownerGroup, assignedTeam)
 * @param typeName      - GraphQL type of the node: a field stored under another property
 *                        name (`Incident.priority` → `severity`, lib/fieldProperty.ts) is
 *                        filtered on that property
 */
/**
 * GLI OPERATORI DI LISTA VANNO SUI CAMPI LISTA, E VICEVERSA (revisione del 17
 * set 2026).
 *
 * L'operatore era validato contro un elenco, il TIPO del campo non entrava
 * nella decisione: un `contains` su una selezione multipla genera
 * `toLower(lista) CONTAINS …`, che in Cypher è un errore di tipo. L'errore
 * veniva mascherato e la pagina Richieste INTERA non caricava, senza dire
 * quale regola. Il client offre già gli operatori giusti, quindi ci si arriva
 * con un filtro salvato a mano o con un client più vecchio — ed è proprio il
 * caso in cui serve un messaggio, non un 500.
 *
 * `listFields` sono i nomi che sul nodo portano una lista; chi non li conosce
 * non passa niente e il controllo non scatta (il comportamento di prima).
 */
const OPERATORI_DI_LISTA: readonly string[] = ['has_any', 'has_all', 'has_none', 'list_is_empty', 'list_is_not_empty']
const OPERATORI_DI_TESTO: readonly string[] = ['contains', 'starts_with', 'ends_with']

function assertOperatoreCompatibile(field: string, operator: string, listFields: ReadonlySet<string> | undefined): void {
  // `undefined` = il chiamante non sa quali campi sono liste: non si indovina,
  // e il comportamento resta quello di prima (i test di questo file lo fissano).
  if (!listFields) return
  const lista = listFields.has(field)
  if (lista && OPERATORI_DI_TESTO.includes(operator)) {
    throw new ValidationError(
      `The field "${field}" holds several values: "${operator}" is for text. Use "has_any", "has_all" or "has_none".`,
      { key: 'errors.filter.operatorForList', params: { field, operator } },
    )
  }
  if (!lista && OPERATORI_DI_LISTA.includes(operator)) {
    throw new ValidationError(
      `The field "${field}" holds one value: "${operator}" is for multiple-choice fields.`,
      { key: 'errors.filter.operatorForSingle', params: { field, operator } },
    )
  }
}

export function buildAdvancedWhere(
  filtersJson: string,
  params: Record<string, unknown>,
  allowedFields: Set<string>,
  nodeAlias = 'n',
  relationFields: Record<string, RelationFieldDef> = {},
  typeName = '',
  listFields?: ReadonlySet<string>,
): string {
  let group: AdvFilterGroup
  try { group = JSON.parse(filtersJson) as AdvFilterGroup }
  catch (e) {
    // Corrupt filters must fail the query — returning '' would silently serve
    // the FULL unfiltered list while the user believes it is filtered.
    throw new Error(`Invalid filters JSON: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
  if (!group.rules?.length) return ''

  const conditions: string[] = []

  for (let i = 0; i < group.rules.length; i++) {
    const rule = group.rules[i]
    const pk   = `af_${i}`
    const pk2  = `af_${i}_2`

    // Unknown/invalid fields must fail loud, not silently drop the rule: a
    // dropped rule widens the result set behind the user's back. (The whitelist
    // stays as the injection guard — this just refuses instead of ignoring.)
    if (!FIELD_NAME_RE.test(rule.field)) {
      throw new Error(`Invalid filter field name: ${JSON.stringify(rule.field)}`)
    }
    if (!allowedFields.has(rule.field)) {
      throw new Error(`Filter field not allowed for this entity: ${rule.field}`)
    }
    // L'operatore deve stare col TIPO del campo, altrimenti la Cypher che
    // segue è invalida e cade tutta la lista senza dire quale regola.
    assertOperatoreCompatibile(rule.field, rule.operator, listFields)

    // Relation field: generate EXISTS subquery
    const relDef = relationFields[rule.field]
    if (relDef) {
      const ta = `_af_t${i}`
      // Il vincolo sulle proprietà della relazione: chiavi dal codice, valori
      // come parametri (vedi RelationFieldDef.relProps).
      let relPattern = ''
      if (relDef.relProps && Object.keys(relDef.relProps).length > 0) {
        const parti: string[] = []
        for (const [chiave, valore] of Object.entries(relDef.relProps)) {
          if (!FIELD_NAME_RE.test(chiave)) throw new Error(`Invalid relationship property name ${JSON.stringify(chiave)}`)
          const rp = `${pk}_rel_${chiave}`
          params[rp] = valore
          parti.push(`${chiave}: $${rp}`)
        }
        relPattern = ` {${parti.join(', ')}}`
      }
      if (rule.operator === 'is_empty') {
        conditions.push(`NOT EXISTS { MATCH (${nodeAlias})-[:${relDef.relType}${relPattern}]->(:${relDef.targetLabel}) }`)
      } else if (rule.operator === 'is_not_empty') {
        conditions.push(`EXISTS { MATCH (${nodeAlias})-[:${relDef.relType}${relPattern}]->(:${relDef.targetLabel}) }`)
      } else if ((rule.operator === 'equals' || rule.operator === 'contains') && rule.value) {
        params[pk] = rule.operator === 'contains'
          ? (rule.value as string).toLowerCase()
          : rule.value
        const cond = rule.operator === 'contains'
          ? `toLower(${ta}.${relDef.searchProp}) CONTAINS $${pk}`
          : `${ta}.${relDef.searchProp} = $${pk}`
        conditions.push(`EXISTS { MATCH (${nodeAlias})-[:${relDef.relType}${relPattern}]->(${ta}:${relDef.targetLabel}) WHERE ${cond} }`)
      } else {
        // Unsupported operator on a relation field — refuse, don't silently drop.
        throw new Error(`Operator ${JSON.stringify(rule.operator)} not supported on relation field ${rule.field}`)
      }
      continue
    }

    const prop = `${nodeAlias}.${propertyForField(typeName, rule.field)}`

    switch (rule.operator) {
      case 'contains':
        params[pk] = rule.value
        conditions.push(`toLower(${prop}) CONTAINS toLower($${pk})`)
        break
      case 'starts_with':
        params[pk] = rule.value
        conditions.push(`toLower(${prop}) STARTS WITH toLower($${pk})`)
        break
      case 'ends_with':
        params[pk] = rule.value
        conditions.push(`toLower(${prop}) ENDS WITH toLower($${pk})`)
        break
      case 'equals':
        params[pk] = rule.value
        conditions.push(`${prop} = $${pk}`)
        break
      /**
       * «DIVERSO DA» COMPRENDE CHI NON HA RISPOSTO (revisione del 17 set 2026).
       *
       * In Cypher `NULL <> 'x'` è NULL, cioè falso: un ticket che quella
       * domanda non l'ha mai avuta spariva dal risultato. Sulle richieste è la
       * norma, non l'eccezione — un campo di modulo esiste solo per la voce di
       * catalogo che lo chiede: su 300 richieste con 40 nate da quella voce,
       * «Ambiente ≠ produzione» restituiva una trentina di righe e l'utente
       * leggeva «tutte tranne produzione».
       *
       * La regola giusta era già scritta dieci righe sotto per `has_none`, con
       * tanto di commento: qui mancava.
       */
      case 'not_equals':
        params[pk] = rule.value
        conditions.push(`(${prop} IS NULL OR ${prop} <> $${pk})`)
        break
      case 'is_empty':
        conditions.push(`(${prop} IS NULL OR ${prop} = '')`)
        break
      case 'is_not_empty':
        conditions.push(`(${prop} IS NOT NULL AND ${prop} <> '')`)
        break
      case 'after':
        params[pk] = rule.value
        conditions.push(`datetime(${prop}) > datetime($${pk})`)
        break
      case 'before':
        params[pk] = rule.value
        conditions.push(`datetime(${prop}) < datetime($${pk})`)
        break
      case 'between':
        params[pk]  = rule.value
        params[pk2] = rule.value2
        conditions.push(`datetime(${prop}) >= datetime($${pk}) AND datetime(${prop}) <= datetime($${pk2})`)
        break
      case 'today':
        conditions.push(`date(${prop}) = date()`)
        break
      case 'last_7_days':
        conditions.push(`datetime(${prop}) > datetime() - duration('P7D')`)
        break
      case 'last_30_days':
        conditions.push(`datetime(${prop}) > datetime() - duration('P30D')`)
        break
      case 'in':
        params[pk] = rule.value
        conditions.push(`${prop} IN $${pk}`)
        break
      /**
       * GLI OPERATORI DI LISTA (selezione multipla dei moduli, ondata 4).
       *
       * Un campo `multi_enum` sta sul nodo come LISTA di stringhe. Gli
       * operatori scalari qui sopra su una lista non sbagliano: non trovano
       * MAI niente (`['a','b'] = 'a'` è falso, e `CONTAINS` su una lista è un
       * errore di tipo in Cypher). Quindi servono i loro.
       *
       * `rule.value` è la lista dei valori scelti; il confronto è sull'insieme,
       * non sull'ordine.
       */
      case 'has_any':
        params[pk] = rule.value
        conditions.push(`(${prop} IS NOT NULL AND ANY(_v IN $${pk} WHERE _v IN ${prop}))`)
        break
      case 'has_all':
        params[pk] = rule.value
        conditions.push(`(${prop} IS NOT NULL AND ALL(_v IN $${pk} WHERE _v IN ${prop}))`)
        break
      case 'has_none':
        params[pk] = rule.value
        // Un campo mai compilato NON contiene nessuno dei valori: `IS NULL` è
        // parte della risposta giusta, non un caso da scartare.
        conditions.push(`(${prop} IS NULL OR NONE(_v IN $${pk} WHERE _v IN ${prop}))`)
        break
      case 'list_is_empty':
        conditions.push(`(${prop} IS NULL OR size(${prop}) = 0)`)
        break
      case 'list_is_not_empty':
        conditions.push(`(${prop} IS NOT NULL AND size(${prop}) > 0)`)
        break
      case 'not_in':
        params[pk] = rule.value
        // Come `not_equals`: chi non ha risposto non è «fra i valori esclusi».
        conditions.push(`(${prop} IS NULL OR NOT ${prop} IN $${pk})`)
        break
      default:
        // Unknown operator = corrupt filter — refuse, don't silently drop the rule.
        throw new Error(`Unknown filter operator: ${JSON.stringify(rule.operator)}`)
    }
  }

  if (!conditions.length) return ''

  // Group OR chains in parens; AND separates groups.
  // rule[i].logic describes the connector between rule[i] and rule[i+1].
  //   OR  → continue into the same group
  //   AND → close current group, start a new one
  const orGroups: string[][] = []
  let current: string[] = []

  for (let i = 0; i < conditions.length; i++) {
    current.push(conditions[i])
    const isLast    = i === conditions.length - 1
    const connector = group.rules[i]?.logic ?? 'AND'
    if (isLast || connector === 'AND') {
      orGroups.push(current)
      current = []
    }
  }

  return orGroups
    .map((g) => g.length === 1 ? g[0] : `(${g.join(' OR ')})`)
    .join(' AND ')
}
