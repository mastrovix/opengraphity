import type { DiscoveredCI, MappingRule } from './types.js'

// ── applyMappingRules ─────────────────────────────────────────────────────────

export function applyMappingRules(ci: DiscoveredCI, rules: MappingRule[]): DiscoveredCI {
  if (rules.length === 0) return ci

  const properties = { ...ci.properties }

  for (const rule of rules) {
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

// ── inferCIType ───────────────────────────────────────────────────────────────

export function inferCIType(ci: DiscoveredCI): string {
  if (ci.ci_type) return ci.ci_type

  const name   = ci.name.toLowerCase()
  const props  = ci.properties

  const engine = typeof props['engine'] === 'string' ? props['engine'].toLowerCase() : ''
  if (engine === 'postgres' || engine === 'postgresql' || engine === 'mysql' ||
      engine === 'mariadb'  || engine === 'oracle'    || engine === 'mssql') {
    return 'database_instance'
  }
  if (engine === 'aurora' || engine === 'dynamodb' || engine === 'mongodb') {
    return 'database'
  }

  if (typeof props['certificate_arn'] === 'string' || name.includes('certificate') || name.includes('cert')) {
    return 'certificate'
  }
  if (name.includes('lb') || name.includes('load-balancer') || name.includes('loadbalancer') ||
      typeof props['load_balancer_type'] === 'string') {
    return 'load_balancer'
  }
  if (name.includes('container') || typeof props['container_id'] === 'string') {
    return 'container'
  }
  if (name.includes('bucket') || typeof props['bucket_name'] === 'string') {
    return 'storage'
  }
  if (name.includes('vpc') || name.includes('subnet') || typeof props['cidr_block'] === 'string') {
    return 'network'
  }
  if (typeof props['app_name'] === 'string' || name.includes('function') || name.includes('lambda')) {
    return 'application'
  }

  return 'server'
}

// ── normalizeProperties ───────────────────────────────────────────────────────

export function normalizeProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) continue

    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed === '') continue
      if (trimmed === 'true')  { result[key] = true;  continue }
      if (trimmed === 'false') { result[key] = false; continue }
      result[key] = trimmed
      continue
    }

    result[key] = value
  }

  return result
}
