import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CountBadge } from '@/components/ui/CountBadge'
import { StatusBadge } from '@/components/StatusBadge'
import { GET_CI_CHANGES } from '@/graphql/queries'

interface Change {
  id:             string
  title:          string
  type:           string
  priority:       string
  status:         string
  createdAt:      string
  scheduledStart: string | null
}

const TYPE_COLOR: Record<string, { bg: string; color: string }> = {
  standard:  { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  normal:    { bg: '#f0fdf4', color: '#16a34a' },
  emergency: { bg: '#fef2f2', color: 'var(--color-trigger-sla-breach)' },
}

function TypeBadge({ type }: { type: string }) {
  const style = TYPE_COLOR[type] ?? { bg: 'var(--color-slate-bg)', color: 'var(--color-slate)' }
  return (
    <span style={{
      padding:         '2px 7px',
      borderRadius:    100,
      fontSize:        11,
      fontWeight:      600,
      backgroundColor: style.bg,
      color:           style.color,
      flexShrink:      0,
      textTransform:   'capitalize' as const,
    }}>
      {type}
    </span>
  )
}

const CLOSED_STATUSES = new Set(['completed', 'failed', 'rejected'])

export function CIChangesCard({ ciId }: { ciId: string }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const { data } = useQuery<{ ciChanges: Change[] }>(GET_CI_CHANGES, {
    variables: { ciId },
  })

  const changes = data?.ciChanges ?? []
  const active  = changes.filter(c => !CLOSED_STATUSES.has(c.status))
  const closed  = changes.filter(c =>  CLOSED_STATUSES.has(c.status))

  function renderRow(ch: Change, faded = false) {
    return (
      <div
        key={ch.id}
        onClick={() => navigate(`/changes/${ch.id}`)}
        style={{
          display:      'flex',
          alignItems:   'center',
          gap:          8,
          padding:      '6px 0',
          borderBottom: '1px solid #f9fafb',
          cursor:       'pointer',
          opacity:      faded ? 0.5 : 1,
        }}
      >
        <TypeBadge type={ch.type} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 400, color: 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {ch.title}
          </div>
        </div>
        <StatusBadge value={ch.status} />
      </div>
    )
  }

  function renderGroup(label: string, items: Change[], faded = false) {
    if (items.length === 0) return null
    return (
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '4px 0 6px 0' }}>
          {label}
        </div>
        <div style={{ paddingLeft: 12, borderLeft: '2px solid #f3f4f6', marginLeft: 4 }}>
          {items.map(c => renderRow(c, faded))}
        </div>
      </div>
    )
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
      <div
        onClick={() => setOpen(p => !p)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: open ? '1px solid #e5e7eb' : 'none' }}
      >
        <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', display: 'flex', alignItems: 'center' }}>
          Change <CountBadge count={changes.length} />
        </span>
        {open ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
      </div>
      {open && (
        <div style={{ padding: '0 20px 16px' }}>
          {changes.length === 0
            ? <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '12px 0 0' }}>Nessun change su questo CI.</p>
            : (
              <>
                {renderGroup('In corso',    active)}
                {renderGroup('Completati',  closed, true)}
              </>
            )
          }
        </div>
      )}
    </div>
  )
}
