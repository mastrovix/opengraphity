/**
 * Contratto produttori ↔ tabella `entity_type → percorso` (revisione 2,
 * D3.2/D5.1): ogni `entity_type` con cui una notifica può arrivare al pannello
 * in-app o all'email deve essere in NOTIFICATION_ENTITY_PATHS
 * (@opengraphity/types), altrimenti la notifica «non porta da nessuna parte».
 *
 * Il dispatcher ricava l'entity_type dal payload (`entity_type`) oppure dal
 * prefisso del tipo di evento (`incident.created` → `incident`). Qui si
 * estraggono dal sorgente dell'API:
 *  (a) i prefissi di tutti i `publishEvent('x.y'` e `publishEvent(\`x.${…}`;
 *  (b) i letterali `entity_type: 'x'` nei payload (allarmi, tempeste);
 *  (c) i tipi di entità del motore SLA (`packages/sla`), che finiscono in
 *      `sla.*`/`ola.*` come `entity_type`.
 * Ogni valore deve avere un percorso, salvo le esclusioni dichiarate qui con
 * il motivo (payload senza id: nessuna pagina da aprire).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NOTIFICATION_ENTITY_PATHS, isNotificationEntityType } from '@opengraphity/types'

const here    = dirname(fileURLToPath(import.meta.url))
const apiSrc  = join(here, '../..')
const slaSrc  = join(here, '../../../../../packages/sla/src')

/** Prefissi di evento il cui payload non ha un'entità raggiungibile, con il motivo. */
const NO_ENTITY_PAGE: Record<string, string> = {
  portal:   'portal.ticket.created: payload {ticketId, …} senza `id` → il dispatcher non produce entity_id',
  sync:     'sync.completed/failed: payload {runId, sourceId, stats} senza `id` → nessun entity_id',
  conflict: 'conflict.created: evento di discovery senza `id` nel payload',
  sla:      'sla.warning/breached: entity_type viene dal payload (incident/problem/change/service_request), non dal prefisso',
  ola:      'ola.breached: come sla.*',
  workflow: 'workflow.step.entered: entityType viene dal payload (incident/change/problem/request)',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p)
  }
  return out
}

const sources = walk(apiSrc).map((p) => readFileSync(p, 'utf8'))

const publishedPrefixes = new Set<string>()
const literalEntityTypes = new Set<string>()
for (const src of sources) {
  for (const m of src.matchAll(/publishEvent\(\s*['`]([a-z_]+)\./g)) publishedPrefixes.add(m[1]!)
  for (const m of src.matchAll(/entity_type:\s*'([a-z_]+)'/g)) literalEntityTypes.add(m[1]!)
  // unioni letterali nei tipi dei payload (`entity_type: 'incident' | 'inbound_webhook'`)
  for (const m of src.matchAll(/entity_type:\s*((?:'[a-z_]+'\s*\|\s*)+'[a-z_]+')/g)) {
    for (const v of m[1]!.matchAll(/'([a-z_]+)'/g)) literalEntityTypes.add(v[1]!)
  }
}

describe('entity_type prodotti dall\'API ↔ NOTIFICATION_ENTITY_PATHS', () => {
  it('il sorgente è stato letto davvero (guardia contro un percorso sbagliato)', () => {
    expect(sources.length).toBeGreaterThan(50)
    expect(publishedPrefixes).toContain('incident')
    expect(publishedPrefixes).toContain('event')
    expect(publishedPrefixes).toContain('service')
    expect(literalEntityTypes).toContain('inbound_webhook')
  })

  it('ogni prefisso di publishEvent ha un percorso, oppure un\'esclusione motivata', () => {
    const missing = [...publishedPrefixes].filter((p) => !isNotificationEntityType(p) && !(p in NO_ENTITY_PAGE))
    expect(missing, `prefissi senza percorso né esclusione: ${missing.join(', ')}`).toEqual([])
  })

  it('ogni entity_type scritto letteralmente nei payload ha un percorso', () => {
    const missing = [...literalEntityTypes].filter((t) => !isNotificationEntityType(t))
    expect(missing, `entity_type senza percorso: ${missing.join(', ')}`).toEqual([])
  })

  it('i tipi di entità del motore SLA (packages/sla) hanno tutti un percorso', () => {
    const engine = readFileSync(join(slaSrc, 'engine.ts'), 'utf8')
    const m = engine.match(/entityType:\s*((?:'[a-z_]+'\s*\|\s*)+'[a-z_]+')/)
    expect(m, 'unione entityType non trovata in packages/sla/src/engine.ts').not.toBeNull()
    const types = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!)
    expect(types).toEqual(expect.arrayContaining(['incident', 'change', 'service_request', 'problem']))
    for (const t of types) expect(isNotificationEntityType(t), t).toBe(true)
  })

  it('le esclusioni nominano solo prefissi che esistono davvero (niente esclusioni fantasma)', () => {
    for (const p of Object.keys(NO_ENTITY_PAGE)) {
      const exists = publishedPrefixes.has(p) || p === 'sla' || p === 'ola' || p === 'workflow' || p === 'sync' || p === 'conflict'
      expect(exists, p).toBe(true)
    }
    // i tipi con percorso non devono essere anche esclusi
    for (const p of Object.keys(NO_ENTITY_PAGE)) expect(isNotificationEntityType(p), p).toBe(false)
  })

  it('ogni percorso della tabella è una rotta reale del web (main.tsx)', () => {
    const main = readFileSync(join(here, '../../../../web/src/main.tsx'), 'utf8')
    for (const [type, path] of Object.entries(NOTIFICATION_ENTITY_PATHS)) {
      const route = path.replace(/^\//, '')   // '/monitoring/services/:id' → 'monitoring/services/:id'
      expect(main.includes(`path: '${route}'`), `${type} → ${path} non è una rotta di main.tsx`).toBe(true)
    }
  })
})
