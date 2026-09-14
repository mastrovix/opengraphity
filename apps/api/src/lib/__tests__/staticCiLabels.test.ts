/**
 * Le liste statiche di tipi CI (whitelist dei report, entità dei widget) non
 * citano tipi che il prodotto non spedisce, e il web non offre ciò che l'API
 * rifiuta (revisione del 14 set 2026 · F19).
 *
 * Dal vivo: `NetworkDevice` e `VirtualMachine` erano nella whitelist dei report e
 * fra le entità dei widget, ma nessun tipo CI spedito ha quelle etichette —
 * un widget «Network device» contava sempre zero. E il pannello dei widget
 * offriva come raggruppamento `risk`/`impact` sulle change e `businessUnit`
 * sulle business application, campi che `validateWidgetConfig` rifiuta.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn() }))

const { STATIC_REPORT_LABELS } = await import('../reportWhitelist.js')
const { WIDGET_ENTITY_LABELS, WIDGET_ALLOWED_FIELDS } = await import('../../graphql/resolvers/customWidget.js')

const API = join(import.meta.dirname, '..', '..')
const WEB = join(API, '..', '..', 'web', 'src')

/** Le etichette dei tipi CI spediti (il seed del metamodello). */
const SHIPPED_CI_LABELS = new Set(
  [...readFileSync(join(API, 'scripts', 'seed-metamodel.ts'), 'utf8').matchAll(/neo4j_label:\s*'([A-Za-z_]+)'/g)].map((m) => m[1]!),
)
/** Le etichette del grafo ITSM che non sono tipi CI. */
const ITSM_LABELS = new Set(['ConfigurationItem', 'CIBase', 'Incident', 'Change', 'ChangeTask', 'Problem', 'KnownError', 'ServiceRequest',
  'Team', 'User', 'WorkflowDefinition', 'WorkflowInstance', 'ReportTemplate'])

const webWidget = readFileSync(join(WEB, 'pages', 'dashboard', 'useWidgetConfig.ts'), 'utf8')
const webEntityTypes = [...(webWidget.match(/export const ENTITY_TYPES = \[([\s\S]*?)\n\]/)?.[1] ?? '').matchAll(/value:\s*'([a-z_]+)'/g)].map((m) => m[1]!)
const webAllowedFields: Record<string, string[]> = Object.fromEntries(
  [...(webWidget.match(/export const ALLOWED_FIELDS[^=]*= \{([\s\S]*?)\n\}/)?.[1] ?? '').matchAll(/^\s*([a-z_]+):\s*\[([^\]]*)\]/gm)]
    .map((m) => [m[1]!, [...m[2]!.matchAll(/'([A-Za-z_]+)'/g)].map((f) => f[1]!)]),
)

describe('liste statiche di tipi CI', () => {
  it('il seed del metamodello si legge (se questo cade, il pattern non trova più i tipi)', () => {
    expect(SHIPPED_CI_LABELS.has('Server')).toBe(true)
    expect(SHIPPED_CI_LABELS.size).toBeGreaterThanOrEqual(8)
  })

  it('la whitelist statica dei report cita solo etichette ITSM o tipi CI spediti', () => {
    expect(STATIC_REPORT_LABELS.filter((l) => !ITSM_LABELS.has(l) && !SHIPPED_CI_LABELS.has(l))).toEqual([])
  })

  it('le entità dei widget sono etichette ITSM o tipi CI spediti', () => {
    expect(Object.values(WIDGET_ENTITY_LABELS).filter((l) => !ITSM_LABELS.has(l) && !SHIPPED_CI_LABELS.has(l))).toEqual([])
  })
})

describe('il pannello dei widget offre solo ciò che l\'API accetta', () => {
  it('le stesse entità', () => {
    expect(webEntityTypes.length).toBeGreaterThan(0)
    expect([...webEntityTypes].sort()).toEqual(Object.keys(WIDGET_ENTITY_LABELS).sort())
  })

  it('ogni campo offerto per un\'entità è accettato dall\'API', () => {
    expect(Object.keys(webAllowedFields).length).toBeGreaterThan(0)
    const rejected = Object.entries(webAllowedFields).flatMap(([entity, fields]) =>
      fields.filter((f) => !(WIDGET_ALLOWED_FIELDS[entity] ?? []).includes(f)).map((f) => `${entity}.${f}`))
    expect(rejected).toEqual([])
  })
})
