/**
 * THE NAMES THE MONITORING TOOLS USE (tour of 23 Sep 2026, D37).
 *
 * The alarms named their resource after the CMDB record — «CER_ora-prd-
 * expense-02.db.opengrafo-demo.com (renewal) (FQDN)», «Failure rate of
 * APP_Agate Event Processor» — as if Prometheus knew the inventory's
 * prefixes. A tool names what it watches in its own words, and the product
 * finds the CI through its ALIASES (services/events/transitions.ts,
 * `ciMatchCypher`):
 *  - Prometheus scrapes hosts and database instances by FQDN (the `instance`
 *    label, the port stripped: an alias of kind `hostname`), and probes the
 *    certificates by host name;
 *  - Dynatrace reports an entity by its id (`SERVICE-…`, an alias of kind
 *    `external_id`) and its display name;
 *  - Grafana labels a service or a database with its short name (`hostname`).
 * Discovery registered those aliases on the CIs (`source: 'discovery'`).
 */
import type { Rng } from './random.js'
import { CI_NAME_PREFIX, type CMDBPlan, type PlannedCI } from './cmdb.js'
import { CERTIFICATE_DOMAIN, slug } from './names.js'

export interface ToolIdentity {
  /** Prometheus: the scraped or probed host (FQDN). */
  host?: string
  /** Grafana: the short name of a service or a database. */
  service?: string
  /** Dynatrace: the entity id and its display name. */
  entityId?: string
  entityName?: string
}

export interface PlannedAlias { ciId: string; kind: 'hostname' | 'external_id'; value: string }

export interface ToolNames {
  byCI: Map<string, ToolIdentity>
  aliases: PlannedAlias[]
}

/** The CI's name without the inventory prefix: the name of the thing. */
export function rawName(ci: PlannedCI): string {
  const prefix = CI_NAME_PREFIX[ci.label]
  return ci.name.startsWith(prefix) ? ci.name.slice(prefix.length) : ci.name
}

/** The host a certificate is served on: its common name, without the year of a renewal; a wildcard is probed on its `www`. */
function certificateHost(ci: PlannedCI): string {
  const cn = rawName(ci).replace(/ \(\d{4}(-\d+)?\)$/, '')
  return cn.startsWith('*.') ? `www.${cn.slice(2)}` : cn
}

export function planToolNames(rng: Rng, cmdb: CMDBPlan): ToolNames {
  const byCI = new Map<string, ToolIdentity>()
  const aliases: PlannedAlias[] = []
  const taken = new Set<string>()
  const alias = (ciId: string, kind: PlannedAlias['kind'], value: string): void => {
    const v = kind === 'external_id' ? value : value.toLowerCase()
    // An alias is unique in the tenant (kind + value): the first CI keeps it.
    if (taken.has(`${kind}|${v}`)) return
    taken.add(`${kind}|${v}`)
    aliases.push({ ciId, kind, value: v })
  }
  const entityId = (): string => `SERVICE-${Array.from({ length: 16 }, () => rng.int(0, 15).toString(16)).join('').toUpperCase()}`
  for (const ci of cmdb.byLabel.Server) {
    const host = `${rawName(ci)}.infra.${CERTIFICATE_DOMAIN}`
    byCI.set(ci.id, { host })
    alias(ci.id, 'hostname', host)
  }
  for (const ci of cmdb.byLabel.DatabaseInstance) {
    const host = `${rawName(ci)}.db.${CERTIFICATE_DOMAIN}`
    byCI.set(ci.id, { host })
    alias(ci.id, 'hostname', host)
  }
  for (const ci of [...cmdb.byLabel.Application, ...cmdb.byLabel.Database]) {
    const id = entityId()
    const service = ci.label === 'Application' ? slug(rawName(ci)) : rawName(ci)
    byCI.set(ci.id, { entityId: id, entityName: rawName(ci), service })
    alias(ci.id, 'external_id', id)
    alias(ci.id, 'hostname', service)
  }
  // The newest certificate of a host is the one served today: it holds the alias.
  const certificates = [...cmdb.byLabel.Certificate].sort((a, b) => b.createdAtMs - a.createdAtMs)
  for (const ci of certificates) {
    const host = certificateHost(ci)
    byCI.set(ci.id, { host })
    alias(ci.id, 'hostname', host)
  }
  return { byCI, aliases }
}
