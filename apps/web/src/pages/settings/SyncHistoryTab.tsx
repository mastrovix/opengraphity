import { useState } from 'react'
import type { SyncSource, SyncRun } from './useSyncPage'
import { formatMs, formatDate, StatusBadge, inputStyle } from './syncShared'

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
  // Local UI state to keep select in sync (allows parent to drive the query)
  const [selected, setSelected] = useState(selectedSourceId)

  function handleChange(id: string) {
    setSelected(id)
    onSelectSource(id)
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <select style={{ ...inputStyle, width: 240 }} value={selected} onChange={e => handleChange(e.target.value)}>
          <option value="">Select source...</option>
          {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {!selected && (
        <div style={{ padding: 32, textAlign: 'center', color: '#6b7280', fontSize: 'var(--font-size-body)' }}>
          Select a sync source to view run history
        </div>
      )}

      {selected && loading && <div style={{ padding: 24, color: '#6b7280' }}>Loading...</div>}

      {selected && !loading && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
          {runs.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: '#6b7280', fontSize: 'var(--font-size-body)' }}>No runs yet</div>
          )}
          {runs.map((r, i) => (
            <div key={r.id} style={{ padding: '12px 16px', borderBottom: i < runs.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <StatusBadge status={r.status} />
                  <span style={{ fontSize: 'var(--font-size-body)', color: '#6b7280' }}>{r.syncType}</span>
                  <span style={{ fontSize: 'var(--font-size-body)', color: '#374151' }}>{formatDate(r.startedAt)}</span>
                  {r.durationMs != null && <span style={{ fontSize: 'var(--font-size-body)', color: '#6b7280' }}>({formatMs(r.durationMs)})</span>}
                </div>
                <div style={{ fontSize: 'var(--font-size-body)', color: '#6b7280', display: 'flex', gap: 12 }}>
                  <span style={{ color: '#16a34a' }}>+{r.ciCreated}</span>
                  <span style={{ color: '#2563eb' }}>~{r.ciUpdated}</span>
                  <span>={r.ciUnchanged}</span>
                  {r.ciStale > 0    && <span style={{ color: '#ca8a04' }}>stale:{r.ciStale}</span>}
                  {r.ciConflicts > 0 && <span style={{ color: '#dc2626' }}>conflict:{r.ciConflicts}</span>}
                </div>
              </div>
              {r.errorMessage && (
                <div style={{ fontSize: 'var(--font-size-body)', color: '#dc2626', marginTop: 4, padding: '4px 8px', background: '#fef2f2', borderRadius: 4 }}>
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
