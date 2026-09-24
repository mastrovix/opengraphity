/**
 * QUALE PERMESSO APRE QUALE PAGINA (ondata 7 di «Nulla cablato»).
 *
 * Una tabella sola, letta dalle rotte (`main.tsx`, `RequirePermission`), dalla
 * barra laterale e dal menu in alto: una voce si vede solo se la pagina si
 * apre, quindi nessuna voce porta a «accesso negato». Le chiavi sono i path
 * delle rotte, senza la barra iniziale. I permessi sono gli stessi che l'API
 * chiede alle operazioni della pagina (apps/api/src/lib/operationPermissions.ts).
 *
 * Una riga è «almeno uno di questi».
 */
import type { Permission } from '@opengraphity/types'

export const ROUTE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  '':                              ['dashboard.use'],
  'dashboard':                     ['dashboard.use'],
  'profile':                       ['workspace.use'],
  'my-tasks':                      ['workspace.use'],
  'approvals':                     ['approval.decide'],
  'assistant':                     ['assistant.use'],

  'incidents':                     ['incident.read'],
  'incidents/new':                 ['incident.write'],
  'incidents/:id':                 ['incident.read'],
  'problems':                      ['problem.read'],
  'problems/new':                  ['problem.write'],
  'problems/:id':                  ['problem.read'],
  'changes':                       ['change.read'],
  'changes/new':                   ['change.write'],
  'changes/calendar':              ['change.read'],
  'changes/:id':                   ['change.read'],
  'tasks/:taskId':                 ['change.read'],
  'requests':                      ['request.read'],
  'requests/new':                  ['request.write'],
  'requests/:id':                  ['request.read'],

  'knowledge-base':                ['kb.read'],
  'knowledge-base/:slug':          ['kb.read'],
  // B-21: apre l'articolo dal suo id (le notifiche portano l'id, non lo slug).
  'kb-articles/:id':               ['kb.read'],
  'admin/knowledge-base':          ['kb.write'],

  'cmdb':                          ['cmdb.read'],
  'cmdb/health':                   ['cmdb.read'],
  'ci/:typeName':                  ['cmdb.read'],
  'ci/:typeName/:id':              ['cmdb.read'],
  'cis/:id':                       ['cmdb.read'],
  'topology':                      ['cmdb.read'],

  'events':                        ['event.read'],
  'events/:id':                    ['event.read'],
  'monitoring/health':             ['event.read'],
  'monitoring/services':           ['service.read'],
  'monitoring/services/:id':       ['service.read'],
  'monitoring/sources':            ['config.monitoring'],
  'monitoring/sources/new':        ['config.monitoring'],
  'monitoring/sources/:id':        ['config.monitoring'],
  'settings/event-policy':         ['config.monitoring'],
  'settings/anomaly-rules':        ['config.monitoring'],

  'anomalies':                     ['analysis.read'],
  'proposals':                     ['proposal.read'],
  'analysis/daily-work':           ['analysis.read'],
  'analysis/what-if':              ['analysis.read'],
  'reports':                       ['report.read'],
  'reports/sla':                   ['report.read'],
  'reports/ola-uc':                ['report.read'],
  'custom-reports':                ['report.read'],

  // La diagnostica della configurazione è della salute della piattaforma:
  // lo stesso permesso con cui l'hook la chiede (useConfigurationIssues).
  'settings/diagnostics':          ['admin.system'],
  'settings/organization':         ['config.organization'],
  'settings/ci-types':             ['config.metamodel'],
  'settings/itil-designer':        ['config.metamodel'],
  /**
   * Moduli del catalogo (ondata 1): la pagina si apre con `config.catalog`,
   * che e il permesso per comporre un modulo. La scheda della libreria dei
   * campi tocca la forma dei dati e le sue mutation chiedono
   * `config.metamodel`: chi ha solo il catalogo vede la libreria ma l'API gli
   * rifiuta la creazione, con il suo messaggio.
   */
  'settings/catalog-forms':        ['config.catalog'],
  'settings/enum-designer':        ['config.metamodel'],
  'settings/domain-matrices':      ['config.metamodel'],
  'workflow':                      ['config.workflow'],
  'workflow/:id':                  ['config.workflow'],
  'settings/notifications':        ['config.notifications'],
  'settings/notification-rules':   ['config.notifications'],
  'settings/sync':                 ['config.integrations'],
  'admin/integrations':            ['config.integrations'],
  'admin/triggers':                ['config.automation'],
  'admin/business-rules':          ['config.automation'],
  'admin/sla-policies':            ['config.sla'],
  'admin/ola-uc':                  ['config.sla'],
  'admin/service-catalog':         ['config.catalog'],
  'admin/assessment-questions':    ['config.catalog'],

  'teams':                         ['admin.users'],
  'teams/:id':                     ['admin.users'],
  'users':                         ['admin.users'],
  'users/:id':                     ['admin.users'],
  'roles':                         ['admin.users'],
  'roles/new':                     ['admin.users'],
  'roles/:key':                    ['admin.users'],
  'security/login':                ['admin.users'],
  'logs':                          ['admin.audit'],
  'admin/audit':                   ['admin.audit'],
  'admin/queues':                  ['admin.system'],
  'admin/monitoring':              ['admin.system'],
}

/** I permessi della pagina di un indirizzo di menu (`/admin/audit`). Un indirizzo senza riga è un errore. */
export function routePermissions(to: string): readonly Permission[] {
  const key = to.replace(/^\//, '')
  const perms = ROUTE_PERMISSIONS[key]
  if (!perms) throw new Error(`[routePermissions] no permission rule for route "${to}"`)
  return perms
}
