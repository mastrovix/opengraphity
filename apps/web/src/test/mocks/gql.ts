/**
 * Mock GraphQL riusabili (MockedProvider). I risultati includono `__typename`
 * perché la cache Apollo 4 aggiunge sempre il campo alla query.
 */
import { GET_ME, GET_ROLES, GET_ANOMALY_STATS, GET_TEAMS, GET_TEAM_CHOICES, GET_USERS, SEARCH_USERS, GET_WORKFLOW_LIST, GET_WORKFLOW_DEFINITION, GET_ITIL_TYPES, GET_BASE_CI_TYPE, GET_DOMAIN_MATRICES } from '@/graphql/queries'
import type { GqlMock } from '@/test/utils'
import { FACTORY_ROLE_PERMISSIONS, isUserRole } from '@opengraphity/types'

export interface MeFixture {
  id: string; name: string; email: string; role: string; roleName: string | null; permissions: string[]; slackId: string | null
  emailNotifications: boolean | null
  language: string | null
  teams: { id: string; name: string }[]
}

export function meFixture(role = 'admin', overrides: Partial<MeFixture> = {}): MeFixture {
  // I permessi del ruolo di fabbrica con quel nome (ondata 7); un ruolo che non esiste non ne ha.
  const permissions = isUserRole(role) ? [...FACTORY_ROLE_PERMISSIONS[role]] : []
  return { id: 'u-1', name: 'Test User', email: 'test@acme.com', role, roleName: null, permissions, slackId: null, emailNotifications: true, language: null, teams: [], ...overrides }
}

/** `me` con il ruolo dato (o `null` per utente non presente nel DB). */
export function meMock(role: string | null = 'admin', opts: { maxUsageCount?: number } = {}): GqlMock {
  const me = role === null ? null : {
    __typename: 'User', ...meFixture(role),
    teams: meFixture(role).teams.map((t) => ({ __typename: 'Team', ...t })),
  }
  return { request: { query: GET_ME }, result: { data: { me } }, maxUsageCount: opts.maxUsageCount ?? 1 }
}

/** I ruoli dell'organizzazione (ondata 7): i quattro di fabbrica, più quelli dati. */
export function rolesMock(extra: Array<{ key: string; name: string; permissions?: string[]; userCount?: number }> = []): GqlMock {
  const factory = (['admin', 'operator', 'viewer', 'end_user'] as const).map((key) => ({
    __typename: 'Role', key, name: null, permissions: [...FACTORY_ROLE_PERMISSIONS[key]], isFactory: true, userCount: 1,
  }))
  const custom = extra.map((r) => ({ __typename: 'Role', key: r.key, name: r.name, permissions: r.permissions ?? [], isFactory: false, userCount: r.userCount ?? 0 }))
  return { request: { query: GET_ROLES }, result: { data: { roles: [...factory, ...custom] } }, maxUsageCount: Number.POSITIVE_INFINITY }
}

export function meErrorMock(message = 'boom'): GqlMock {
  return { request: { query: GET_ME }, error: new Error(message) }
}

export function anomalyStatsMock(critical = 0): GqlMock {
  return {
    request: { query: GET_ANOMALY_STATS },
    result: { data: { anomalyStats: { __typename: 'AnomalyStats', total: critical, open: critical, critical, high: 0, medium: 0, low: 0, falsePositive: 0, acceptedRisk: 0 } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

export function anomalyStatsErrorMock(message = 'anomalies down'): GqlMock {
  return { request: { query: GET_ANOMALY_STATS }, error: new Error(message), maxUsageCount: Number.POSITIVE_INFINITY }
}

export function teamsMock(teams: { id: string; name: string }[] = []): GqlMock {
  return {
    request: { query: GET_TEAMS, variables: {} },
    result: { data: { teams: teams.map((t) => ({ __typename: 'Team', description: null, type: null, createdAt: null, ...t })) } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

/** The teams a picker offers (TeamPicker): type and Change Manager flag included. */
export function teamChoicesMock(teams: Array<{ id: string; name: string; type?: string | null; isChangeManager?: boolean | null }> = []): GqlMock {
  return {
    request: { query: GET_TEAM_CHOICES },
    result: { data: { teams: teams.map((t) => ({ __typename: 'Team', type: null, isChangeManager: false, ...t })) } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

/**
 * The people a picker finds (UserPicker, WatcherBar, MentionInput): the
 * server's answer to `searchUsers`, whatever the search — the server already
 * kept only the people whose role grants the permission asked.
 */
export function userSearchMock(users: Array<{ id: string; name: string; email?: string }> = []): GqlMock {
  return {
    request: { query: SEARCH_USERS, variables: () => true },
    result: { data: { searchUsers: users.map((u) => ({ __typename: 'UserSuggestion', email: `${u.id}@acme.com`, ...u })) } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

export interface UserRowFixture { id: string; name: string; email: string; role: string; createdAt: string | null; active?: boolean }

export function usersMock(users: UserRowFixture[], variables: Record<string, unknown> = {}): GqlMock {
  return {
    request: { query: GET_USERS, variables },
    result: { data: { users: users.map((u) => ({ __typename: 'User', teams: [], roleName: null, active: true, ...u })) } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

/**
 * Definizione di workflow di un tipo di entità (`useWorkflowSteps`): serve a
 * ogni riquadro che mostra lo stato o il passo di un ticket con l'etichetta
 * dell'app invece del nome grezzo del passo.
 */
export interface WorkflowStepMock {
  name: string
  label: string
  /**
   * Metadata del passo. Sono questi a dire «risolto», «chiuso», «approvazione»
   * — mai il nome (ondata 8 · B-22): un test che vuole provare una rinomina
   * passa i propri nomi e la categoria/lo scopo giusti. Se omessi, si ricade
   * sulla convenzione posizionale storica (primo = iniziale, ultimo = terminale).
   */
  category?: string | null
  purpose?:  string | null
  isInitial?:  boolean
  isTerminal?: boolean
  isOpen?:     boolean
}

export function workflowDefinitionMock(
  entityType = 'incident',
  steps: WorkflowStepMock[] = [
    { name: 'new', label: 'New' },
    { name: 'in_progress', label: 'In lavorazione' },
    { name: 'resolved', label: 'Resolved' },
  ],
): GqlMock {
  return {
    request: { query: GET_WORKFLOW_DEFINITION, variables: { entityType } },
    result: {
      data: {
        workflowDefinition: {
          __typename: 'WorkflowDefinition', id: `wd-${entityType}`, name: entityType, entityType,
          category: null, version: 1, active: true,
          steps: steps.map((s, i) => ({
            __typename: 'WorkflowStep', id: `st-${i}`, name: s.name, label: s.label, type: 'state',
            enterActions: [], exitActions: [],
            isInitial:  s.isInitial  ?? i === 0,
            isTerminal: s.isTerminal ?? i === steps.length - 1,
            isOpen:     s.isOpen     ?? i < steps.length - 1,
            category:   s.category   ?? null,
            purpose:    s.purpose    ?? null,
            order: i,
          })),
          transitions: [],
        },
      },
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

export function workflowListMock(): GqlMock {
  return {
    request: { query: GET_WORKFLOW_LIST },
    result: { data: { workflowDefinitions: [] } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

/**
 * Tipo CI base del metamodello (`useCIBaseEnums`): gli enum `status` (ciclo di
 * vita) ed `environment`. Serve a ogni pagina che legge il vocabolario del
 * ciclo di vita — fra cui la Policy eventi (stati da ignorare, D6.3).
 */
export function baseCITypeMock(
  statuses: string[] = ['active', 'inactive', 'maintenance', 'decommissioned'],
  environments: string[] = ['production', 'staging', 'development'],
): GqlMock {
  const field = (id: string, name: string, enumValues: string[], order: number) => ({
    __typename: 'CIField', id, name, label: name, fieldType: 'enum', required: false, enumValues, order,
    isSystem: true, validationScript: null, visibilityScript: null, defaultScript: null,
  })
  return {
    request: { query: GET_BASE_CI_TYPE },
    result: { data: { baseCIType: {
      __typename: 'CIType', id: 'base', name: '__base__', label: 'Base', icon: 'box', color: '#000', active: true, validationScript: null,
      fields: [field('f1', 'status', statuses, 1), field('f2', 'environment', environments, 2)],
      relations: [], systemRelations: [],
    } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

/** Il metamodello non risponde: l'hook restituisce liste vuote e un errore che le pagine devono mostrare. */
export function baseCITypeErrorMock(message = 'metamodel down'): GqlMock {
  return { request: { query: GET_BASE_CI_TYPE }, error: new Error(message), maxUsageCount: Number.POSITIVE_INFINITY }
}

/** Metamodello ITIL minimo: incident con severity (enum), title (string), created_at (date). */
export function itilTypesMock(): GqlMock {
  const field = (name: string, fieldType: string, enumValues: string[] | null = null, order = 0) => ({
    __typename: 'ITILField', id: `f-${name}`, name, label: name, fieldType, required: false, enumValues, order,
    isSystem: true, enumTypeId: null, enumTypeName: null, validationScript: null, visibilityScript: null, defaultScript: null,
  })
  return {
    request: { query: GET_ITIL_TYPES },
    result: { data: { itilTypes: [
      {
        __typename: 'ITILType', id: 't-incident', name: 'incident', label: 'Incident', icon: 'alert', color: '#f00', active: true, validationScript: null,
        fields: [
          field('title', 'string', null, 1),
          field('severity', 'enum', ['low', 'medium', 'high', 'critical'], 2),
          field('priority', 'enum', ['low', 'medium', 'high', 'critical'], 3),
          field('created_at', 'date', null, 4),
          field('reopen_count', 'number', null, 5),
        ],
      },
    ] } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

/**
 * Le matrici di dominio (revisione delle otto ondate · C·N-3). Impatto,
 * urgenza e priorità dei form vengono da qui: il web ne teneva una copia, e chi
 * rinominava i vocabolari vedeva i valori vecchi e ogni invio rifiutato dal
 * server.
 *
 * `values` permette di simulare il cliente che ha rinominato: è il caso che
 * conta, e senza questo mock non si può scrivere.
 */
export function domainMatricesMock(opts: {
  impacts?:    string[]
  urgencies?:  string[]
  priorities?: string[]
  /** Celle `impatto|urgenza → priorità`; se assente, una matrice piena plausibile. */
  cells?:      Record<string, string>
} = {}): GqlMock {
  const impacts    = opts.impacts    ?? ['low', 'medium', 'high']
  const urgencies  = opts.urgencies  ?? ['low', 'medium', 'high']
  const priorities = opts.priorities ?? ['low', 'medium', 'high', 'critical']
  const cells = opts.cells ?? Object.fromEntries(
    impacts.flatMap((i, ii) => urgencies.map((u, ui) => {
      // Più in alto la coppia, più alta la priorità: serve una matrice
      // plausibile, non quella del prodotto (che è dato del cliente).
      const rank = Math.min(priorities.length - 1, Math.round(((ii + ui) / (impacts.length + urgencies.length - 2)) * (priorities.length - 1)))
      return [`${i}|${u}`, priorities[rank]!]
    })),
  )
  return {
    request: { query: GET_DOMAIN_MATRICES },
    result: { data: { domainMatrices: [{
      __typename: 'DomainMatrix',
      kind: 'priority', inputs: ['impact', 'urgency'], output: 'priority',
      inputValues: [impacts, urgencies], outputValues: priorities,
      cells: Object.entries(cells).map(([key, value]) => ({
        __typename: 'DomainMatrixCell', key, inputs: key.split('|'), value,
      })),
      missing: [], stale: [], invalid: [], isDefault: false, updatedAt: null,
    }] } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}
