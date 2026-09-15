import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CountBadge } from '@/components/ui/CountBadge'
import { SeverityBadge } from '@/components/ui/badges'
import { TicketStatusBadge } from '@/components/StatusBadge'
import { GET_CI_INCIDENTS, GET_CI_PROBLEMS, GET_CI_SERVICE_REQUESTS } from '@/graphql/queries'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { colors, palette } from '@/lib/tokens'

interface Incident {
  id:        string
  number:    string
  title:     string
  /** La priorità: `severity` sull'incident, `priority` sul problem. */
  severity:  string | null
  status:    string
  createdAt: string
  updatedAt: string
}

/**
 * I ticket di un CI, per tipo. Revisione del 14 set 2026 · F12: il dettaglio
 * del CI mostrava incident e change, ma non i problem; lo stesso componente
 * ora serve anche le richieste (le change hanno il loro, con fase e rischio).
 */
const KINDS = {
  incident: { query: GET_CI_INCIDENTS, field: 'ciIncidents', path: '/incidents', title: 'Incident', emptyKey: 'components.ciIncidents.empty' },
  problem:  { query: GET_CI_PROBLEMS,  field: 'ciProblems',  path: '/problems',  title: 'Problem',  emptyKey: 'components.ciProblems.empty' },
  // Revisione del 15 set 2026 · CM-8: anche le richieste si collegano ai CI.
  service_request: { query: GET_CI_SERVICE_REQUESTS, field: 'ciServiceRequests', path: '/requests', title: 'Service Request', emptyKey: 'components.ciServiceRequests.empty' },
} as const

export function CIIncidentsCard({ ciId, kind = 'incident' }: { ciId: string; kind?: keyof typeof KINDS }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const spec = KINDS[kind]

  const { data } = useQuery<Record<string, Array<Incident & { priority?: string | null }>>>(spec.query, {
    variables: { ciId },
  })
  const { isTerminal } = useWorkflowSteps(kind)

  const incidents: Incident[] = (data?.[spec.field] ?? []).map((r) => ({ ...r, severity: r.severity ?? r.priority ?? null }))
  const open_incidents  = incidents.filter(i => !isTerminal(i.status))
  const closed_incidents = incidents.filter(i =>  isTerminal(i.status))

  function renderRow(inc: Incident, faded = false) {
    return (
      <button
        type="button"
        key={inc.id}
        onClick={() => navigate(`${spec.path}/${inc.id}`)}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%',
          background: 'none', border: 'none', borderRadius: 0, font: 'inherit', color: 'inherit', textAlign: 'left',
          padding: '6px 0', borderBottom: `1px solid ${palette.neutral.borderLight}`,
          cursor: 'pointer', opacity: faded ? 0.5 : 1,
        }}
      >
        {inc.severity && <span style={{ flexShrink: 0, marginTop: 1 }}><SeverityBadge value={inc.severity} /></span>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {inc.number}
          </div>
          <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {inc.title}
          </div>
          <div style={{ marginTop: 2 }}><TicketStatusBadge value={inc.status} entityType={kind} /></div>
        </div>
      </button>
    )
  }

  function renderGroup(label: string, items: Incident[], faded = false) {
    if (items.length === 0) return null
    return (
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '4px 0 6px 0' }}>
          {label}
        </div>
        <div style={{ paddingLeft: 12, borderLeft: `2px solid ${palette.neutral.borderLight}`, marginLeft: 4 }}>
          {items.map(i => renderRow(i, faded))}
        </div>
      </div>
    )
  }

  return (
    <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(p => !p)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', padding: '14px 20px', borderBottom: open ? `1px solid ${colors.border}` : 'none' }}
      >
        <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', display: 'flex', alignItems: 'center' }}>
          {spec.title} <CountBadge count={incidents.length} />
        </span>
        {open ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
      </button>
      {open && (
        <div style={{ padding: '0 20px 16px' }}>
          {incidents.length === 0
            ? <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '12px 0 0' }}>{t(spec.emptyKey)}</p>
            : (
              <>
                {renderGroup(t('components.ciGroups.inProgress'), open_incidents)}
                {renderGroup(t('components.ciGroups.closed'), closed_incidents, true)}
              </>
            )
          }
        </div>
      )}
    </div>
  )
}
