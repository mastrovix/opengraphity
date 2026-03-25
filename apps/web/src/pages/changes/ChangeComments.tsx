import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CountBadge } from '@/components/ui/CountBadge'
import type { ChangeComment } from './change-types'

interface Props {
  changeId: string
  comments: ChangeComment[]
  addingComment: boolean
  onAddComment: (text: string) => void
}

export function ChangeComments({ changeId: _changeId, comments, addingComment, onAddComment }: Props) {
  const [open, setOpen] = useState(true)
  const [newComment, setNewComment] = useState('')

  const typeColors: Record<string, { bg: string; color: string }> = {
    manual:       { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
    ci_removed:   { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
    task_skipped: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
    step_skipped: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
    rejected:     { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
    transition:   { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  }
  const typeLabels: Record<string, string> = {
    manual: 'Commento', ci_removed: 'CI Rimosso',
    task_skipped: 'Task Saltato', step_skipped: 'Step Saltato',
    rejected: 'Rigettato', transition: 'Transizione',
  }

  const cardStyle: React.CSSProperties = {
    backgroundColor: '#fff', border: '1px solid #e2e6f0', borderRadius: 10, padding: 0, marginBottom: 16,
  }

  return (
    <div style={cardStyle}>
      <div
        onClick={() => setOpen((p) => !p)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: open ? '1px solid #e5e7eb' : 'none' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Commenti</span>
          <CountBadge count={comments.length} />
        </div>
        {open ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
      </div>
      {open && (
        <div style={{ padding: '16px 20px 20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: comments.length > 0 ? 14 : 0 }}>
            {comments.map((cm) => {
              const tc = typeColors[cm.type] ?? { bg: '#f3f4f6', color: 'var(--color-slate)' }
              return (
                <div key={cm.id} style={{ padding: '10px 12px', backgroundColor: '#f8f9fc', borderRadius: 8, borderLeft: `3px solid ${tc.color}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ ...tc, padding: '2px 8px', borderRadius: 100, fontSize: 12, fontWeight: 600 }}>
                      {typeLabels[cm.type] ?? cm.type}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>
                      {cm.createdBy?.name ?? '—'} · {new Date(cm.createdAt).toLocaleString('it-IT')}
                    </span>
                  </div>
                  <p style={{ margin: 0, fontSize: 14, color: 'var(--color-slate-dark)', lineHeight: 1.5 }}>{cm.text}</p>
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="Aggiungi un commento…"
              rows={2}
              style={{ flex: 1, padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 14, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", resize: 'none', outline: 'none', boxSizing: 'border-box' }}
            />
            <button
              disabled={newComment.trim().length < 3 || addingComment}
              onClick={() => { onAddComment(newComment.trim()); setNewComment('') }}
              style={{
                padding: '8px 14px', borderRadius: 6, border: 'none', fontSize: 14, fontWeight: 600,
                cursor: newComment.trim().length >= 3 && !addingComment ? 'pointer' : 'not-allowed',
                backgroundColor: newComment.trim().length >= 3 && !addingComment ? 'var(--color-brand)' : '#e2e6f0',
                color: newComment.trim().length >= 3 && !addingComment ? '#fff' : 'var(--color-slate-light)',
                alignSelf: 'flex-end',
              }}
            >
              Invia
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
