import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { ChevronDown, ChevronRight, Users } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { StatusBadge } from '@/components/StatusBadge'
import { EnvBadge } from '@/components/Badges'
import { GET_TEAM } from '@/graphql/queries'

interface Member {
  id:    string
  name:  string
  email: string
  role:  string
}

interface CIRef {
  id:          string
  name:        string
  type:        string
  environment: string
  status:      string
}

interface Team {
  id:           string
  name:         string
  description:  string | null
  type:         string | null
  createdAt:    string
  members:      Member[]
  ownedCIs:     CIRef[]
  supportedCIs: CIRef[]
}

function TypeBadge({ type }: { type: string | null }) {
  if (!type) return <span style={{ color: '#8892a4', fontSize: 13 }}>—</span>
  const styles: Record<string, { bg: string; color: string }> = {
    owner:   { bg: '#eff6ff', color: '#2563eb' },
    support: { bg: '#f0fdf4', color: '#16a34a' },
  }
  const s = styles[type] ?? { bg: '#f1f5f9', color: '#64748b' }
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, backgroundColor: s.bg, color: s.color, textTransform: 'capitalize' }}>
      {type}
    </span>
  )
}

// ── Shared card ───────────────────────────────────────────────────────────────

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background:   '#fff',
      border:       '1px solid #e5e7eb',
      borderRadius: 8,
      padding:      20,
      ...style,
    }}>
      {children}
    </div>
  )
}

// ── Collapsible card ─────────────────────────────────────────────────────────

function CollapsibleCard({
  title,
  defaultOpen = true,
  children,
}: {
  title:        string
  defaultOpen?: boolean
  children:     React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Card>
      <div
        onClick={() => setOpen((p) => !p)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', marginBottom: open ? 16 : 0 }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: '#0f1629' }}>{title}</span>
        {open ? <ChevronDown size={14} color="#8892a4" /> : <ChevronRight size={14} color="#8892a4" />}
      </div>
      {open && children}
    </Card>
  )
}

// ── CI mini-table ─────────────────────────────────────────────────────────────

function CITable({ items, onRowClick, emptyMsg }: { items: CIRef[]; onRowClick: (id: string) => void; emptyMsg: string }) {
  if (items.length === 0) {
    return <EmptyState icon={<Users size={24} color="#8892a4" />} title={emptyMsg} />
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
          {['Nome', 'Tipo', 'Environment', 'Status'].map((h) => (
            <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((ci) => (
          <tr
            key={ci.id}
            onClick={() => onRowClick(ci.id)}
            style={{ cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f8f9fc' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
          >
            <td style={{ padding: '8px 8px', fontWeight: 500, color: '#0f1629' }}>{ci.name}</td>
            <td style={{ padding: '8px 8px', color: '#4a5468', textTransform: 'capitalize' }}>{ci.type.replace(/_/g, ' ')}</td>
            <td style={{ padding: '8px 8px' }}><EnvBadge environment={ci.environment} /></td>
            <td style={{ padding: '8px 8px' }}><StatusBadge value={ci.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function TeamDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data, loading } = useQuery<{ team: Team | null }>(GET_TEAM, {
    variables:   { id },
    fetchPolicy: 'cache-and-network',
    skip:        !id,
  })

  const team = data?.team

  if (loading && !team) {
    return <div style={{ padding: '32px 40px', color: '#8892a4', fontSize: 14 }}>Caricamento...</div>
  }

  if (!team) {
    return <div style={{ padding: '32px 40px', color: '#8892a4', fontSize: 14 }}>Team non trovato.</div>
  }

  return (
    <div style={{ padding: '32px 40px', maxWidth: 1200 }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, color: '#8892a4', marginBottom: 4, cursor: 'pointer' }} onClick={() => navigate('/teams')}>
          ← Teams
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', margin: 0 }}>{team.name}</h1>
        <div style={{ fontSize: 12, color: '#8892a4', marginTop: 4 }}>
          Creato il {new Date(team.createdAt).toLocaleDateString('it-IT')}
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* Left column */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Description */}
          <Card>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#0f1629', marginBottom: 8 }}>Descrizione</div>
            <div style={{ fontSize: 13, color: team.description ? '#374151' : '#8892a4' }}>
              {team.description ?? 'Nessuna descrizione'}
            </div>
          </Card>

          {/* Members */}
          <CollapsibleCard title={`Membri (${team.members.length})`} defaultOpen>
            {team.members.length === 0 ? (
              <EmptyState icon={<Users size={24} color="#8892a4" />} title="Nessun membro" />
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                    {['Nome', 'Email', 'Ruolo'].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {team.members.map((m) => (
                    <tr key={m.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '8px 8px', fontWeight: 500, color: '#0f1629' }}>{m.name}</td>
                      <td style={{ padding: '8px 8px', color: '#4a5468' }}>{m.email}</td>
                      <td style={{ padding: '8px 8px', color: '#4a5468', textTransform: 'capitalize' }}>{m.role}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CollapsibleCard>

          {/* Owned CIs */}
          <CollapsibleCard title={`CI Owned (${team.ownedCIs.length})`} defaultOpen={false}>
            <CITable items={team.ownedCIs} onRowClick={(ciId) => navigate(`/cmdb/${ciId}`)} emptyMsg="Nessun CI in ownership" />
          </CollapsibleCard>

          {/* Supported CIs */}
          <CollapsibleCard title={`CI Supported (${team.supportedCIs.length})`} defaultOpen={false}>
            <CITable items={team.supportedCIs} onRowClick={(ciId) => navigate(`/cmdb/${ciId}`)} emptyMsg="Nessun CI in supporto" />
          </CollapsibleCard>
        </div>

        {/* Right column */}
        <div style={{ width: 340, flexShrink: 0 }}>
          <Card>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#0f1629', marginBottom: 16 }}>Dettagli</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>ID</div>
                <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#4a5468', wordBreak: 'break-all' }}>{team.id}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Tipo</div>
                <TypeBadge type={team.type} />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Creato il</div>
                <div style={{ fontSize: 13, color: '#374151' }}>{new Date(team.createdAt).toLocaleString('it-IT')}</div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
