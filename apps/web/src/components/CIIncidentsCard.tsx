import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CountBadge } from '@/components/ui/CountBadge'
import { StatusBadge } from '@/components/StatusBadge'
import { GET_CI_INCIDENTS } from '@/graphql/queries'

interface Incident {
  id:        string
  number:    string
  title:     string
  severity:  string
  status:    string
  createdAt: string
  updatedAt: string
}

const SEVERITY_STYLE: Record<string, { bg: string; color: string }> = {
  critical: { bg: '#fef2f2', color: 'var(--color-trigger-sla-breach)' },
  high:     { bg: '#fef2f2', color: 'var(--color-brand)' },
  medium:   { bg: '#fffbeb', color: 'var(--color-warning)' },
  low:      { bg: '#ecfdf5', color: 'var(--color-success)' },
}

function SeverityBadge({ severity }: { severity: string }) {
  const s = SEVERITY_STYLE[severity] ?? { bg: '#f1f5f9', color: 'var(--color-slate)' }
  return (
    <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 'var(--font-size-label)', fontWeight: 600, textTransform: 'capitalize', backgroundColor: s.bg, color: s.color, flexShrink: 0, marginTop: 1 }}>
      {severity}
    </span>
  )
}

const CLOSED_STATUSES = new Set(['resolved', 'closed'])

export function CIIncidentsCard({ ciId }: { ciId: string }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const { data } = useQuery<{ ciIncidents: Incident[] }>(GET_CI_INCIDENTS, {
    variables: { ciId },
  })

  const incidents = data?.ciIncidents ?? []
  const open_incidents  = incidents.filter(i => !CLOSED_STATUSES.has(i.status))
  const closed_incidents = incidents.filter(i =>  CLOSED_STATUSES.has(i.status))

  function renderRow(inc: Incident, faded = false) {
    return (
      <div
        key={inc.id}
        onClick={() => navigate(`/incidents/${inc.id}`)}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '6px 0', borderBottom: '1px solid #f9fafb',
          cursor: 'pointer', opacity: faded ? 0.5 : 1,
        }}
      >
        <SeverityBadge severity={inc.severity} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {inc.number}
          </div>
          <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {inc.title}
          </div>
        </div>
        <StatusBadge value={inc.status} />
      </div>
    )
  }

  function renderGroup(label: string, items: Incident[], faded = false) {
    if (items.length === 0) return null
    return (
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '4px 0 6px 0' }}>
          {label}
        </div>
        <div style={{ paddingLeft: 12, borderLeft: '2px solid #f3f4f6', marginLeft: 4 }}>
          {items.map(i => renderRow(i, faded))}
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
          Incident <CountBadge count={incidents.length} />
        </span>
        {open ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
      </div>
      {open && (
        <div style={{ padding: '0 20px 16px' }}>
          {incidents.length === 0
            ? <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '12px 0 0' }}>Nessun incident su questo CI.</p>
            : (
              <>
                {renderGroup('In corso', open_incidents)}
                {renderGroup('Chiusi',   closed_incidents, true)}
              </>
            )
          }
        </div>
      )}
    </div>
  )
}
