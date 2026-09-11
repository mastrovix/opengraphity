/**
 * Mock GraphQL riusabili (MockedProvider). I risultati includono `__typename`
 * perché la cache Apollo 4 aggiunge sempre il campo alla query.
 */
import { GET_ME, GET_ANOMALY_STATS, GET_TEAMS, GET_USERS, GET_WORKFLOW_LIST, GET_ITIL_TYPES, GET_BASE_CI_TYPE } from '@/graphql/queries'
import type { GqlMock } from '@/test/utils'

export interface MeFixture {
  id: string; name: string; email: string; role: string; slackId: string | null
  teams: { id: string; name: string }[]
}

export function meFixture(role = 'admin', overrides: Partial<MeFixture> = {}): MeFixture {
  return { id: 'u-1', name: 'Test User', email: 'test@acme.com', role, slackId: null, teams: [], ...overrides }
}

/** `me` con il ruolo dato (o `null` per utente non presente nel DB). */
export function meMock(role: string | null = 'admin', opts: { maxUsageCount?: number } = {}): GqlMock {
  const me = role === null ? null : {
    __typename: 'User', ...meFixture(role),
    teams: meFixture(role).teams.map((t) => ({ __typename: 'Team', ...t })),
  }
  return { request: { query: GET_ME }, result: { data: { me } }, maxUsageCount: opts.maxUsageCount ?? 1 }
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

export interface UserRowFixture { id: string; name: string; email: string; role: string; createdAt: string | null }

export function usersMock(users: UserRowFixture[], variables: Record<string, unknown> = {}): GqlMock {
  return {
    request: { query: GET_USERS, variables },
    result: { data: { users: users.map((u) => ({ __typename: 'User', teams: [], ...u })) } },
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
