import { useState } from 'react'
import type { SyncConflict } from './useSyncPage'
import { formatDate, StatusBadge, btnStyle } from './syncShared'

// ── Props ────────────────────────────────────────────────────────────────────

export interface SyncConflictsTabProps {
  conflicts: SyncConflict[]
  loading: boolean
  onResolveConflict: (conflictId: string, resolution: string) => Promise<void>
}

// ── Component ────────────────────────────────────────────────────────────────

export function SyncConflictsTab({ conflicts, loading, onResolveConflict }: SyncConflictsTabProps) {
  const [filter, setFilter] = useState('open')

  const filtered = filter === 'all' ? conflicts : conflicts.filter(c => c.status === filter)

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['open', 'resolved', 'all'].map(s => (
          <button key={s} onClick={() => setFilter(s)}
            style={{ padding: '6px 12px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 'var(--font-size-body)', cursor: 'pointer', background: filter === s ? '#2563eb' : '#fff', color: filter === s ? '#fff' : '#374151' }}>
            {s}
          </button>
        ))}
      </div>

      {loading && <div style={{ padding: 24, color: '#6b7280' }}>Loading...</div>}

      {!loading && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
          {filtered.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: '#6b7280', fontSize: 'var(--font-size-body)' }}>
              {filter === 'open' ? 'No open conflicts' : 'No conflicts found'}
            </div>
          )}
          {filtered.map((c, i) => {
            const fields: string[] = JSON.parse(c.conflictFields || '[]')
            return (
              <div key={c.id} style={{ padding: '12px 16px', borderBottom: i < filtered.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', color: '#111827' }}>{c.externalId}</span>
                      <span style={{ fontSize: 'var(--font-size-table)', background: '#f3f4f6', padding: '2px 6px', borderRadius: 4 }}>{c.ciType}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <div style={{ fontSize: 'var(--font-size-body)', color: '#6b7280', marginTop: 2 }}>
                      Locked fields: {fields.join(', ') || '—'} · {formatDate(c.createdAt)}
                    </div>
                    {c.resolution && (
                      <div style={{ fontSize: 'var(--font-size-body)', color: '#16a34a', marginTop: 2 }}>Resolution: {c.resolution}</div>
                    )}
                  </div>
                  {c.status === 'open' && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => onResolveConflict(c.id, 'merged')}   style={btnStyle('#2563eb', '#fff')} title="Aggiorna il CI esistente con i dati importati">Unisci</button>
                      <button onClick={() => onResolveConflict(c.id, 'distinct')} style={btnStyle('#fff', '#374151')} title="Crea un nuovo CI separato dai dati importati">Sono diversi</button>
                      <button onClick={() => onResolveConflict(c.id, 'linked')}   style={btnStyle('#fff', '#7c3aed')} title="Crea un nuovo CI e collega entrambi con RELATED_TO">Collega</button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
