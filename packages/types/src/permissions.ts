/**
 * IL CATALOGO DEI PERMESSI (verifica «Cosa resta cablato», ondata 7).
 *
 * ## Il difetto
 * Cosa può fare una persona era deciso da quattro ruoli fissi — `admin`,
 * `operator`, `viewer`, `end_user` — scritti in elenchi dentro
 * `apps/api/src/lib/authorization.ts` e in una sessantina di controlli sparsi.
 * Un cliente che voleva un «Change Manager» o un «Service Desk 1° livello» non
 * poteva farlo.
 *
 * ## La regola
 * Un ruolo è un nome più un insieme di permessi, e i permessi sono QUESTI: il
 * catalogo è del prodotto, l'amministratore sceglie quali dare e non ne inventa.
 * Ogni operazione dell'API chiede almeno uno dei permessi della sua riga
 * (`apps/api/src/lib/operationPermissions.ts`). I quattro ruoli di prima
 * diventano ruoli di fabbrica (`FACTORY_ROLE_PERMISSIONS`), modificabili ma non
 * cancellabili.
 *
 * I ticket hanno permessi tipo per tipo (scelta del proprietario, 15 set 2026);
 * portale e area di lavoro sono permessi come gli altri e si possono dare
 * insieme; `admin.users` gestisce anche i ruoli.
 */
import type { UserRole } from './user.js'

export const PERMISSION_AREAS = ['access', 'tickets', 'knowledge', 'cmdb', 'analysis', 'configuration', 'administration'] as const
export type PermissionArea = (typeof PERMISSION_AREAS)[number]

/** L'ordine è quello della matrice: area per area. */
export const PERMISSION_CATALOG = [
  // Accesso
  { key: 'workspace.use',                 area: 'access' },
  { key: 'workspace.notificationsManage', area: 'access' },
  { key: 'portal.read',                   area: 'access' },
  { key: 'portal.submit',                 area: 'access' },
  // Ticket
  { key: 'incident.read',           area: 'tickets' },
  { key: 'incident.write',          area: 'tickets' },
  { key: 'incident.ai',             area: 'tickets' },
  { key: 'problem.read',            area: 'tickets' },
  { key: 'problem.write',           area: 'tickets' },
  { key: 'problem.delete',          area: 'tickets' },
  { key: 'change.read',             area: 'tickets' },
  { key: 'change.write',            area: 'tickets' },
  { key: 'change.delete',           area: 'tickets' },
  { key: 'request.read',            area: 'tickets' },
  { key: 'request.write',           area: 'tickets' },
  { key: 'ticket.work',             area: 'tickets' },
  { key: 'ticket.assignable',       area: 'tickets' },
  { key: 'ticket.moderateComments', area: 'tickets' },
  { key: 'ticket.internalChat',     area: 'tickets' },
  { key: 'approval.decide',         area: 'tickets' },
  { key: 'approval.override',       area: 'tickets' },
  // Knowledge base
  { key: 'kb.read',  area: 'knowledge' },
  { key: 'kb.write', area: 'knowledge' },
  { key: 'kb.rate',  area: 'knowledge' },
  // CMDB e monitoraggio
  { key: 'cmdb.read',          area: 'cmdb' },
  { key: 'cmdb.write',         area: 'cmdb' },
  { key: 'event.read',         area: 'cmdb' },
  { key: 'event.work',         area: 'cmdb' },
  { key: 'service.read',       area: 'cmdb' },
  { key: 'service.reevaluate', area: 'cmdb' },
  // Analisi e report
  { key: 'analysis.read',       area: 'analysis' },
  { key: 'anomaly.resolve',     area: 'analysis' },
  { key: 'anomaly.scan',        area: 'analysis' },
  /*
   * LE PROPOSTE DI MIGLIORAMENTO (20 set 2026). Tre permessi e non uno,
   * perché sono tre gesti diversi: leggere, far girare l'analisi, e
   * ACCETTARE — che è l'unico che scrive.
   *
   * Il proprietario ha deciso che accettare richiede solo `proposal.accept`,
   * e non anche il permesso dell'azione sottostante. È una scelta presa
   * sapendo la conseguenza: chi ha questo permesso fa eseguire qualunque
   * voce del catalogo chiuso. Per questo nei ruoli di fabbrica va SOLO
   * all'admin — un ruolo su misura può darlo a qualcun altro, ma allora è
   * una decisione di chi lo configura, scritta e visibile.
   */
  { key: 'proposal.read',       area: 'analysis' },
  { key: 'proposal.accept',     area: 'analysis' },
  { key: 'proposal.run',        area: 'analysis' },
  { key: 'report.read',         area: 'analysis' },
  { key: 'report.write',        area: 'analysis' },
  { key: 'report.schedule',     area: 'analysis' },
  { key: 'report.ai',           area: 'analysis' },
  { key: 'assistant.use',       area: 'analysis' },
  { key: 'dashboard.use',       area: 'analysis' },
  { key: 'dashboard.manageAll', area: 'analysis' },
  // Configurazione
  { key: 'config.organization',  area: 'configuration' },
  { key: 'config.metamodel',     area: 'configuration' },
  { key: 'config.workflow',      area: 'configuration' },
  { key: 'config.sla',           area: 'configuration' },
  { key: 'config.automation',    area: 'configuration' },
  { key: 'config.notifications', area: 'configuration' },
  { key: 'config.catalog',       area: 'configuration' },
  { key: 'config.monitoring',    area: 'configuration' },
  { key: 'config.services',      area: 'configuration' },
  { key: 'config.integrations',  area: 'configuration' },
  // Amministrazione
  { key: 'admin.users',  area: 'administration' },
  { key: 'admin.audit',  area: 'administration' },
  { key: 'admin.system', area: 'administration' },
] as const satisfies ReadonlyArray<{ key: string; area: PermissionArea }>

export type Permission = (typeof PERMISSION_CATALOG)[number]['key']

export const PERMISSIONS: readonly Permission[] = PERMISSION_CATALOG.map((p) => p.key)

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)
}

/**
 * Chi lavora i ticket: riceve le assegnazioni, le e-mail «a tutti» e il
 * riepilogo giornaliero senza destinatario. Prima era «admin o operator».
 */
export const TICKET_WORKER_PERMISSION: Permission = 'ticket.assignable'

/** Il permesso che gestisce persone, team e ruoli: non può restare senza nessuno. */
export const USERS_ADMIN_PERMISSION: Permission = 'admin.users'

const VIEWER: readonly Permission[] = [
  'workspace.use', 'workspace.notificationsManage', 'portal.read',
  'incident.read', 'problem.read', 'change.read', 'request.read',
  'kb.read', 'kb.rate',
  'cmdb.read', 'event.read', 'service.read',
  'analysis.read', 'report.read', 'dashboard.use',
  // L'assistente AI: prima lo usava chiunque avesse fatto login, portale compreso.
  'assistant.use',
]

const OPERATOR: readonly Permission[] = [
  ...VIEWER,
  'portal.submit',
  'incident.write', 'incident.ai', 'problem.write', 'change.write', 'request.write',
  'ticket.work', 'ticket.assignable', 'ticket.internalChat', 'approval.decide',
  'kb.write', 'cmdb.write', 'event.work',
  'anomaly.resolve', 'report.write', 'report.ai',
]

/**
 * I ruoli di fabbrica: i permessi che i quattro ruoli avevano prima, con le
 * quattro correzioni approvate dal proprietario (15 set 2026):
 *  - il viewer segna lette e nasconde le proprie notifiche;
 *  - il viewer non chiede più il triage AI né la bozza di risoluzione;
 *  - adottare i valori spediti del Dizionario è metamodello (solo admin);
 *  - il viewer salva la disposizione delle proprie dashboard.
 */
export const FACTORY_ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  admin:    PERMISSIONS,
  operator: OPERATOR,
  viewer:   VIEWER,
  end_user: ['portal.read', 'portal.submit', 'kb.rate'],
}
