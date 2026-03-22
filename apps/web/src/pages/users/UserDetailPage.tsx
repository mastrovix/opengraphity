import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { Users } from 'lucide-react'
import { GET_USER } from '@/graphql/queries'

interface TeamRef {
  id:   string
  name: string
  type: string | null
}

interface User {
  id:        string
  name:      string
  email:     string
  role:      string
  createdAt: string | null
  teams:     TeamRef[]
}

// ── Badges ────────────────────────────────────────────────────────────────────

const ROLE_STYLES: Record<string, { bg: string; color: string }> = {
  admin:    { bg: '#fef2f2', color: '#dc2626' },
  operator: { bg: '#eff6ff', color: '#2563eb' },
  viewer:   { bg: '#f1f5f9', color: '#64748b' },
}

function RoleBadge({ role }: { role: string }) {
  const s = ROLE_STYLES[role] ?? { bg: '#f1f5f9', color: '#64748b' }
  return (
    <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 4, backgroundColor: s.bg, color: s.color, textTransform: 'capitalize' }}>
      {role}
    </span>
  )
}

const TEAM_TYPE_STYLES: Record<string, { bg: string; color: string }> = {
  owner:   { bg: '#eff6ff', color: '#2563eb' },
  support: { bg: '#f0fdf4', color: '#16a34a' },
}

function TeamTypeBadge({ type }: { type: string | null }) {
  if (!type) return <span style={{ color: '#94a3b8', fontSize: 12 }}>—</span>
  const s = TEAM_TYPE_STYLES[type] ?? { bg: '#f1f5f9', color: '#64748b' }
  return (
    <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 4, backgroundColor: s.bg, color: s.color, textTransform: 'capitalize' }}>
      {type}
    </span>
  )
}

// ── Card components ───────────────────────────────────────────────────────────

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, ...style }}>
      {children}
    </div>
  )
}

function CollapsibleCard({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Card>
      <div
        onClick={() => setOpen((p) => !p)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', marginBottom: open ? 16 : 0 }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{title}</span>
        {open ? <ChevronDown size={14} color="#94a3b8" /> : <ChevronRight size={14} color="#94a3b8" />}
      </div>
      {open && children}
    </Card>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function UserDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data, loading } = useQuery<{ user: User | null }>(GET_USER, {
    variables:   { id },
    fetchPolicy: 'cache-and-network',
    skip:        !id,
  })

  const user = data?.user

  if (loading && !user) {
    return <div style={{ padding: '32px 40px', color: '#94a3b8', fontSize: 14 }}>Caricamento...</div>
  }

  if (!user) {
    return <div style={{ padding: '32px 40px', color: '#94a3b8', fontSize: 14 }}>Utente non trovato.</div>
  }

  return (
    <div style={{ padding: '32px 40px', maxWidth: 1200 }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4, cursor: 'pointer' }} onClick={() => navigate('/users')}>
          ← Users
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: '#0f172a', margin: 0 }}>{user.name}</h1>
          <RoleBadge role={user.role} />
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* Left column */}
        <div style={{ flex: 1 }}>
          <CollapsibleCard title={`Team (${user.teams.length})`} defaultOpen>
            {user.teams.length === 0 ? (
              <EmptyState icon={<Users size={24} color="#94a3b8" />} title="Nessun team assegnato" />
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                    {['Nome', 'Tipo'].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 600, color: '#64748b', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {user.teams.map((t) => (
                    <tr
                      key={t.id}
                      onClick={() => navigate(`/teams/${t.id}`)}
                      style={{ cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f8f9fc' }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
                    >
                      <td style={{ padding: '8px 8px', fontWeight: 500, color: '#0f172a' }}>{t.name}</td>
                      <td style={{ padding: '8px 8px' }}><TeamTypeBadge type={t.type} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CollapsibleCard>
        </div>

        {/* Right column */}
        <div style={{ width: 340, flexShrink: 0 }}>
          <Card>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', marginBottom: 16 }}>Dettagli</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>ID</div>
                <div style={{ fontSize: 12, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", color: '#64748b', wordBreak: 'break-all' }}>{user.id}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Email</div>
                <div style={{ fontSize: 14, color: '#64748b' }}>{user.email}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Ruolo</div>
                <RoleBadge role={user.role} />
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Creato il</div>
                <div style={{ fontSize: 14, color: '#64748b' }}>
                  {user.createdAt ? new Date(user.createdAt).toLocaleString('it-IT') : '—'}
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
