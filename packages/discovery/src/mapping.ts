import type { DiscoveredCI, MappingRule } from './types.js'

// ── applyMappingRules ─────────────────────────────────────────────────────────

export function applyMappingRules(ci: DiscoveredCI, rules: MappingRule[]): DiscoveredCI {
  if (rules.length === 0) return ci

  const properties = { ...ci.properties }

  for (const rule of rules) {
    // Le regole `ci_type` sono alias di TIPO, non di proprietà: le legge
    // `ciTypeAliases` (ondata 6 · A-11). Senza questo salto un alias il cui
    // nome coincidesse con un tag scriverebbe anche una proprietà, per caso.
    if (rule.kind === 'ci_type') continue
    const raw = ci.tags[rule.source_field]
    if (raw === undefined) continue

    let value: string = raw
    switch (rule.transform) {
      case 'lowercase': value = raw.toLowerCase(); break
      case 'uppercase': value = raw.toUpperCase(); break
      case 'trim':      value = raw.trim();        break
    }

    properties[rule.target_field] = value
  }

  return { ...ci, properties }
}

/**
 * Gli alias di tipo dichiarati nelle regole della sorgente (ondata 6 · A-11):
 * valore in arrivo (minuscolo) → nome del tipo CI del cliente. Una regola con
 * un capo vuoto è un errore di configurazione e si dice: un alias che non
 * mappa niente farebbe credere di aver risolto il problema.
 */
export function ciTypeAliases(rules: readonly MappingRule[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const rule of rules) {
    if (rule.kind !== 'ci_type') continue
    const from = rule.source_field?.trim()
    const to   = rule.target_field?.trim()
    if (!from || !to) {
      throw new Error(
        `mapping_rules: una regola di tipo "ci_type" ha source_field=${JSON.stringify(rule.source_field)} e ` +
        `target_field=${JSON.stringify(rule.target_field)}: servono entrambi (il valore in arrivo e il nome del tipo CI).`,
      )
    }
    out.set(from.toLowerCase(), to)
  }
  return out
}

// ── inferCIType ───────────────────────────────────────────────────────────────

/**
 * Il nome si guarda per PAROLE, non per sottostringa (revisione totale ·
 * E-40): `name.includes('cert')` faceva di `concert-web-01` un certificato e
 * `includes('lb')` faceva di `albany-db` un load balancer. I nomi dei CI sono
 * separati da `-`, `_`, `.` o spazi: qui si confrontano i pezzi.
 */
function nameWords(name: string): ReadonlySet<string> {
  return new Set(name.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean))
}

export function inferCIType(ci: DiscoveredCI): string {
  if (ci.ci_type) return ci.ci_type

  // E-40: si confrontano le PAROLE del nome, non le sottostringhe (il nome
  // minuscolo intero non serve piu a nessuno).
  const words  = nameWords(ci.name)
  const props  = ci.properties

  const engine = typeof props['engine'] === 'string' ? props['engine'].toLowerCase() : ''
  if (engine === 'postgres' || engine === 'postgresql' || engine === 'mysql' ||
      engine === 'mariadb'  || engine === 'oracle'    || engine === 'mssql') {
    return 'database_instance'
  }
  if (engine === 'aurora' || engine === 'dynamodb' || engine === 'mongodb') {
    return 'database'
  }

  if (typeof props['certificate_arn'] === 'string' || words.has('certificate') || words.has('cert')) {
    return 'certificate'
  }
  if (words.has('lb') || words.has('loadbalancer') || (words.has('load') && words.has('balancer')) ||
      typeof props['load_balancer_type'] === 'string') {
    return 'load_balancer'
  }
  if (words.has('container') || typeof props['container_id'] === 'string') {
    return 'container'
  }
  if (words.has('bucket') || typeof props['bucket_name'] === 'string') {
    return 'storage'
  }
  if (words.has('vpc') || words.has('subnet') || typeof props['cidr_block'] === 'string') {
    return 'network'
  }
  if (typeof props['app_name'] === 'string' || words.has('function') || words.has('lambda')) {
    return 'application'
  }

  return 'server'
}

// ── normalizeProperties ───────────────────────────────────────────────────────

/** I nomi che dicono «questa proprietà è un sì/no» (E-40). */
const BOOLEAN_PROPERTY_RE = /^(is_|has_|allow_|enable)|(_enabled|_flag)$|^(monitored|deleted|encrypted|public|active|enabled|disabled|managed)$/

function isBooleanProperty(key: string): boolean {
  return BOOLEAN_PROPERTY_RE.test(key.toLowerCase())
}

export function normalizeProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) continue

    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed === '') continue
      /**
       * «true»/«false» diventano booleani SOLO per le proprietà che sono
       * booleane per nome (revisione totale · E-40): la conversione valeva per
       * qualunque proprietà, quindi un tag `Environment=false` o una versione
       * `"true"` cambiavano tipo e poi non si filtravano più come testo. Le
       * proprietà dei CI sono `is_*`, `has_*`, `*_enabled`, `monitored`,
       * `deleted`…: quelle sono booleane, il resto resta testo.
       */
      if (isBooleanProperty(key)) {
        if (trimmed === 'true')  { result[key] = true;  continue }
        if (trimmed === 'false') { result[key] = false; continue }
      }
      result[key] = trimmed
      continue
    }

    result[key] = value
  }

  return result
}
