/**
 * LE VOCI DEL MENU, in un posto solo.
 *
 * Le leggono la barra laterale (quale voce accendere) e il percorso in cima
 * alla pagina (come chiamare la pagina e in quale gruppo sta). Prima il
 * percorso aveva un suo elenco di etichette per segmento d'indirizzo, e su
 * /reports/sla scriveva «AI Analysis / Sla»: /reports è l'indirizzo di AI
 * Analysis, ma SLA Report non ne è una sottopagina.
 */
import { LayoutDashboard, AlertCircle, Search, GitPullRequest, CalendarDays, HelpCircle, ClipboardList, Inbox, Route, UsersRound, User, BrainCircuit, LayoutGrid, ScrollText, Layers, Settings2, Activity, ShieldAlert, ShieldCheck, Share2, Bell, UserCircle, Tag, CheckSquare, BookOpen, Zap, GitBranch, Clock, Plug, FlaskConical, Sparkles, ShoppingCart, Gauge, Radar, HeartPulse, Boxes, Table2, Building2, Handshake, KeyRound, Stethoscope, Lightbulb } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { voceAttiva } from './menuActive'

export interface MenuItemDef { to: string; labelKey: string; icon: LucideIcon }

export const NAV_ITEM_DEFS = [
  { to: '/dashboard',      labelKey: 'sidebar.dashboard',     icon: LayoutDashboard },
  { to: '/approvals',      labelKey: 'sidebar.approvals',     icon: CheckSquare },
  { to: '/knowledge-base', labelKey: 'sidebar.knowledgeBase', icon: BookOpen },
  { to: '/assistant',      labelKey: 'sidebar.assistant',     icon: Sparkles },
]

export const ANALYSIS_ITEM_DEFS = [
  { to: '/anomalies',        labelKey: 'sidebar.anomalies',   icon: ShieldAlert  },
  { to: '/proposals',        labelKey: 'sidebar.proposals',   icon: Lightbulb    },
  { to: '/analysis/daily-work', labelKey: 'sidebar.dailyWork', icon: Gauge      },
  { to: '/topology',         labelKey: 'sidebar.topologyMap', icon: Share2       },
  { to: '/analysis/what-if', labelKey: 'sidebar.whatIf',      icon: FlaskConical },
]

// Monitoraggio (Event Management): console allarmi, Servizi monitorati,
// pagina Salute CI, sorgenti e policy. Quali voci si vedono lo dicono i
// permessi della pagina (lib/routePermissions), come per ogni altra voce. La
// mappa con la salute evidenziata resta raggiungibile da "Vedi sulla mappa".
export const MONITORING_ITEM_DEFS = [
  { to: '/events',                labelKey: 'sidebar.events',            icon: Radar      },
  { to: '/monitoring/services',   labelKey: 'sidebar.services',          icon: Boxes      },
  { to: '/monitoring/health',     labelKey: 'sidebar.ciHealth',          icon: HeartPulse },
  { to: '/monitoring/sources',    labelKey: 'sidebar.monitoringSources', icon: Plug       },
  { to: '/settings/event-policy', labelKey: 'sidebar.eventPolicy',       icon: Settings2  },
]

export const CONFIG_ITEM_DEFS = [
  { to: '/settings/diagnostics',      labelKey: 'sidebar.configurationDiagnostics', icon: Stethoscope },
  { to: '/settings/organization',    labelKey: 'sidebar.organization',    icon: Building2 },
  { to: '/settings/ci-types',        labelKey: 'sidebar.ciTypeDesigner',  icon: Layers   },
  { to: '/settings/itil-designer',   labelKey: 'sidebar.itilDesigner',    icon: Settings2 },
  { to: '/settings/catalog-forms',   labelKey: 'sidebar.catalogForms',    icon: ClipboardList },
  { to: '/settings/enum-designer',   labelKey: 'sidebar.enumDesigner',    icon: Tag      },
  { to: '/settings/domain-matrices', labelKey: 'sidebar.domainMatrices',  icon: Table2   },
  { to: '/settings/anomaly-rules',   labelKey: 'sidebar.anomalyRules',    icon: ShieldAlert },
  { to: '/workflow',                  labelKey: 'sidebar.workflowDesigner', icon: Route    },
]

// Personal page, the whole workspace (E-13): language + Slack link.
export const PROFILE_ITEM = { to: '/profile', labelKey: 'sidebar.profile', icon: UserCircle }

export const ITSM_ITEM_DEFS = [
  { to: '/incidents', labelKey: 'sidebar.incidents', icon: AlertCircle    },
  { to: '/problems',  labelKey: 'sidebar.problems',  icon: Search         },
  { to: '/changes',   labelKey: 'sidebar.changes',   icon: GitPullRequest },
  { to: '/changes/calendar', labelKey: 'sidebar.changeCalendar', icon: CalendarDays },
  { to: '/my-tasks',  labelKey: 'sidebar.myTasks',   icon: ClipboardList  },
  { to: '/requests',  labelKey: 'sidebar.requests',  icon: Inbox          },
]

export const REPORTING_ITEM_DEFS = [
  { to: '/reports',        labelKey: 'sidebar.aiAnalysis',    icon: BrainCircuit },
  { to: '/reports/sla',    labelKey: 'sidebar.slaReport',     icon: Gauge        },
  { to: '/reports/ola-uc', labelKey: 'sidebar.olaReport',     icon: Handshake    },
  { to: '/custom-reports', labelKey: 'sidebar.reportBuilder', icon: LayoutGrid   },
]

export const TEAMS_ITEM_DEFS = [
  { to: '/teams', labelKey: 'sidebar.teams', icon: UsersRound },
  { to: '/users', labelKey: 'sidebar.users', icon: User },
  { to: '/roles', labelKey: 'sidebar.roles', icon: KeyRound },
  { to: '/security/login', labelKey: 'sidebar.loginSecurity', icon: ShieldCheck },
]

export const SETTINGS_ITEM_DEFS = [
  { to: '/settings/notifications',      labelKey: 'sidebar.notificationChannels', icon: Bell },
  { to: '/settings/notification-rules', labelKey: 'sidebar.notificationRules',    icon: Bell },
  { to: '/settings/sync',               labelKey: 'sidebar.cmdbSync',             icon: Activity },
  { to: '/admin/queues',                labelKey: 'sidebar.bullBoard',            icon: Activity },
]

export const ADMIN_NAV_ITEM_DEFS = [
  { to: '/logs',                   labelKey: 'sidebar.logs',           icon: ScrollText  },
  { to: '/admin/audit',            labelKey: 'sidebar.auditLog',       icon: ShieldCheck },
  { to: '/admin/monitoring',       labelKey: 'sidebar.platformMonitoring', icon: Activity },
  { to: '/admin/knowledge-base',   labelKey: 'sidebar.kbAdmin',        icon: BookOpen    },
  { to: '/admin/triggers',         labelKey: 'sidebar.autoTriggers',   icon: Zap         },
  { to: '/admin/business-rules',   labelKey: 'sidebar.businessRules',  icon: GitBranch   },
  { to: '/admin/sla-policies',     labelKey: 'sidebar.slaPolicies',    icon: Clock       },
  { to: '/admin/ola-uc',           labelKey: 'sidebar.olaContracts',   icon: Handshake   },
  { to: '/admin/service-catalog',  labelKey: 'sidebar.serviceCatalog', icon: ShoppingCart},
  { to: '/admin/integrations',         labelKey: 'sidebar.integrations',        icon: Plug        },
  { to: '/admin/assessment-questions', labelKey: 'sidebar.assessmentQuestions', icon: HelpCircle  },
]

/**
 * Le sezioni del menu con il nome del gruppo che le contiene (null: voce in
 * cima, senza gruppo). L'ordine non conta: vince la voce più specifica.
 */
export const MENU_SECTIONS: readonly { groupKey: string | null; items: readonly { to: string; labelKey: string }[] }[] = [
  { groupKey: null,                   items: NAV_ITEM_DEFS },
  { groupKey: 'sidebar.itilProcesses', items: ITSM_ITEM_DEFS },
  { groupKey: 'sidebar.reporting',     items: REPORTING_ITEM_DEFS },
  { groupKey: 'sidebar.analysis',      items: ANALYSIS_ITEM_DEFS },
  { groupKey: 'sidebar.monitoring',    items: MONITORING_ITEM_DEFS },
  { groupKey: null,                   items: [PROFILE_ITEM] },
  { groupKey: 'sidebar.teamsUsers',    items: TEAMS_ITEM_DEFS },
  { groupKey: 'sidebar.configuration', items: CONFIG_ITEM_DEFS },
  { groupKey: 'sidebar.settings',      items: SETTINGS_ITEM_DEFS },
  { groupKey: null,                   items: ADMIN_NAV_ITEM_DEFS },
]

export interface MenuPosition {
  /** Chiave del gruppo del menu, o null per le voci senza gruppo. */
  groupKey: string | null
  /** La voce del menu che contiene la pagina. */
  item: { to: string; labelKey: string }
  /** I segmenti d'indirizzo sotto la voce (/incidents/123 → ['123']). */
  rest: string[]
}

/** Dove sta la pagina nel menu: la voce più specifica che la contiene, o null. */
export function posizioneNelMenu(pathname: string): MenuPosition | null {
  const tutte = MENU_SECTIONS.flatMap((sez) => sez.items.map((item) => ({ groupKey: sez.groupKey, item })))
  const to = voceAttiva(pathname, tutte.map((v) => v.item.to))
  if (to === null) return null
  const voce = tutte.find((v) => v.item.to === to)!
  return { ...voce, rest: pathname.slice(to.length).split('/').filter(Boolean) }
}
