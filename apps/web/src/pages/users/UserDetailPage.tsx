import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { PageContainer } from '@/components/PageContainer'
import { ChevronDown, ChevronRight } from 'lucide-react'
// EmptyState no longer used — inline message instead
import { DetailCard } from '@/components/ui/DetailCard'
import { DetailField } from '@/components/ui/DetailField'
import { Users, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { GET_USER, GET_TEAMS } from '@/graphql/queries'

const UPDATE_USER_TEAMS = gql`
  mutation UpdateUserTeams($userId: ID!, $teamIds: [ID!]!) {
    updateUserTeams(userId: $userId, teamIds: $teamIds) { id name email role }
  }
`

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
  admin:    { bg: '#fef2f2', color: 'var(--color-trigger-sla-breach)' },
  operator: { bg: '#eff6ff', color: '#2563eb' },
  viewer:   { bg: 'var(--color-slate-bg)', color: 'var(--color-slate)' },
}

function RoleBadge({ role }: { role: string }) {
  const s = ROLE_STYLES[role] ?? { bg: 'var(--color-slate-bg)', color: 'var(--color-slate)' }
  return (
    <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, padding: '2px 8px', borderRadius: 4, backgroundColor: s.bg, color: s.color, textTransform: 'capitalize' }}>
      {role}
    </span>
  )
}

// Team type styles removed — teams now shown as removable chips

// TeamTypeBadge removed — teams now shown as removable chips

// ── Card components ───────────────────────────────────────────────────────────

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, ...style }}>
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
        <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{title}</span>
        {open ? <ChevronDown size={14} color="var(--color-slate-light)" /> : <ChevronRight size={14} color="var(--color-slate-light)" />}
      </div>
      {open && children}
    </Card>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function UserDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [showAddTeam, setShowAddTeam] = useState(false)

  const { data, loading, refetch } = useQuery<{ user: User | null }>(GET_USER, {
    variables:   { id },
    fetchPolicy: 'cache-and-network',
    skip:        !id,
  })
  const { data: allTeamsData } = useQuery<{ teams: { id: string; name: string; description: string | null; type: string | null }[] }>(GET_TEAMS)

  const [updateTeams] = useMutation(UPDATE_USER_TEAMS, {
    onCompleted: () => { toast.success('Team aggiornati'); refetch() },
    onError: (err) => toast.error(err.message),
  })

  const user = data?.user
  const allTeams = allTeamsData?.teams ?? []
  const userTeamIds = user?.teams.map(t => t.id) ?? []
  const availableTeams = allTeams.filter(t => !userTeamIds.includes(t.id))

  if (loading && !user) {
    return <div style={{ padding: '32px 40px', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>Caricamento...</div>
  }

  if (!user) {
    return <div style={{ padding: '32px 40px', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>Utente non trovato.</div>
  }

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 4, cursor: 'pointer' }} onClick={() => navigate('/users')}>
          ← Users
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>{user.name}</h1>
          <RoleBadge role={user.role} />
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, alignItems: 'start' }}>
        {/* Left column */}
        <div>
          <CollapsibleCard title={`Team (${user.teams.length})`} defaultOpen>
            {/* Current teams */}
            {user.teams.length === 0 ? (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 12px' }}>Nessun team assegnato</p>
            ) : (
              <div style={{ marginBottom: 12 }}>
                {user.teams.map((t, i) => (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: i < user.teams.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: '#e0f2fe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Users size={14} color="var(--color-brand)" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)', cursor: 'pointer' }} onClick={() => navigate(`/teams/${t.id}`)}>{t.name}</span>
                        {t.type && (
                          <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                            background: t.type === 'support' ? '#f0fdf4' : t.type === 'owner' ? '#eff6ff' : '#f8fafc',
                            color: t.type === 'support' ? '#16a34a' : t.type === 'owner' ? '#2563eb' : 'var(--color-slate)',
                          }}>{t.type}</span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => updateTeams({ variables: { userId: user.id, teamIds: userTeamIds.filter(tid => tid !== t.id) } })}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', borderRadius: 4 }}
                      title="Rimuovi dal team"
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#fef2f2' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}
                    >
                      <X size={14} color="#ef4444" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add team */}
            {!showAddTeam ? (
              <button
                onClick={() => setShowAddTeam(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: 0 }}
              >
                <Plus size={14} /> Aggiungi a un team
              </button>
            ) : (
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, marginTop: 8 }}>
                <div style={{ padding: '6px 12px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Team disponibili</span>
                  <button onClick={() => setShowAddTeam(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>Chiudi</button>
                </div>
                {availableTeams.length === 0 ? (
                  <div style={{ padding: '12px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', textAlign: 'center' }}>Nessun altro team disponibile</div>
                ) : availableTeams.map((t, i) => (
                  <div
                    key={t.id}
                    onClick={() => { updateTeams({ variables: { userId: user.id, teamIds: [...userTeamIds, t.id] } }); setShowAddTeam(false) }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer', borderBottom: i < availableTeams.length - 1 ? '1px solid #f3f4f6' : 'none' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#f0f9ff' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                  >
                    <Plus size={14} color="var(--color-brand)" />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{t.name}</span>
                        {t.type && (
                          <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                            background: t.type === 'support' ? '#f0fdf4' : t.type === 'owner' ? '#eff6ff' : '#f8fafc',
                            color: t.type === 'support' ? '#16a34a' : t.type === 'owner' ? '#2563eb' : 'var(--color-slate)',
                          }}>{t.type}</span>
                        )}
                      </div>
                      {t.description && (
                        <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 1 }}>{t.description}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CollapsibleCard>
        </div>

        {/* Right column */}
        <div>
          <DetailCard title="Dettagli">
            <DetailField label="ID" value={user.id} mono />
            <DetailField label="Email" value={user.email} />
            <DetailField label="Ruolo" value={<RoleBadge role={user.role} />} />
            <DetailField label="Creato il" value={user.createdAt ? new Date(user.createdAt).toLocaleString('it-IT') : null} />
          </DetailCard>
        </div>
      </div>
    </PageContainer>
  )
}
