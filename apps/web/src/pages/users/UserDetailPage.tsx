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
import { SET_USER_ACTIVE, SET_USER_ROLE } from '@/graphql/mutations'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { useMe } from '@/hooks/useMe'
import { Select } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { useRoles } from '@/hooks/useRoles'
import { colors, palette } from '@/lib/tokens'
import { formatDate } from '@/lib/datetime'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { vocabularyValueStyle } from '@/lib/domainStyle'
import { TEAM_TYPE_VOCABULARY } from '@/lib/teamVocabularies'

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
  active:    boolean
  firstName: string | null
  lastName:  string | null
  email:     string
  role:      string
  roleName:  string | null
  slackId:   string | null
  createdAt: string | null
  teams:     TeamRef[]
}

// ── Page ──────────────────────────────────────────────────────────────────────

/** Il tipo di un team, con lo stile e l'etichetta del vocabolario del cliente (F-9). */
function TeamTypePill({ type }: { type: string }) {
  const { valuesOf, labelOf, colorOf } = useDomainVocabularies()
  const s = vocabularyValueStyle(TEAM_TYPE_VOCABULARY, type, valuesOf(TEAM_TYPE_VOCABULARY), colorOf(TEAM_TYPE_VOCABULARY, type))
  return (
    <Pill bg={s.bg} color={s.color} radius={4} style={{ fontSize: 'var(--font-size-label)', padding: '1px 6px' }}>
      {labelOf(TEAM_TYPE_VOCABULARY, type) ?? type}
    </Pill>
  )
}

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

  const [updateTeams] = useMutationWithToast(UPDATE_USER_TEAMS, { successMessage: t('toast.user.teamsUpdated'), refetch })
  // Il ruolo della persona (ondata 7): i ruoli dell'organizzazione, mai l'ultimo che gestisce persone e ruoli (lo dice l'API).
  const { roles, labelOf: roleLabel } = useRoles()
  const [roleChoice, setRoleChoice] = useState<string | null>(null)
  const [setUserRole, { loading: savingRole }] = useMutationWithToast(SET_USER_ROLE, { successMessage: t('pages.users.roleChanged'), refetch, onSuccess: () => setRoleChoice(null) })

  // Disattivare una persona (revisione totale · M-6): non entra, non riceve lavoro né notifiche; lo storico resta.
  const { me } = useMe()
  const [confirmActive, setConfirmActive] = useState<boolean | null>(null)
  const [setUserActive, { loading: savingActive }] = useMutationWithToast(SET_USER_ACTIVE, {
    successMessage: confirmActive === false ? t('pages.userDetail.deactivated') : t('pages.userDetail.reactivated'),
    refetch, onSuccess: () => setConfirmActive(null),
  })

  const user = data?.user
  const allTeams = allTeamsData?.teams ?? []
  const userTeamIds = user?.teams.map(team => team.id) ?? []
  const availableTeams = allTeams.filter(team => !userTeamIds.includes(team.id))

  if (loading && !user) {
    return <div style={{ padding: '32px 40px', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>{t('common.loading')}</div>
  }

  if (error && !data) {
    return (
      <div style={{ padding: '32px 40px' }}>
        <QueryError message={error.message} onRetry={() => void refetch()} />
      </div>
    )
  }

  if (!user) {
    return <div style={{ padding: '32px 40px', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>{t('pages.userDetail.notFound')}</div>
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
          <RoleBadge role={user.role} name={user.roleName} />
          {!user.active && <Pill bg={palette.neutral.borderLight} color="var(--color-slate-dark)">{t('pages.users.inactive')}</Pill>}
          {me?.id !== user.id && (
            <span style={{ marginLeft: 'auto' }}>
              <Button size="xs" variant="secondary" disabled={savingActive} onClick={() => setConfirmActive(!user.active)}>
                {user.active ? t('pages.userDetail.deactivate') : t('pages.userDetail.reactivate')}
              </Button>
            </span>
          )}
        </div>
      </div>
      <ConfirmModal
        open={confirmActive !== null}
        title={confirmActive ? t('pages.userDetail.reactivateTitle', { name: user.name }) : t('pages.userDetail.deactivateTitle', { name: user.name })}
        body={confirmActive ? t('pages.userDetail.reactivateBody') : t('pages.userDetail.deactivateBody')}
        confirmLabel={confirmActive ? t('pages.userDetail.reactivate') : t('pages.userDetail.deactivate')}
        loading={savingActive}
        onConfirm={() => { if (confirmActive !== null) void setUserActive({ variables: { userId: user.id, active: confirmActive } }) }}
        onCancel={() => setConfirmActive(null)}
      />

      {/* Body */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionCard title={t('pages.userDetail.info')} defaultOpen>
          <div className="og-pair">
            <DetailField label="ID" value={user.id} mono />
            <DetailField label={t('pages.userDetail.code')} value={user.code} />
            <DetailField label={t('pages.userDetail.firstName')} value={user.firstName} />
            <DetailField label={t('pages.userDetail.lastName')} value={user.lastName} />
            <DetailField label={t('pages.users.email')} value={user.email} />
            <DetailField label={t('pages.users.changeRole')} value={(
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Select aria-label={t('pages.users.changeRole')} value={roleChoice ?? user.role} onChange={(e) => setRoleChoice(e.target.value)} style={{ width: 220 }}>
                  {roles.length === 0 && <option value={user.role}>{roleLabel(user.role)}</option>}
                  {roles.map((r) => <option key={r.key} value={r.key}>{roleLabel(r.key)}</option>)}
                </Select>
                {roleChoice !== null && roleChoice !== user.role && (
                  <Button size="xs" disabled={savingRole} onClick={() => void setUserRole({ variables: { userId: user.id, role: roleChoice } })}>{t('pages.users.saveRole')}</Button>
                )}
              </span>
            )} />
            <DetailField label={t('pages.userDetail.slackId')} value={user.slackId} mono />
            <DetailField label={t('detail.createdAt')} value={user.createdAt ? formatDate(user.createdAt) : null} />
          </div>
        </SectionCard>

        <SectionCard title={`Team (${user.teams.length})`} defaultOpen>
            {/* Current teams */}
            {user.teams.length === 0 ? (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 12px' }}>{t('pages.userDetail.noTeams')}</p>
            ) : (
              <div style={{ marginBottom: 12 }}>
                {user.teams.map((team, i) => (
                  <div key={team.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: i < user.teams.length - 1 ? `1px solid ${palette.neutral.borderLight}` : 'none' }}>
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: palette.info.tint, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Users size={14} color="var(--color-brand)" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Link to={`/teams/${team.id}`} style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)', textDecoration: 'none' }}>{team.name}</Link>
                        {/* Il tipo di team è un vocabolario del cliente: stile ed
                            etichetta vengono da lui, non da due nomi cablati
                            (revisione totale · F-9). */}
                        {team.type && <TeamTypePill type={team.type} />}
                      </div>
                    </div>
                    <button type="button"
                      onClick={() => void updateTeams({ variables: { userId: user.id, teamIds: userTeamIds.filter(tid => tid !== team.id) } })}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', borderRadius: 4 }}
                      title={t('pages.userDetail.removeFromTeam')}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-danger-bg)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}
                    >
                      <X size={14} color={colors.danger} />
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
                <Plus size={14} /> {t('pages.users.addToTeam')}
              </button>
            ) : (
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 8 }}>
                <div style={{ padding: '6px 12px', background: 'var(--color-slate-bg)', borderBottom: '1px solid var(--border)', fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>{t('pages.userDetail.availableTeams')}</span>
                  <button type="button" onClick={() => setShowAddTeam(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('common.close')}</button>
                </div>
                {availableTeams.length === 0 ? (
                  <div style={{ padding: '12px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', textAlign: 'center' }}>{t('pages.userDetail.noOtherTeams')}</div>
                ) : availableTeams.map((team, i) => (
                  <button
                    type="button"
                    key={team.id}
                    onClick={() => { void updateTeams({ variables: { userId: user.id, teamIds: [...userTeamIds, team.id] } }); setShowAddTeam(false) }}
                    className="hover-bg"
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 12px', cursor: 'pointer', borderBottom: i < availableTeams.length - 1 ? `1px solid ${palette.neutral.borderLight}` : 'none', ['--hover-bg' as string]: palette.info.light }}
                  >
                    <Plus size={14} color="var(--color-brand)" aria-hidden="true" />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{team.name}</span>
                        {/* Il tipo di team è un vocabolario del cliente: stile ed
                            etichetta vengono da lui, non da due nomi cablati
                            (revisione totale · F-9). */}
                        {team.type && <TeamTypePill type={team.type} />}
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
