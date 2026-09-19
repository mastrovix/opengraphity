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

const API = join(import.meta.dirname, '..', '..')
const WEB = join(API, '..', '..', 'web', 'src')

/** Le etichette dei tipi CI spediti (il seed del metamodello). */
const SHIPPED_CI_LABELS = new Set(
  [...readFileSync(join(API, 'scripts', 'seed-metamodel.ts'), 'utf8').matchAll(/neo4j_label:\s*'([A-Za-z_]+)'/g)].map((m) => m[1]!),
)
/** Le etichette del grafo ITSM che non sono tipi CI. */
const ITSM_LABELS = new Set(['ConfigurationItem', 'CIBase', 'Incident', 'Change', 'ChangeTask', 'Problem', 'KnownError', 'ServiceRequest',
  // I TASK (20 set 2026): il generico che un passo di workflow crea su
  // qualunque ticket, e i cinque per CI delle change. Entrano nei report.
  'Task', 'AssessmentTask', 'DeployPlanTask', 'ValidationTest', 'DeploymentTask', 'ReviewTask',
  'Team', 'User', 'WorkflowDefinition', 'WorkflowInstance', 'ReportTemplate'])

const webWidget = readFileSync(join(WEB, 'pages', 'dashboard', 'useWidgetConfig.ts'), 'utf8')
const apiWidget = readFileSync(join(API, 'graphql', 'resolvers', 'customWidget.ts'), 'utf8')

describe('liste statiche di tipi CI', () => {
  it('il seed del metamodello si legge (se questo cade, il pattern non trova più i tipi)', () => {
    expect(SHIPPED_CI_LABELS.has('Server')).toBe(true)
    expect(SHIPPED_CI_LABELS.size).toBeGreaterThanOrEqual(8)
  })

  it('la whitelist statica dei report cita solo etichette ITSM o tipi CI spediti', () => {
    expect(STATIC_REPORT_LABELS.filter((l) => !ITSM_LABELS.has(l) && !SHIPPED_CI_LABELS.has(l))).toEqual([])
  })
})

/**
 * Ondata 5 di «Nulla cablato»: le liste dei widget non esistono più, né
 * nell'API né nel web. Entità e campi vengono dal catalogo del metamodello
 * (lib/widgetCatalog.ts), che il web legge con la query `widgetCatalog`: se
 * una lista scritta a mano torna, un tipo o un campo del cliente sparisce di
 * nuovo dai widget.
 */
describe('i widget non hanno liste scritte a mano', () => {
  it('niente elenco di entità o di campi nel resolver', () => {
    expect(apiWidget).not.toMatch(/WIDGET_ENTITY_LABELS\s*[:=]|WIDGET_ALLOWED_FIELDS\s*[:=]|NUMERIC_FIELDS\s*[:=]/)
    expect(apiWidget).toContain('widgetCatalog(')
  })

  it('niente elenco di entità o di campi nel pannello', () => {
    expect(webWidget).not.toMatch(/export const (ENTITY_TYPES|ALLOWED_FIELDS)\b/)
    expect(webWidget).toContain('GET_WIDGET_CATALOG')
  })
})
