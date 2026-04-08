import { useState } from 'react'
import { gql } from '@apollo/client'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'

// ── GraphQL ───────────────────────────────────────────────────────────────────

const SYNC_SOURCES = gql`
  query SyncSources {
    syncSources {
      id name connectorType enabled scheduleCron
      lastSyncAt lastSyncStatus lastSyncDurationMs
      createdAt
    }
    availableConnectors {
      type displayName supportedCITypes
      credentialFields { name label type required placeholder helpText }
      configFields     { name label type required helpText options { value label } defaultValue }
    }
  }
`

const SYNC_RUNS = gql`
  query SyncRuns($sourceId: ID!, $limit: Int) {
    syncRuns(sourceId: $sourceId, limit: $limit) {
      total
      items {
        id syncType status startedAt completedAt durationMs errorMessage
        ciCreated ciUpdated ciUnchanged ciStale ciConflicts
        relationsCreated relationsRemoved
      }
    }
  }
`

const SYNC_CONFLICTS = gql`
  query SyncConflicts($sourceId: ID, $status: String, $limit: Int) {
    syncConflicts(sourceId: $sourceId, status: $status, limit: $limit) {
      total
      items {
        id externalId ciType conflictFields status resolution
        existingCiId matchReason createdAt resolvedAt
      }
    }
  }
`

const SYNC_STATS = gql`
  query SyncStats {
    syncStats {
      totalSources enabledSources lastSyncAt
      ciManaged openConflicts totalRuns successRate
    }
  }
`

const CREATE_SYNC_SOURCE = gql`
  mutation CreateSyncSource($input: CreateSyncSourceInput!) {
    createSyncSource(input: $input) { id name connectorType enabled }
  }
`

const DELETE_SYNC_SOURCE = gql`
  mutation DeleteSyncSource($id: ID!) { deleteSyncSource(id: $id) }
`

const TRIGGER_SYNC = gql`
  mutation TriggerSync($sourceId: ID!) {
    triggerSync(sourceId: $sourceId) { id status startedAt }
  }
`

const RESOLVE_CONFLICT = gql`
  mutation ResolveConflict($conflictId: ID!, $resolution: String!) {
    resolveConflict(conflictId: $conflictId, resolution: $resolution) {
      id status resolution resolvedAt
    }
  }
`

const TEST_CONNECTION = gql`
  mutation TestSyncConnection($sourceId: ID!) {
    testSyncConnection(sourceId: $sourceId) { ok message details }
  }
`

const UPDATE_SYNC_SOURCE = gql`
  mutation UpdateSyncSource($id: ID!, $input: UpdateSyncSourceInput!) {
    updateSyncSource(id: $id, input: $input) { id scheduleCron enabled }
  }
`

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyncSource {
  id: string; name: string; connectorType: string; enabled: boolean
  scheduleCron: string | null; lastSyncAt: string | null
  lastSyncStatus: string | null; lastSyncDurationMs: number | null; createdAt: string
}

export interface SyncRun {
  id: string; syncType: string; status: string; startedAt: string
  completedAt: string | null; durationMs: number | null; errorMessage: string | null
  ciCreated: number; ciUpdated: number; ciUnchanged: number; ciStale: number
  ciConflicts: number; relationsCreated: number; relationsRemoved: number
}

export interface SyncConflict {
  id: string; externalId: string; ciType: string; conflictFields: string
  status: string; resolution: string | null; existingCiId: string
  matchReason: string; createdAt: string; resolvedAt: string | null
}

export interface ConnectorField {
  name: string; label: string; type: string; required: boolean
  placeholder: string | null; helpText: string | null
  options: { value: string; label: string }[] | null; defaultValue: string | null
}

export interface ConnectorInfo {
  type: string; displayName: string; supportedCITypes: string[]
  credentialFields: ConnectorField[]; configFields: ConnectorField[]
}

export interface SyncStats {
  totalSources: number; enabledSources: number; lastSyncAt: string | null
  ciManaged: number; openConflicts: number; totalRuns: number; successRate: number
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

export const TABS = ['Sources', 'History', 'Conflicts'] as const
export type Tab = typeof TABS[number]

// ── Hook return type ─────────────────────────────────────────────────────────

export interface UseSyncPageReturn {
  // Tab
  tab: Tab
  setTab: (t: Tab) => void

  // Stats
  stats: SyncStats | null

  // Sources tab
  sources: SyncSource[]
  connectors: ConnectorInfo[]
  sourcesLoading: boolean
  handleCreateSource: (input: {
    name: string; connectorType: string
    credentials: Record<string, string>; config: Record<string, string>
    scheduleCron?: string
  }) => Promise<void>
  handleDeleteSource: (id: string) => Promise<void>
  handleTriggerSync: (sourceId: string) => Promise<void>
  handleTestConnection: (sourceId: string) => Promise<void>
  handleSaveSchedule: (sourceId: string, cron: string | null) => Promise<void>

  // History tab
  historySourceId: string
  setHistorySourceId: (id: string) => void
  historyRuns: SyncRun[]
  historyLoading: boolean

  // Conflicts tab
  conflicts: SyncConflict[]
  conflictsLoading: boolean
  handleResolveConflict: (conflictId: string, resolution: string) => Promise<void>
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSyncPage(): UseSyncPageReturn {
  const { t } = useTranslation()

  // Tab state
  const [tab, setTab] = useState<Tab>('Sources')

  // Stats
  const { data: statsData } = useQuery(SYNC_STATS)
  const stats: SyncStats | null =
    (statsData as { syncStats?: SyncStats } | undefined)?.syncStats ?? null

  // ── Sources ──────────────────────────────────────────────────────────────────

  const { data: sourcesData, loading: sourcesLoading } = useQuery(SYNC_SOURCES)
  const d = sourcesData as { syncSources?: SyncSource[]; availableConnectors?: ConnectorInfo[] } | undefined
  const sources: SyncSource[] = d?.syncSources ?? []
  const connectors: ConnectorInfo[] = d?.availableConnectors ?? []

  const [createSourceMut] = useMutation(CREATE_SYNC_SOURCE, { refetchQueries: ['SyncSources', 'SyncStats'] })
  const [deleteSourceMut] = useMutation(DELETE_SYNC_SOURCE, { refetchQueries: ['SyncSources', 'SyncStats'] })
  const [triggerSyncMut]  = useMutation(TRIGGER_SYNC, { refetchQueries: ['SyncRuns'] })
  const [testConnMut]     = useMutation(TEST_CONNECTION)
  const [updateSourceMut] = useMutation(UPDATE_SYNC_SOURCE, { refetchQueries: ['SyncSources'] })

  async function handleCreateSource(input: {
    name: string; connectorType: string
    credentials: Record<string, string>; config: Record<string, string>
    scheduleCron?: string
  }) {
    try {
      await createSourceMut({
        variables: {
          input: {
            name: input.name,
            connectorType: input.connectorType,
            credentials: JSON.stringify(input.credentials),
            config: JSON.stringify(input.config),
            enabled: true,
          },
        },
      })
      toast.success(t('pages.sync.sourceCreated'))
    } catch (err) {
      toast.error((err as Error).message)
      throw err
    }
  }

  async function handleDeleteSource(id: string) {
    if (!confirm('Delete this sync source?')) return
    try {
      await deleteSourceMut({ variables: { id } })
      toast.success('Source deleted')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleTriggerSync(sourceId: string) {
    try {
      await triggerSyncMut({ variables: { sourceId } })
      toast.success(t('pages.sync.syncTriggered'))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleTestConnection(sourceId: string) {
    try {
      const { data: r } = await testConnMut({ variables: { sourceId } })
      const result = (r as { testSyncConnection?: { ok: boolean; message: string } } | undefined)?.testSyncConnection
      if (result?.ok) toast.success(result.message)
      else            toast.error(result?.message ?? 'Connection failed')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleSaveSchedule(sourceId: string, cron: string | null) {
    try {
      await updateSourceMut({ variables: { id: sourceId, input: { scheduleCron: cron } } })
      toast.success('Schedule saved')
    } catch (err) {
      toast.error((err as Error).message)
      throw err
    }
  }

  // ── History ──────────────────────────────────────────────────────────────────

  const [historySourceId, setHistorySourceId] = useState('')
  const { data: runsData, loading: historyLoading } = useQuery(SYNC_RUNS, {
    variables: { sourceId: historySourceId, limit: 50 },
    skip: !historySourceId,
  })
  type HistoryData = { syncRuns?: { total: number; items: SyncRun[] } }
  const historyRuns: SyncRun[] = (runsData as HistoryData | undefined)?.syncRuns?.items ?? []

  // ── Conflicts ────────────────────────────────────────────────────────────────

  const { data: conflictsData, loading: conflictsLoading } = useQuery(SYNC_CONFLICTS, { variables: { limit: 50 } })
  const conflicts: SyncConflict[] =
    (conflictsData as { syncConflicts?: { total: number; items: SyncConflict[] } } | undefined)?.syncConflicts?.items ?? []

  const [resolveConflictMut] = useMutation(RESOLVE_CONFLICT, { refetchQueries: ['SyncConflicts', 'SyncStats'] })

  async function handleResolveConflict(conflictId: string, resolution: string) {
    try {
      await resolveConflictMut({ variables: { conflictId, resolution } })
      toast.success('Conflict resolved')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return {
    tab, setTab,
    stats,
    sources, connectors, sourcesLoading,
    handleCreateSource, handleDeleteSource, handleTriggerSync, handleTestConnection, handleSaveSchedule,
    historySourceId, setHistorySourceId, historyRuns, historyLoading,
    conflicts, conflictsLoading, handleResolveConflict,
  }
}
