import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CountBadge } from '@/components/ui/CountBadge'
import { StatusBadge } from '@/components/StatusBadge'
import { GET_CI_INCIDENTS } from '@/graphql/queries'

interface Incident {
  id:        string
  title:     string
  severity:  string
  status:    string
  createdAt: string
  updatedAt: string
}

const SEVERITY_DOT: Record<string, string> = {
  critical: '#dc2626',
  high:     '#f97316',
  medium:   '#eab308',
  low:      '#22c55e',
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
          display:       'flex',
          alignItems:    'center',
          gap:           10,
          padding:       '6px 0',
          borderBottom:  '1px solid #f9fafb',
          cursor:        'pointer',
          opacity:       faded ? 0.5 : 1,
        }}
      >
        <span style={{
          width:        8,
          height:       8,
          borderRadius: '50%',
          flexShrink:   0,
          backgroundColor: SEVERITY_DOT[inc.severity] ?? '#94a3b8',
          display:      'inline-block',
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#0f1629', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
        <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '4px 0 6px 0' }}>
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
        <span style={{ fontSize: 14, fontWeight: 600, color: '#111827', display: 'flex', alignItems: 'center' }}>
          Incident <CountBadge count={incidents.length} />
        </span>
        {open ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
      </div>
      {open && (
        <div style={{ padding: '0 20px 16px' }}>
          {incidents.length === 0
            ? <p style={{ fontSize: 13, color: '#8892a4', margin: '12px 0 0' }}>Nessun incident su questo CI.</p>
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
