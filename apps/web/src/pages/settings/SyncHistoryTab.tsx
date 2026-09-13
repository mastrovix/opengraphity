import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SyncSource, SyncRun } from './useSyncPage'
import { formatMs, StatusBadge, inputStyle } from './syncShared'
import { Select } from '@/components/ui/FormControls'
import { colors, palette } from '@/lib/tokens'
import { formatDateTime } from '@/lib/datetime'

// ── Props ────────────────────────────────────────────────────────────────────

export interface SyncHistoryTabProps {
  sources: SyncSource[]
  runs: SyncRun[]
  loading: boolean
  selectedSourceId: string
  onSelectSource: (id: string) => void
}

// ── Component ────────────────────────────────────────────────────────────────

export function SyncHistoryTab({
  sources, runs, loading, selectedSourceId, onSelectSource,
}: SyncHistoryTabProps) {
  const { t } = useTranslation()
  // Local UI state to keep select in sync (allows parent to drive the query)
  const [selected, setSelected] = useState(selectedSourceId)

  function handleChange(id: string) {
    setSelected(id)
    onSelectSource(id)
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Select style={{ ...inputStyle, width: 240 }} value={selected} onChange={e => handleChange(e.target.value)}>
          <option value="">{t('pages.sync.selectSource')}</option>
          {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </div>

      {!selected && (
        <div style={{ padding: 32, textAlign: 'center', color: colors.slate, fontSize: 'var(--font-size-body)' }}>
          {t('pages.sync.pickSourceHint')}
        </div>
      )}

      {selected && loading && <div style={{ padding: 24, color: colors.slate }}>{t('common.loading')}</div>}

      {selected && !loading && (
        <div style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {runs.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: colors.slate, fontSize: 'var(--font-size-body)' }}>{t('pages.sync.noRuns')}</div>
          )}
          {runs.map((r, i) => (
            <div key={r.id} style={{ padding: '12px 16px', borderBottom: i < runs.length - 1 ? `1px solid ${palette.neutral.borderLight}` : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <StatusBadge status={r.status} />
                  <span style={{ fontSize: 'var(--font-size-body)', color: colors.slate }}>{r.syncType}</span>
                  <span style={{ fontSize: 'var(--font-size-body)', color: palette.neutral.textMuted }}>{formatDateTime(r.startedAt)}</span>
                  {r.durationMs != null && <span style={{ fontSize: 'var(--font-size-body)', color: colors.slate }}>({formatMs(r.durationMs)})</span>}
                </div>
                <div style={{ fontSize: 'var(--font-size-body)', color: colors.slate, display: 'flex', gap: 12 }}>
                  <span style={{ color: 'var(--color-success)' }}>+{r.ciCreated}</span>
                  <span style={{ color: colors.brand }}>~{r.ciUpdated}</span>
                  <span>={r.ciUnchanged}</span>
                  {r.ciStale > 0    && <span style={{ color: palette.warning.text }}>stale:{r.ciStale}</span>}
                  {r.ciConflicts > 0 && <span style={{ color: 'var(--color-trigger-sla-breach)' }}>conflict:{r.ciConflicts}</span>}
                </div>
              </div>
              {r.errorMessage && (
                <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)', marginTop: 4, padding: '4px 8px', background: 'var(--color-danger-bg)', borderRadius: 4 }}>
                  {r.errorMessage}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
