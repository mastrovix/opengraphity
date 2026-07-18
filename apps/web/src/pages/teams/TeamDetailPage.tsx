import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { QueryError } from '@/components/QueryError'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { Users, UsersRound, X, Search } from 'lucide-react'
import { DetailField } from '@/components/ui/DetailField'
import { SectionCard } from '@/components/ui/SectionCard'
import { Pill } from '@/components/ui/Pill'
import { SimpleTable, type SimpleColumn } from '@/components/ui/SimpleTable'
import { EmptyState } from '@/components/EmptyState'
import { StatusBadge } from '@/components/StatusBadge'
import { EnvBadge } from '@/components/Badges'
import { GET_TEAM } from '@/graphql/queries'
import { SET_TEAM_MANAGER, REMOVE_TEAM_MANAGER } from '@/graphql/mutations'
import { ciPath } from '@/lib/ciPath'
import { toast } from 'sonner'
import { lookupStyle } from '@/lib/tokens'
import { AttachmentsSection } from '@/components/AttachmentsSection'

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
    owner:   { bg: 'var(--color-info-bg)', color: '#2563eb' },
    support: { bg: 'var(--color-success-bg)', color: 'var(--color-success)' },
  }
  const s = lookupStyle(styles, type, 'TEAM_TYPE_STYLES')
  return (
    <Pill bg={s.bg} color={s.color} radius={4} style={{ fontSize: 'var(--font-size-body)', textTransform: 'capitalize' }}>
      {type}
    </Pill>
  )
}

// ── CI mini-table ─────────────────────────────────────────────────────────────

function CITable({ items, onRowClick, emptyMsg }: { items: CIRef[]; onRowClick: (ci: CIRef) => void; emptyMsg: string }) {
  const { t } = useTranslation()
  const columns: SimpleColumn<CIRef>[] = [
    { key: 'name',        label: t('pages.cmdb.name'),        render: (v) => <span style={{ fontWeight: 500 }}>{String(v)}</span> },
    { key: 'type',        label: t('pages.teams.type'),       render: (v) => <span style={{ color: 'var(--color-slate)', textTransform: 'capitalize' }}>{String(v).replace(/_/g, ' ')}</span> },
    { key: 'environment', label: t('pages.cmdb.environment'), render: (v) => <EnvBadge environment={String(v)} /> },
    { key: 'status',      label: t('pages.cmdb.status'),      render: (v) => <StatusBadge value={String(v)} /> },
  ]
  return (
    <SimpleTable<CIRef>
      columns={columns}
      rows={items}
      onRowClick={onRowClick}
      empty={<EmptyState icon={<Users size={24} color="var(--color-slate-light)" />} title={emptyMsg} />}
    />
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function TeamDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [showManagerModal, setShowManagerModal] = useState(false)
  const [managerSearch, setManagerSearch] = useState('')
  const [pendingManagerUser, setPendingManagerUser] = useState<{ id: string; name: string } | null>(null)

  const { data, loading, error, refetch } = useQuery<{ team: Team | null }>(GET_TEAM, {
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
    return <div style={{ padding: '32px 40px', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>{t('common.loading')}</div>
  }

  if (error && !data) {
    return (
      <div style={{ padding: '32px 40px' }}>
        <QueryError message={error.message} onRetry={() => void refetch()} />
      </div>
    )
  }

  if (!team) {
    return <div style={{ padding: '32px 40px', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>{t('pages.teams.notFound')}</div>
  }

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 4, cursor: 'pointer' }} onClick={() => navigate('/teams')}>
          ← {t('pages.teams.title')}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <UsersRound size={22} color="var(--color-icon-accent)" />
          <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>{team.name}</h1>
        </div>
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 4 }}>
          {t('detail.createdAt')} {new Date(team.createdAt).toLocaleDateString('it-IT')}
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionCard title={t('detail.sections.information')} defaultOpen>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <DetailField label="ID" value={team.id} mono />
            <DetailField label={t('pages.teams.name')} value={team.name} />
            <DetailField label="Tenant ID" value={team.tenantId} mono />
            <DetailField label={t('pages.teams.type')} value={<TypeBadge type={team.type} />} />
            <DetailField label="Manager" value={
              team.manager ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ cursor: 'pointer', color: 'var(--color-brand)', fontWeight: 500 }} onClick={() => navigate(`/users/${team.manager!.id}`)}>{team.manager.name}</span>
                  <span style={{ color: 'var(--color-brand)', cursor: 'pointer', fontWeight: 500, fontSize: 'var(--font-size-table)' }} onClick={() => { setManagerSearch(''); setPendingManagerUser(null); setShowManagerModal(true) }}>Cambia</span>
                  <button
                    onClick={() => removeManager({ variables: { teamId: team.id } })}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', borderRadius: 4 }}
                    title="Rimuovi manager"
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-danger-bg)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}
                  >
                    <X size={12} color="#ef4444" />
                  </button>
                </div>
              ) : (
                <span style={{ color: 'var(--color-brand)', cursor: 'pointer', fontWeight: 500 }} onClick={() => { setManagerSearch(''); setPendingManagerUser(null); setShowManagerModal(true) }}>+ Assegna</span>
              )
            } />
            <DetailField label={t('pages.teams.description')} value={team.description} />
            <DetailField label={t('detail.createdAt')} value={new Date(team.createdAt).toLocaleDateString('it-IT')} />
          </div>
        </SectionCard>

        {/* Manager selection modal */}
        {showManagerModal && (() => {
          const candidates = teamMembers.filter(u => u.id !== team.manager?.id)
          const filtered = managerSearch
            ? candidates.filter(u => u.name.toLowerCase().includes(managerSearch.toLowerCase()) || u.email.toLowerCase().includes(managerSearch.toLowerCase()))
            : candidates
          return (
            <Modal
              open
              onClose={() => { setShowManagerModal(false); setPendingManagerUser(null) }}
              title={team.manager ? 'Cambia manager' : 'Assegna manager'}
              width={440}
            >
              {/* Cancel the Modal body padding so sections run edge-to-edge */}
              <div style={{ margin: -24 }}>
                {/* Confirmation banner */}
                {pendingManagerUser && (
                  <div style={{ padding: '12px 20px', background: 'var(--color-warning-bg)', borderBottom: '1px solid #fbbf24' }}>
                    <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginBottom: 10 }}>
                      Il manager attuale <strong>{team.manager?.name}</strong> verrà sostituito da <strong>{pendingManagerUser.name}</strong>. Confermi?
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button
                        onClick={() => { setManager({ variables: { teamId: team.id, userId: pendingManagerUser.id } }); setPendingManagerUser(null) }}
                        style={{ padding: '6px 16px', fontWeight: 600, fontSize: 'var(--font-size-body)' }}
                      >
                        Conferma
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => setPendingManagerUser(null)}
                        style={{ padding: '6px 16px', fontWeight: 600 }}
                      >
                        Annulla
                      </Button>
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
                  <div style={{ overflowY: 'auto', maxHeight: 'calc(70vh - 160px)' }}>
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
                        className="hover-bg"
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', cursor: 'pointer', borderBottom: i < filtered.length - 1 ? '1px solid #f3f4f6' : 'none', ['--hover-bg' as string]: '#f0f9ff' }}
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
            </Modal>
          )
        })()}

        {/* Members */}
        <SectionCard title={`${t('pages.teams.members')} (${team.members.length})`} defaultOpen>
          {team.members.length === 0 ? (
            <EmptyState icon={<Users size={24} color="var(--color-slate-light)" />} title={t('pages.teams.noMembers')} />
          ) : (
            <SimpleTable<Member>
              columns={[
                { key: 'name',  label: t('pages.users.name'),  render: (v) => <span style={{ fontWeight: 500 }}>{String(v)}</span> },
                { key: 'email', label: t('pages.users.email'), render: (v) => <span style={{ color: 'var(--color-slate)' }}>{String(v)}</span> },
                { key: 'role',  label: t('pages.users.role'),  render: (v) => <span style={{ color: 'var(--color-slate)', textTransform: 'capitalize' }}>{String(v)}</span> },
              ]}
              rows={team.members}
            />
          )}
        </SectionCard>

        {/* Owned CIs */}
        <SectionCard title={`CI Owned (${team.ownedCIs.length})`} defaultOpen={false}>
          <CITable items={team.ownedCIs} onRowClick={(ci) => navigate(ciPath(ci))} emptyMsg={t('pages.teams.noOwnedCIs')} />
        </SectionCard>

        {/* Supported CIs */}
        <SectionCard title={`CI Supported (${team.supportedCIs.length})`} defaultOpen={false}>
          <CITable items={team.supportedCIs} onRowClick={(ci) => navigate(ciPath(ci))} emptyMsg={t('pages.teams.noSupportedCIs')} />
        </SectionCard>

        {/* Allegati */}
        <AttachmentsSection entityType="team" entityId={team.id} />
      </div>
    </PageContainer>
  )
}
