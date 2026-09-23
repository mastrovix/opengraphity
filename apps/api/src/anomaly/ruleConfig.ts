/**
 * LA CONFIGURAZIONE DELLE REGOLE DI ANOMALIA, dato del cliente (verifica «Cosa
 * resta cablato», ondata 5).
 *
 * ## Il difetto
 * Le sette regole erano Cypher costanti: la soglia dello SPOF (5 dipendenti),
 * la lunghezza massima di un ciclo (6), la dimensione di un cluster isolato
 * (5), quante severità contano come «critiche» (`'critical'`), la relazione
 * vietata (`Server -DEPENDS_ON-> Application`), le relazioni da seguire, la
 * gravità di ogni regola e il fatto stesso che una regola girasse. Un cliente
 * con una CMDB diversa riceveva le anomalie di un'altra CMDB, e l'unica difesa
 * era segnarle a mano come falsi positivi, una per una.
 *
 * ## La regola
 * La LOGICA di ogni regola resta del prodotto (`rules.ts`: cos'è un orfano,
 * un ciclo, un cluster). Il cliente sceglie, per regola: attiva o no, gravità,
 * soglia, tipi di CI e relazioni su cui lavora, severità di incident che
 * contano, relazioni vietate. `AnomalyRuleConfig {tenant_id, rule_key}` porta
 * la scelta; la migrazione `20260926_1010_anomaly_rule_configs` la semina con i
 * valori che il codice usava, così il primo giorno non cambia nessuna anomalia.
 *
 * Tipi di CI vuoti = TUTTI i tipi del cliente, anche quelli che creerà: è il
 * significato dichiarato (ed è quello che le regole facevano, vedi A-9), non un
 * ripiego. Un tipo, una relazione o una severità che non esiste più nel
 * metamodello è un errore che la pagina mostra sulla regola e che fa fallire
 * lo scan di quella regola, non un filtro che scarta in silenzio.
 */
import { getSession } from '@opengraphity/neo4j'
import { loadMetamodel } from '@opengraphity/schema-generator'
import { ValidationError } from '../lib/errors.js'
import { ENUM_SCOPE } from '../lib/enumScope.js'
import { domainVocabulary } from '../lib/domainMatrix.js'
import { RELATIONSHIP_TYPE_RE, impactRelPatternForTenant, splitRelationshipTypes } from '../lib/ciMetamodelForTenant.js'

export const ANOMALY_RULE_KEYS = [
  'orphan_ci', 'spof', 'dependency_cycle', 'missing_owner', 'unauthorized_relation', 'isolated_cluster', 'risk_concentration',
] as const
export type AnomalyRuleKey = (typeof ANOMALY_RULE_KEYS)[number]

/** La scala della gravità di un'anomalia: è del prodotto (le statistiche della pagina contano per questi quattro). */
export const ANOMALY_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export type AnomalySeverity = (typeof ANOMALY_SEVERITIES)[number]

export interface ForbiddenRelation { fromType: string; relation: string; toType: string }

export interface AnomalyRuleSettings {
  enabled:            boolean
  severity:           AnomalySeverity
  /** Nomi dei tipi di CI (`CITypeDefinition.name`); vuoto = tutti. */
  ciTypes:            string[]
  relations:          string[]
  threshold:          number | null
  /** Valori del vocabolario `severity` del cliente. */
  incidentSeverities: string[]
  forbidden:          ForbiddenRelation[]
}

export interface AnomalyRuleConfig extends AnomalyRuleSettings {
  ruleKey:   AnomalyRuleKey
  isDefault: boolean
  updatedAt: string | null
}

/** Quali scelte ha senso fare su ogni regola. Una scelta che la regola non usa si rifiuta. */
export interface AnomalyRuleSpec {
  ciTypes:            boolean
  relations:          boolean
  /** An empty list of relations means every relation between CIs of the tenant (resolved when the rule runs). */
  allRelationsWhenEmpty?: boolean
  threshold:          { min: number; max: number } | null
  incidentSeverities: boolean
  forbidden:          boolean
}

export const ANOMALY_RULE_SPECS: Readonly<Record<AnomalyRuleKey, AnomalyRuleSpec>> = {
  orphan_ci:             { ciTypes: true,  relations: false, threshold: null,                 incidentSeverities: false, forbidden: false },
  spof:                  { ciTypes: true,  relations: true,  threshold: { min: 1, max: 1000 }, incidentSeverities: false, forbidden: false },
  /** La soglia è la lunghezza MASSIMA del ciclo cercato (la minima, 2, è la definizione di ciclo). */
  dependency_cycle:      { ciTypes: true,  relations: true,  threshold: { min: 2, max: 10 },   incidentSeverities: false, forbidden: false },
  missing_owner:         { ciTypes: true,  relations: false, threshold: null,                 incidentSeverities: false, forbidden: false },
  unauthorized_relation: { ciTypes: false, relations: false, threshold: null,                 incidentSeverities: false, forbidden: true },
  /** I tipi sono i CANDIDATI da cui si cerca il cluster; la soglia è quanti CI al massimo raggiunge. */
  isolated_cluster:      { ciTypes: true,  relations: true,  allRelationsWhenEmpty: true, threshold: { min: 1, max: 50 }, incidentSeverities: false, forbidden: false },
  risk_concentration:    { ciTypes: true,  relations: false, threshold: { min: 1, max: 1000 }, incidentSeverities: true,  forbidden: false },
}

const empty = { ciTypes: [], relations: [], threshold: null, incidentSeverities: [], forbidden: [] }

/** Trascritti dalle Cypher costanti di `rules.ts` prima di questa ondata, regola per regola. */
export const FACTORY_ANOMALY_RULES: Readonly<Record<AnomalyRuleKey, AnomalyRuleSettings>> = {
  orphan_ci:             { ...empty, enabled: true, severity: 'medium' },
  spof:                  { ...empty, enabled: true, severity: 'critical', relations: ['DEPENDS_ON'], threshold: 5 },
  dependency_cycle:      { ...empty, enabled: true, severity: 'high', relations: ['DEPENDS_ON'], threshold: 6 },
  missing_owner:         { ...empty, enabled: true, severity: 'low' },
  unauthorized_relation: { ...empty, enabled: true, severity: 'medium', forbidden: [{ fromType: 'server', relation: 'DEPENDS_ON', toType: 'application' }] },
  /*
   * Tour of 23 Sep 2026 (D49): «cut off from the main graph» was measured on
   * four relation types only, so an application whose link to the rest of the
   * CMDB is a REALIZES or a capability looked isolated, and so did every
   * certificate next to it — 486 anomalies on the demo tenant, 3 of them
   * real. The cluster is now searched on every relation between CIs, from the
   * applications (a certificate always sits next to what it secures: flagging
   * it too repeats the same cluster).
   */
  isolated_cluster:      { ...empty, enabled: true, severity: 'medium', ciTypes: ['application'], relations: [], threshold: 5 },
  risk_concentration:    { ...empty, enabled: true, severity: 'high', threshold: 5, incidentSeverities: ['critical'] },
}

export function isAnomalyRuleKey(v: unknown): v is AnomalyRuleKey {
  return typeof v === 'string' && (ANOMALY_RULE_KEYS as readonly string[]).includes(v)
}

// ── Le scelte possibili, dal metamodello del cliente ─────────────────────────

export interface AnomalyRuleOptions {
  ciTypes:            Array<{ name: string; label: string; neo4jLabel: string }>
  relations:          string[]
  incidentSeverities: string[]
}

export async function anomalyRuleOptions(tenantId: string): Promise<AnomalyRuleOptions> {
  const types = await loadMetamodel(tenantId, ENUM_SCOPE)
  const relations = new Set<string>((await impactRelPatternForTenant(tenantId)).split('|'))
  for (const t of types) {
    for (const r of t.relations) {
      for (const rt of splitRelationshipTypes(r.relationshipType, `CIRelationDefinition "${r.name}" of type "${t.name}"`)) relations.add(rt)
    }
  }
  return {
    ciTypes: types
      .filter((t) => t.neo4jLabel)
      .map((t) => ({ name: t.name, label: t.label ?? t.name, neo4jLabel: t.neo4jLabel }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    relations: [...relations].sort(),
    incidentSeverities: [...await domainVocabulary(tenantId, 'severity')],
  }
}

// ── Validazione ──────────────────────────────────────────────────────────────

function fail(ruleKey: string, message: string, key: string, params: Record<string, string | number> = {}): never {
  throw new ValidationError(`Anomaly rule "${ruleKey}": ${message}`, { key: `errors.anomalyRule.${key}`, params: { rule: ruleKey, ...params } })
}

function stringList(raw: unknown, ruleKey: string, field: string): string[] {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || v === '')) fail(ruleKey, `${field} must be a list of names`, 'shape', { field })
  const list = raw as string[]
  const dup = list.find((v, i) => list.indexOf(v) !== i)
  if (dup) fail(ruleKey, `"${dup}" appears twice in ${field}`, 'duplicate', { field, value: dup })
  return list
}

/**
 * Controlla la forma e i valori contro le scelte possibili del cliente.
 * Una scelta che la regola non usa deve restare vuota: salvarla farebbe credere
 * all'admin che conti.
 */
export function assertAnomalyRuleSettings(ruleKey: AnomalyRuleKey, raw: unknown, options: AnomalyRuleOptions): AnomalyRuleSettings {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(ruleKey, 'the settings must be an object', 'shape', { field: '' })
  const obj = raw as Record<string, unknown>
  const spec = ANOMALY_RULE_SPECS[ruleKey]

  if (typeof obj['enabled'] !== 'boolean') fail(ruleKey, 'enabled must be true or false', 'shape', { field: 'enabled' })
  const severity = obj['severity']
  if (typeof severity !== 'string' || !(ANOMALY_SEVERITIES as readonly string[]).includes(severity)) {
    fail(ruleKey, `severity must be one of ${ANOMALY_SEVERITIES.join(', ')}`, 'severity', { allowed: ANOMALY_SEVERITIES.join(', ') })
  }

  const typeNames = new Set(options.ciTypes.map((t) => t.name))
  const relationNames = new Set(options.relations)

  const ciTypes = stringList(obj['ciTypes'] ?? [], ruleKey, 'ciTypes')
  if (!spec.ciTypes && ciTypes.length) fail(ruleKey, 'this rule does not work on a choice of CI types', 'notApplicable', { field: 'ciTypes' })
  for (const t of ciTypes) if (!typeNames.has(t)) fail(ruleKey, `"${t}" is not a CI type of this tenant`, 'unknownCIType', { value: t })

  const relations = stringList(obj['relations'] ?? [], ruleKey, 'relations')
  if (!spec.relations && relations.length) fail(ruleKey, 'this rule does not follow relations', 'notApplicable', { field: 'relations' })
  if (spec.relations && relations.length === 0 && !spec.allRelationsWhenEmpty) fail(ruleKey, 'choose at least one relation to follow', 'relationsRequired')
  for (const r of relations) {
    if (!RELATIONSHIP_TYPE_RE.test(r) || !relationNames.has(r)) fail(ruleKey, `"${r}" is not a relation of this tenant`, 'unknownRelation', { value: r })
  }

  const rawThreshold = obj['threshold'] ?? null
  let threshold: number | null = null
  if (spec.threshold) {
    const { min, max } = spec.threshold
    if (typeof rawThreshold !== 'number' || !Number.isInteger(rawThreshold) || rawThreshold < min || rawThreshold > max) {
      fail(ruleKey, `the threshold must be an integer between ${String(min)} and ${String(max)}`, 'threshold', { min, max, got: String(rawThreshold) })
    }
    threshold = rawThreshold
  } else if (rawThreshold !== null) {
    fail(ruleKey, 'this rule has no threshold', 'notApplicable', { field: 'threshold' })
  }

  const incidentSeverities = stringList(obj['incidentSeverities'] ?? [], ruleKey, 'incidentSeverities')
  if (!spec.incidentSeverities && incidentSeverities.length) fail(ruleKey, 'this rule does not look at incidents', 'notApplicable', { field: 'incidentSeverities' })
  if (spec.incidentSeverities && incidentSeverities.length === 0) fail(ruleKey, 'choose at least one incident severity', 'severitiesRequired')
  for (const s of incidentSeverities) {
    if (!options.incidentSeverities.includes(s)) fail(ruleKey, `"${s}" is not in the severity dictionary of this tenant`, 'unknownSeverity', { value: s })
  }

  const rawForbidden = obj['forbidden'] ?? []
  if (!Array.isArray(rawForbidden)) fail(ruleKey, 'forbidden must be a list', 'shape', { field: 'forbidden' })
  if (!spec.forbidden && rawForbidden.length) fail(ruleKey, 'this rule has no forbidden relations', 'notApplicable', { field: 'forbidden' })
  const forbidden: ForbiddenRelation[] = []
  const seen = new Set<string>()
  for (const f of rawForbidden as unknown[]) {
    const e = (f ?? {}) as Record<string, unknown>
    const fromType = e['fromType'], relation = e['relation'], toType = e['toType']
    if (typeof fromType !== 'string' || !typeNames.has(fromType)) fail(ruleKey, `"${String(fromType)}" is not a CI type of this tenant`, 'unknownCIType', { value: String(fromType) })
    if (typeof toType !== 'string' || !typeNames.has(toType)) fail(ruleKey, `"${String(toType)}" is not a CI type of this tenant`, 'unknownCIType', { value: String(toType) })
    if (typeof relation !== 'string' || !RELATIONSHIP_TYPE_RE.test(relation) || !relationNames.has(relation)) {
      fail(ruleKey, `"${String(relation)}" is not a relation of this tenant`, 'unknownRelation', { value: String(relation) })
    }
    const k = `${fromType}|${relation}|${toType}`
    if (seen.has(k)) fail(ruleKey, `${fromType} -${relation}-> ${toType} appears twice`, 'duplicate', { field: 'forbidden', value: k })
    seen.add(k)
    forbidden.push({ fromType, relation, toType })
  }
  if (spec.forbidden && forbidden.length === 0) fail(ruleKey, 'declare at least one forbidden relation', 'forbiddenRequired')

  return { enabled: obj['enabled'] as boolean, severity: severity as AnomalySeverity, ciTypes, relations, threshold, incidentSeverities, forbidden }
}

// ── Lettura e scrittura ──────────────────────────────────────────────────────

function parseSettings(raw: unknown, tenantId: string, ruleKey: string): AnomalyRuleSettings {
  try {
    return JSON.parse(String(raw)) as AnomalyRuleSettings
  } catch (e) {
    throw new Error(`Tenant ${tenantId}: AnomalyRuleConfig ${ruleKey} is not valid JSON (${e instanceof Error ? e.message : String(e)})`, { cause: e })
  }
}

/** Tutte le regole del cliente, in ordine; quella mai salvata è il seme, detto (`isDefault`). */
export async function loadAnomalyRuleConfigs(tenantId: string): Promise<AnomalyRuleConfig[]> {
  const session = getSession(undefined, 'READ')
  try {
    const r = await session.executeRead((tx) => tx.run(
      `MATCH (c:AnomalyRuleConfig {tenant_id: $tenantId})
       RETURN c.rule_key AS ruleKey, c.settings AS settings, c.updated_at AS updatedAt`,
      { tenantId },
    ))
    const stored = new Map(r.records.map((rec) => [rec.get('ruleKey') as string, rec]))
    return ANOMALY_RULE_KEYS.map((ruleKey) => {
      const rec = stored.get(ruleKey)
      if (!rec) return { ruleKey, ...FACTORY_ANOMALY_RULES[ruleKey], isDefault: true, updatedAt: null }
      return { ruleKey, ...parseSettings(rec.get('settings'), tenantId, ruleKey), isDefault: false, updatedAt: (rec.get('updatedAt') as string | null) ?? null }
    })
  } finally {
    await session.close()
  }
}

/**
 * Il motivo per cui una regola salvata non si può eseguire (un tipo o una
 * relazione tolti dal metamodello dopo il salvataggio), come errore con chiave;
 * `null` se è a posto.
 */
export function anomalyRuleProblem(config: AnomalyRuleConfig, options: AnomalyRuleOptions): ValidationError | null {
  try {
    assertAnomalyRuleSettings(config.ruleKey, config, options)
    return null
  } catch (err) {
    if (err instanceof ValidationError) return err
    throw err
  }
}

export async function saveAnomalyRuleConfig(tenantId: string, ruleKey: unknown, input: unknown): Promise<AnomalyRuleConfig> {
  if (!isAnomalyRuleKey(ruleKey)) {
    throw new ValidationError(`Unknown anomaly rule "${String(ruleKey)}"`, { key: 'errors.anomalyRule.unknownRule', params: { rule: String(ruleKey) } })
  }
  const settings = assertAnomalyRuleSettings(ruleKey, input, await anomalyRuleOptions(tenantId))
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite((tx) => tx.run(
      `MERGE (c:AnomalyRuleConfig {tenant_id: $tenantId, rule_key: $ruleKey})
       SET c.settings = $settings, c.updated_at = $now`,
      { tenantId, ruleKey, settings: JSON.stringify(settings), now },
    ))
  } finally {
    await session.close()
  }
  return { ruleKey, ...settings, isDefault: false, updatedAt: now }
}
