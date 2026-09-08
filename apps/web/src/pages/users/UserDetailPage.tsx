import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { PageContainer } from '@/components/PageContainer'
import { QueryError } from '@/components/QueryError'
import { DetailField } from '@/components/ui/DetailField'
import { SectionCard } from '@/components/ui/SectionCard'
import { Users, User, Plus, X } from 'lucide-react'
import { Pill } from '@/components/ui/Pill'
import { RoleBadge } from '@/components/ui/badges'
import { useMutationWithToast } from '@/hooks/useMutationWithToast'
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

interface UserData {
  id:        string
  tenantId:  string
  name:      string
  code:      string
  firstName: string | null
  lastName:  string | null
  email:     string
  role:      string
  slackId:   string | null
  createdAt: string | null
  teams:     TeamRef[]
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function UserDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation()
  const [showAddTeam, setShowAddTeam] = useState(false)

  const { data, loading, error, refetch } = useQuery<{ user: UserData | null }>(GET_USER, {
    variables:   { id },
    fetchPolicy: 'cache-and-network',
    skip:        !id,
  })
  const { data: allTeamsData } = useQuery<{ teams: { id: string; name: string; description: string | null; type: string | null }[] }>(GET_TEAMS)

  const [updateTeams] = useMutationWithToast(UPDATE_USER_TEAMS, { successMessage: 'Team aggiornati', refetch })

  const user = data?.user
  const allTeams = allTeamsData?.teams ?? []
  const userTeamIds = user?.teams.map(team => team.id) ?? []
  const availableTeams = allTeams.filter(team => !userTeamIds.includes(team.id))

  if (loading && !user) {
    return <div style={{ padding: '32px 40px', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>Caricamento...</div>
  }

  if (error && !data) {
    return (
      <div style={{ padding: '32px 40px' }}>
        <QueryError message={error.message} onRetry={() => void refetch()} />
      </div>
    )
  }

  if (!user) {
    return <div style={{ padding: '32px 40px', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>Utente non trovato.</div>
  }

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <Link to="/users" style={{ display: 'inline-block', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 4, textDecoration: 'none' }}>
          ← {t('pages.users.backToList')}
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <User size={22} color="var(--color-icon-accent)" />
          <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>{user.name}</h1>
          <RoleBadge role={user.role} />
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionCard title="Informazioni" defaultOpen>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <DetailField label="ID" value={user.id} mono />
            <DetailField label="Code" value={user.code} />
            <DetailField label="Nome" value={user.firstName} />
            <DetailField label="Cognome" value={user.lastName} />
            <DetailField label="Email" value={user.email} />
            <DetailField label="Ruolo" value={<RoleBadge role={user.role} />} />
            <DetailField label="Tenant ID" value={user.tenantId} mono />
            <DetailField label="Slack ID" value={user.slackId} mono />
            <DetailField label="Creato il" value={user.createdAt ? new Date(user.createdAt).toLocaleDateString('it-IT') : null} />
          </div>
        </SectionCard>

        <SectionCard title={`Team (${user.teams.length})`} defaultOpen>
            {/* Current teams */}
            {user.teams.length === 0 ? (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 12px' }}>Nessun team assegnato</p>
            ) : (
              <div style={{ marginBottom: 12 }}>
                {user.teams.map((team, i) => (
                  <div key={team.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: i < user.teams.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: '#e0f2fe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Users size={14} color="var(--color-brand)" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Link to={`/teams/${team.id}`} style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)', textDecoration: 'none' }}>{team.name}</Link>
                        {team.type && (
                          <Pill
                            bg={team.type === 'support' ? 'var(--color-success-bg)' : team.type === 'owner' ? 'var(--color-info-bg)' : 'var(--color-slate-bg)'}
                            color={team.type === 'support' ? 'var(--color-success)' : team.type === 'owner' ? '#2563eb' : 'var(--color-slate)'}
                            radius={4}
                            style={{ fontSize: 'var(--font-size-label)', padding: '1px 6px' }}
                          >{team.type}</Pill>
                        )}
                      </div>
                    </div>
                    <button type="button"
                      onClick={() => void updateTeams({ variables: { userId: user.id, teamIds: userTeamIds.filter(tid => tid !== team.id) } })}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', borderRadius: 4 }}
                      title="Rimuovi dal team"
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-danger-bg)' }}
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
              <button type="button"
                onClick={() => setShowAddTeam(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: 0 }}
              >
                <Plus size={14} /> Aggiungi a un team
              </button>
            ) : (
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 8 }}>
                <div style={{ padding: '6px 12px', background: 'var(--color-slate-bg)', borderBottom: '1px solid var(--border)', fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Team disponibili</span>
                  <button type="button" onClick={() => setShowAddTeam(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>Chiudi</button>
                </div>
                {availableTeams.length === 0 ? (
                  <div style={{ padding: '12px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', textAlign: 'center' }}>Nessun altro team disponibile</div>
                ) : availableTeams.map((team, i) => (
                  <button
                    type="button"
                    key={team.id}
                    onClick={() => { void updateTeams({ variables: { userId: user.id, teamIds: [...userTeamIds, team.id] } }); setShowAddTeam(false) }}
                    className="hover-bg"
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 12px', cursor: 'pointer', borderBottom: i < availableTeams.length - 1 ? '1px solid #f3f4f6' : 'none', ['--hover-bg' as string]: '#f0f9ff' }}
                  >
                    <Plus size={14} color="var(--color-brand)" aria-hidden="true" />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{team.name}</span>
                        {team.type && (
                          <Pill
                            bg={team.type === 'support' ? 'var(--color-success-bg)' : team.type === 'owner' ? 'var(--color-info-bg)' : 'var(--color-slate-bg)'}
                            color={team.type === 'support' ? 'var(--color-success)' : team.type === 'owner' ? '#2563eb' : 'var(--color-slate)'}
                            radius={4}
                            style={{ fontSize: 'var(--font-size-label)', padding: '1px 6px' }}
                          >{team.type}</Pill>
                        )}
                      </div>
                      {team.description && (
                        <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 1 }}>{team.description}</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </SectionCard>
      </div>
    </PageContainer>
  )
}
