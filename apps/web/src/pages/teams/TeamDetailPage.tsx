import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { Users, UsersRound, X, Search } from 'lucide-react'
import { DetailField } from '@/components/ui/DetailField'
import { SectionCard } from '@/components/ui/SectionCard'
import { EmptyState } from '@/components/EmptyState'
import { StatusBadge } from '@/components/StatusBadge'
import { EnvBadge } from '@/components/Badges'
import { GET_TEAM } from '@/graphql/queries'
import { SET_TEAM_MANAGER, REMOVE_TEAM_MANAGER } from '@/graphql/mutations'
import { ciPath } from '@/lib/ciPath'
import { toast } from 'sonner'

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

interface ManagerRef {
  id:    string
  name:  string
  email: string
}

interface Team {
  id:           string
  tenantId:     string
  name:         string
  description:  string | null
  type:         string | null
  createdAt:    string
  manager:      ManagerRef | null
  members:      Member[]
  ownedCIs:     CIRef[]
  supportedCIs: CIRef[]
}

function TypeBadge({ type }: { type: string | null }) {
  if (!type) return <span style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>—</span>
  const styles: Record<string, { bg: string; color: string }> = {
    owner:   { bg: '#eff6ff', color: '#2563eb' },
    support: { bg: '#f0fdf4', color: '#16a34a' },
  }
  const s = styles[type] ?? { bg: 'var(--color-slate-bg)', color: 'var(--color-slate)' }
  return (
    <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, padding: '2px 8px', borderRadius: 4, backgroundColor: s.bg, color: s.color, textTransform: 'capitalize' }}>
      {type}
    </span>
  )
}

// ── CI mini-table ─────────────────────────────────────────────────────────────

function CITable({ items, onRowClick, emptyMsg }: { items: CIRef[]; onRowClick: (ci: CIRef) => void; emptyMsg: string }) {
  if (items.length === 0) {
    return <EmptyState icon={<Users size={24} color="var(--color-slate-light)" />} title={emptyMsg} />
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
          {['Nome', 'Tipo', 'Environment', 'Status'].map((h) => (
            <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 600, color: 'var(--color-slate)', fontSize: 'var(--font-size-body)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((ci) => (
          <tr
            key={ci.id}
            onClick={() => onRowClick(ci)}
            style={{ cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f8f9fc' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
          >
            <td style={{ padding: '8px 8px', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{ci.name}</td>
            <td style={{ padding: '8px 8px', color: 'var(--color-slate)', textTransform: 'capitalize' }}>{ci.type.replace(/_/g, ' ')}</td>
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
  const [showManagerModal, setShowManagerModal] = useState(false)
  const [managerSearch, setManagerSearch] = useState('')
  const [pendingManagerUser, setPendingManagerUser] = useState<{ id: string; name: string } | null>(null)

  const { data, loading, refetch } = useQuery<{ team: Team | null }>(GET_TEAM, {
    variables:   { id },
    fetchPolicy: 'cache-and-network',
    skip:        !id,
  })
  const [setManager] = useMutation(SET_TEAM_MANAGER, {
    onCompleted: () => { toast.success('Manager aggiornato'); refetch(); setShowManagerModal(false) },
    onError: (err) => toast.error(err.message),
  })
  const [removeManager] = useMutation(REMOVE_TEAM_MANAGER, {
    onCompleted: () => { toast.success('Manager rimosso'); refetch() },
    onError: (err) => toast.error(err.message),
  })

  const team = data?.team
  const teamMembers = team?.members ?? []

  if (loading && !team) {
    return <div style={{ padding: '32px 40px', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>Caricamento...</div>
  }

  if (!team) {
    return <div style={{ padding: '32px 40px', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>Team non trovato.</div>
  }

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 4, cursor: 'pointer' }} onClick={() => navigate('/teams')}>
          ← Teams
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <UsersRound size={22} color="#38bdf8" />
          <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>{team.name}</h1>
        </div>
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 4 }}>
          Creato il {new Date(team.createdAt).toLocaleDateString('it-IT')}
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionCard title="Informazioni" defaultOpen>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <DetailField label="ID" value={team.id} mono />
            <DetailField label="Nome" value={team.name} />
            <DetailField label="Tenant ID" value={team.tenantId} mono />
            <DetailField label="Tipo" value={<TypeBadge type={team.type} />} />
            <DetailField label="Manager" value={
              team.manager ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ cursor: 'pointer', color: 'var(--color-brand)', fontWeight: 500 }} onClick={() => navigate(`/users/${team.manager!.id}`)}>{team.manager.name}</span>
                  <span style={{ color: 'var(--color-brand)', cursor: 'pointer', fontWeight: 500, fontSize: 'var(--font-size-table)' }} onClick={() => { setManagerSearch(''); setPendingManagerUser(null); setShowManagerModal(true) }}>Cambia</span>
                  <button
                    onClick={() => removeManager({ variables: { teamId: team.id } })}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', borderRadius: 4 }}
                    title="Rimuovi manager"
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#fef2f2' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}
                  >
                    <X size={12} color="#ef4444" />
                  </button>
                </div>
              ) : (
                <span style={{ color: 'var(--color-brand)', cursor: 'pointer', fontWeight: 500 }} onClick={() => { setManagerSearch(''); setPendingManagerUser(null); setShowManagerModal(true) }}>+ Assegna</span>
              )
            } />
            <DetailField label="Descrizione" value={team.description} />
            <DetailField label="Creato il" value={new Date(team.createdAt).toLocaleDateString('it-IT')} />
          </div>
        </SectionCard>

        {/* Manager selection modal */}
        {showManagerModal && (() => {
          const candidates = teamMembers.filter(u => u.id !== team.manager?.id)
          const filtered = managerSearch
            ? candidates.filter(u => u.name.toLowerCase().includes(managerSearch.toLowerCase()) || u.email.toLowerCase().includes(managerSearch.toLowerCase()))
            : candidates
          return (
            <div
              onClick={() => { setShowManagerModal(false); setPendingManagerUser(null) }}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
            >
              <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, width: 440, maxHeight: '70vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
                {/* Header */}
                <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
                    {team.manager ? 'Cambia manager' : 'Assegna manager'}
                  </span>
                  <button onClick={() => { setShowManagerModal(false); setPendingManagerUser(null) }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex' }}>
                    <X size={16} color="var(--color-slate-light)" />
                  </button>
                </div>

                {/* Confirmation banner */}
                {pendingManagerUser && (
                  <div style={{ padding: '12px 20px', background: '#fffbeb', borderBottom: '1px solid #fbbf24' }}>
                    <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginBottom: 10 }}>
                      Il manager attuale <strong>{team.manager?.name}</strong> verrà sostituito da <strong>{pendingManagerUser.name}</strong>. Confermi?
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => { setManager({ variables: { teamId: team.id, userId: pendingManagerUser.id } }); setPendingManagerUser(null) }}
                        style={{ padding: '6px 16px', borderRadius: 6, border: 'none', background: 'var(--color-brand)', color: '#fff', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}
                      >
                        Conferma
                      </button>
                      <button
                        onClick={() => setPendingManagerUser(null)}
                        style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: 'var(--color-slate)', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}
                      >
                        Annulla
                      </button>
                    </div>
                  </div>
                )}

                {/* Search */}
                {!pendingManagerUser && (
                  <div style={{ padding: '12px 20px', borderBottom: '1px solid #e5e7eb' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px' }}>
                      <Search size={14} color="var(--color-slate-light)" />
                      <input
                        autoFocus
                        value={managerSearch}
                        onChange={e => setManagerSearch(e.target.value)}
                        placeholder="Cerca membro..."
                        style={{ border: 'none', outline: 'none', flex: 1, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}
                      />
                    </div>
                  </div>
                )}

                {/* User list */}
                {!pendingManagerUser && (
                  <div style={{ overflowY: 'auto', flex: 1 }}>
                    {filtered.length === 0 ? (
                      <div style={{ padding: '20px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', textAlign: 'center' }}>Nessun membro trovato</div>
                    ) : filtered.map((u, i) => (
                      <div
                        key={u.id}
                        onClick={() => {
                          if (team.manager) {
                            setPendingManagerUser({ id: u.id, name: u.name })
                          } else {
                            setManager({ variables: { teamId: team.id, userId: u.id } })
                          }
                        }}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', cursor: 'pointer', borderBottom: i < filtered.length - 1 ? '1px solid #f3f4f6' : 'none' }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#f0f9ff' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                      >
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#e0f2fe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Users size={13} color="var(--color-brand)" />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{u.name}</div>
                          <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{u.email}</div>
                        </div>
                        <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', textTransform: 'capitalize' }}>{u.role}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })()}

        {/* Members */}
        <SectionCard title={`Membri (${team.members.length})`} defaultOpen>
          {team.members.length === 0 ? (
            <EmptyState icon={<Users size={24} color="var(--color-slate-light)" />} title="Nessun membro" />
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                  {['Nome', 'Email', 'Ruolo'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 600, color: 'var(--color-slate)', fontSize: 'var(--font-size-body)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {team.members.map((m) => (
                  <tr key={m.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '8px 8px', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{m.name}</td>
                    <td style={{ padding: '8px 8px', color: 'var(--color-slate)' }}>{m.email}</td>
                    <td style={{ padding: '8px 8px', color: 'var(--color-slate)', textTransform: 'capitalize' }}>{m.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>

        {/* Owned CIs */}
        <SectionCard title={`CI Owned (${team.ownedCIs.length})`} defaultOpen={false}>
          <CITable items={team.ownedCIs} onRowClick={(ci) => navigate(ciPath(ci))} emptyMsg="Nessun CI in ownership" />
        </SectionCard>

        {/* Supported CIs */}
        <SectionCard title={`CI Supported (${team.supportedCIs.length})`} defaultOpen={false}>
          <CITable items={team.supportedCIs} onRowClick={(ci) => navigate(ciPath(ci))} emptyMsg="Nessun CI in supporto" />
        </SectionCard>
      </div>
    </PageContainer>
  )
}
