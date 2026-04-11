import { Activity } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { useSyncPage, TABS } from './useSyncPage'
import { StatsBar } from './syncShared'
import { SyncSourcesTab } from './SyncSourcesTab'
import { SyncHistoryTab } from './SyncHistoryTab'
import { SyncConflictsTab } from './SyncConflictsTab'

export function SyncPage() {
  const hook = useSyncPage()

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Activity size={22} color="var(--color-brand)" />}>
          CMDB Sync
        </PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', margin: '4px 0 0' }}>
          Import and sync configuration items from external sources
        </p>
      </div>

      {hook.stats && <StatsBar stats={hook.stats} />}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: '#f1f5f9', padding: 4, borderRadius: 8, width: 'fit-content' }}>
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => hook.setTab(t)}
            style={{
              padding: '8px 20px', borderRadius: 6, border: 'none', cursor: 'pointer',
              fontSize: 'var(--font-size-body)', fontWeight: 500,
              background: hook.tab === t ? '#38bdf8' : 'transparent',
              color: hook.tab === t ? '#fff' : 'var(--color-slate)',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {hook.tab === 'Sources' && (
        <SyncSourcesTab
          sources={hook.sources}
          connectors={hook.connectors}
          loading={hook.sourcesLoading}
          onCreateSource={hook.handleCreateSource}
          onDeleteSource={hook.handleDeleteSource}
          onTriggerSync={hook.handleTriggerSync}
          onTestConnection={hook.handleTestConnection}
          onSaveSchedule={hook.handleSaveSchedule}
        />
      )}

      {hook.tab === 'History' && (
        <SyncHistoryTab
          sources={hook.sources}
          runs={hook.historyRuns}
          loading={hook.historyLoading}
          selectedSourceId={hook.historySourceId}
          onSelectSource={hook.setHistorySourceId}
        />
      )}

      {hook.tab === 'Conflicts' && (
        <SyncConflictsTab
          conflicts={hook.conflicts}
          loading={hook.conflictsLoading}
          onResolveConflict={hook.handleResolveConflict}
        />
      )}
    </PageContainer>
  )
}
