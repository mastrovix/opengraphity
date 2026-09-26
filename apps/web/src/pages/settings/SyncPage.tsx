import { useTranslation } from 'react-i18next'
import { Activity } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { Tabs } from '@/components/ui/Tabs'
import { useSyncPage, TABS } from './useSyncPage'
import { StatsBar } from './syncShared'
import { SyncSourcesTab } from './SyncSourcesTab'
import { SyncHistoryTab } from './SyncHistoryTab'
import { SyncConflictsTab } from './SyncConflictsTab'
import { ImportTab } from './ImportTab'

export function SyncPage() {
  const { t } = useTranslation()
  const hook = useSyncPage()

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Activity size={22} color="var(--color-icon-accent)" />}>
          {t('sync.title')}
        </PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', margin: '4px 0 0' }}>
          {t('sync.subtitle')}
        </p>
      </div>

      {hook.stats && <StatsBar stats={hook.stats} />}

      <Tabs
        ariaLabel={t('sync.title')}
        items={TABS.map((tab) => ({ key: tab, label: t(`pages.sync.tab.${tab}`) }))}
        value={hook.tab}
        onChange={hook.setTab}
      />

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
          total={hook.conflictsTotal}
          status={hook.conflictStatus}
          onStatusChange={hook.setConflictStatus}
        />
      )}

      {hook.tab === 'Import' && <ImportTab />}
    </PageContainer>
  )
}
