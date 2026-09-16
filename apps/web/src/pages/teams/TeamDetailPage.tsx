import { useState } from 'react'
import { useRoles } from '@/hooks/useRoles'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
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
import { Select } from '@/components/ui/FormControls'
import { GET_TEAM, GET_USERS } from '@/graphql/queries'
import { UPDATE_TEAM } from '@/graphql/mutations'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { TEAM_TYPE_VOCABULARY } from '@/lib/teamVocabularies'
import { TEAM_SOURCINGS, teamSourcingKey } from '@/lib/teamSourcing'
import { SET_TEAM_MANAGER, REMOVE_TEAM_MANAGER, SET_TEAM_MEMBER, SET_CHANGE_MANAGER_TEAM } from '@/graphql/mutations'
import { ciPath } from '@/lib/ciPath'
import { toast } from 'sonner'
import { colors, palette } from '@/lib/tokens'
import { vocabularyValueStyle } from '@/lib/domainStyle'
import { formatDate } from '@/lib/datetime'
import { AttachmentsSection } from '@/components/AttachmentsSection'
import { showError } from '@/lib/showError'
import { useCILabels } from '@/hooks/useCILabels'

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
  name:         string
  description:  string | null
  type:         string | null
  sourcing:     string | null
  createdAt:    string
  isChangeManager: boolean | null
  manager:      ManagerRef | null
  members:      Member[]
  ownedCIs:     CIRef[]
  supportedCIs: CIRef[]
}

function TypeBadge({ type, label }: { type: string | null; label?: string | null }) {
  // Il tipo di team è un VOCABOLARIO del cliente: lo stile viene da lui
  // (`vocabularyValueStyle`), non da una mappa di due nomi. Con `lookupStyle`
  // qualunque valore diverso da `owner`/`support` — per esempio il `vendor`
  // che l'ondata «team_type configurabile» rende possibile — riceveva lo
  // stile d'errore rosso e un `console.error` per riga (revisione totale ·
  // F-9).
  const { valuesOf, colorOf } = useDomainVocabularies()
  if (!type) return <span style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>—</span>
  const s = vocabularyValueStyle(TEAM_TYPE_VOCABULARY, type, valuesOf(TEAM_TYPE_VOCABULARY), colorOf(TEAM_TYPE_VOCABULARY, type))
  return (
    <Pill bg={s.bg} color={s.color} radius={4} style={{ fontSize: 'var(--font-size-body)', textTransform: 'capitalize' }}>
      {label ?? type}
    </Pill>
  )
}

// ── CI mini-table ─────────────────────────────────────────────────────────────

function CITable({ items, onRowClick, emptyMsg }: { items: CIRef[]; onRowClick: (ci: CIRef) => void; emptyMsg: string }) {
  const { t } = useTranslation()
  const ciLabels = useCILabels()
  const columns: SimpleColumn<CIRef>[] = [
    { key: 'name',        label: t('pages.cmdb.name'),        render: (v) => <span style={{ fontWeight: 500 }}>{String(v)}</span> },
    // F-23: l'etichetta del tipo dal metamodello, non il nome «umanizzato».
    { key: 'type',        label: t('pages.teams.type'),       render: (v) => <span style={{ color: 'var(--color-slate)' }}>{ciLabels.typeLabel(String(v))}</span> },
    { key: 'environment', label: t('pages.cmdb.environment'), render: (v) => <EnvBadge environment={v as string | null} /> },
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
  // F-29: i ruoli dell'organizzazione, per mostrarne il NOME e non la chiave.
  const { labelOf: roleLabel } = useRoles()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [showManagerModal, setShowManagerModal] = useState(false)
  const [managerSearch, setManagerSearch] = useState('')
  const [pendingManagerUser, setPendingManagerUser] = useState<{ id: string; name: string } | null>(null)
  // Giro del 14 set 2026 (#48): i membri si aggiungono e si tolgono dal team.
  const [showMemberModal, setShowMemberModal] = useState(false)
  const [memberSearch, setMemberSearch] = useState('')

  const { data, loading, error, refetch } = useQuery<{ team: Team | null }>(GET_TEAM, {
    variables:   { id },
    fetchPolicy: 'cache-and-network',
    skip:        !id,
  })
  // Il tipo e un vocabolario del cliente: qui non c'e nessuna lista.
  const { entriesOf, labelOf } = useDomainVocabularies()
  const tipiTeam = entriesOf(TEAM_TYPE_VOCABULARY) ?? []
  const [updateTeam, { loading: savingType }] = useMutation(UPDATE_TEAM, {
    // La diagnostica elenca i team senza interno/esterno: dopo una scrittura
    // va riletta, altrimenti l'avviso in cima continua a contare il team appena sistemato.
    refetchQueries: ['GetConfigurationIssues'],
    onCompleted: () => { toast.success(t('toast.team.updated')); refetch() },
    onError: (err) => showError(err),
  })

  const [setManager] = useMutation(SET_TEAM_MANAGER, {
    onCompleted: () => { toast.success(t('toast.team.managerUpdated')); refetch(); setShowManagerModal(false) },
    onError: (err) => showError(err),
  })
  const [removeManager] = useMutation(REMOVE_TEAM_MANAGER, {
    onCompleted: () => { toast.success(t('toast.team.managerRemoved')); refetch() },
    onError: (err) => showError(err),
  })
  const [setChangeManager, { loading: settingCM }] = useMutation(SET_CHANGE_MANAGER_TEAM, {
    onCompleted: () => { toast.success(t('toast.team.changeManagerUpdated')); refetch() },
    onError: (err) => showError(err),
  })

  const { data: usersData } = useQuery<{ users: Member[] }>(GET_USERS, { skip: !showMemberModal })
  const [setTeamMember, { loading: savingMember }] = useMutation(SET_TEAM_MEMBER, {
    onCompleted: (_d, opts) => {
      toast.success(t(opts?.variables?.['member'] ? 'toast.team.memberAdded' : 'toast.team.memberRemoved'))
      refetch()
    },
    onError: (err) => showError(err),
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
        <Link to="/teams" style={{ display: 'inline-block', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 4, textDecoration: 'none' }}>
          ← {t('pages.teams.title')}
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <UsersRound size={22} color="var(--color-icon-accent)" />
          <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>{team.name}</h1>
        </div>
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 4 }}>
          {t('detail.createdAt')} {formatDate(team.createdAt)}
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionCard title={t('detail.sections.information')} defaultOpen>
          <div className="og-pair">
            <DetailField label="ID" value={team.id} mono />
            <DetailField label={t('pages.teams.name')} value={team.name} />
            <DetailField label={t('pages.teams.sourcing.label')} value={
              /*
                Si CAMBIA ma non si toglie: l'opzione «non indicato» compare
                solo finche il team non l'ha (i team di prima del campo), e
                non si puo riselezionare — l'API la rifiuterebbe.
              */
              <Select
                value={team.sourcing ?? ''}
                disabled={savingType}
                aria-label={t('pages.teams.sourcing.label')}
                onChange={(e) => { if (e.target.value) void updateTeam({ variables: { id: team.id, input: { sourcing: e.target.value } } }) }}
                style={{ maxWidth: 220 }}
              >
                {!team.sourcing && <option value="" disabled>{t('pages.teams.sourcing.notSet')}</option>}
                {TEAM_SOURCINGS.map((v) => <option key={v} value={v}>{t(teamSourcingKey(v))}</option>)}
              </Select>
            } />
            <DetailField label={t('pages.teams.type')} value={
              /*
                Il tipo si CAMBIA da qui. Prima era in sola lettura su ogni
                cammino: una pastiglia e nessuna scrittura, quindi i team
                creati dall'interfaccia restavano senza tipo per sempre.
                Senza vocabolario (nessun valore nel Dizionario) si mostra la
                pastiglia e si dice perche' non c'e' niente da scegliere,
                invece di una tendina vuota.
              */
              tipiTeam.length === 0
                ? (
                  <div>
                    <TypeBadge type={team.type} label={team.type ? labelOf(TEAM_TYPE_VOCABULARY, team.type) : null} />
                    <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                      {t('pages.teams.noTypeVocabulary')}
                    </p>
                  </div>
                )
                : (
                  <Select
                    value={team.type ?? ''}
                    disabled={savingType}
                    aria-label={t('pages.teams.type')}
                    onChange={(e) => { if (e.target.value) void updateTeam({ variables: { id: team.id, input: { type: e.target.value } } }) }}
                    style={{ maxWidth: 220 }}
                  >
                    {/* Si cambia ma non si toglie: «nessun tipo» c'e solo per i team di prima, e non si riseleziona. */}
                    {!team.type && <option value="" disabled>{t('pages.teams.noType')}</option>}
                    {tipiTeam.map((v) => (
                      <option key={v.value} value={v.value}>{v.label ?? v.value}</option>
                    ))}
                  </Select>
                )
            } />
            <DetailField label={t('pages.teamDetail.manager')} value={
              team.manager ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Link to={`/users/${team.manager.id}`} style={{ color: 'var(--color-brand)', fontWeight: 500, textDecoration: 'none' }}>{team.manager.name}</Link>
                  <Button variant="ghost" onClick={() => { setManagerSearch(''); setPendingManagerUser(null); setShowManagerModal(true) }} style={{ color: 'var(--color-brand)', fontWeight: 500, fontSize: 'var(--font-size-table)', padding: 0 }}>{t('pages.teams.changeManager')}</Button>
                  <button
                    type="button"
                    onClick={() => removeManager({ variables: { teamId: team.id } })}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', borderRadius: 4 }}
                    title={t('pages.teams.removeManager')}
                    aria-label={t('pages.teams.removeManager')}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-danger-bg)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}
                  >
                    <X size={12} color={colors.danger} />
                  </button>
                </div>
              ) : (
                <Button variant="ghost" onClick={() => { setManagerSearch(''); setPendingManagerUser(null); setShowManagerModal(true) }} style={{ color: 'var(--color-brand)', fontWeight: 500, padding: 0 }}>+ {t('pages.teams.assignManager')}</Button>
              )
            } />
            <DetailField label={t('pages.teams.description')} value={team.description} />
            <DetailField label={t('detail.createdAt')} value={formatDate(team.createdAt)} />
            <DetailField label={t('pages.teamDetail.changeManager')} value={
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: settingCM ? 'wait' : 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!team.isChangeManager}
                  disabled={settingCM}
                  onChange={(e) => void setChangeManager({ variables: { teamId: team.id, value: e.target.checked } })}
                />
                <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                  {t(team.isChangeManager ? 'pages.teams.isChangeManager' : 'pages.teams.makeChangeManager')}
                </span>
              </label>
            } />
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
              title={t(team.manager ? 'pages.teams.changeManagerTitle' : 'pages.teams.assignManagerTitle')}
              width={440}
            >
              {/* Cancel the Modal body padding so sections run edge-to-edge */}
              <div style={{ margin: -24 }}>
                {/* Confirmation banner */}
                {pendingManagerUser && (
                  <div style={{ padding: '12px 20px', background: 'var(--color-warning-bg)', borderBottom: `1px solid ${palette.warning.border}` }}>
                    <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginBottom: 10 }}>
                      <Trans i18nKey="pages.teams.replaceManagerConfirm"
                        values={{ current: team.manager?.name ?? '', next: pendingManagerUser.name }}
                        components={{ strong: <strong /> }} />
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button
                        onClick={() => { setManager({ variables: { teamId: team.id, userId: pendingManagerUser.id } }); setPendingManagerUser(null) }}
                        style={{ padding: '6px 16px', fontWeight: 600, fontSize: 'var(--font-size-body)' }}
                      >
                        {t('common.confirm')}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => setPendingManagerUser(null)}
                        style={{ padding: '6px 16px', fontWeight: 600 }}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Search */}
                {!pendingManagerUser && (
                  <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px' }}>
                      <Search size={14} color="var(--color-slate-light)" />
                      <input
                        // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management del dialogo di ricerca aperto dall'utente (Modal)
                        autoFocus
                        value={managerSearch}
                        onChange={e => setManagerSearch(e.target.value)}
                        placeholder={t('pages.teamDetail.searchMember')}
                        style={{ border: 'none', outline: 'none', flex: 1, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}
                      />
                    </div>
                  </div>
                )}

                {/* User list */}
                {!pendingManagerUser && (
                  <div style={{ overflowY: 'auto', maxHeight: 'calc(70vh - 160px)' }}>
                    {filtered.length === 0 ? (
                      <div style={{ padding: '20px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', textAlign: 'center' }}>{t('pages.teamDetail.noMemberFound')}</div>
                    ) : filtered.map((u, i) => (
                      <button
                        type="button"
                        key={u.id}
                        onClick={() => {
                          if (team.manager) {
                            setPendingManagerUser({ id: u.id, name: u.name })
                          } else {
                            setManager({ variables: { teamId: team.id, userId: u.id } })
                          }
                        }}
                        className="hover-bg"
                        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '10px 20px', cursor: 'pointer', borderBottom: i < filtered.length - 1 ? `1px solid ${palette.neutral.borderLight}` : 'none', ['--hover-bg' as string]: palette.info.light }}
                      >
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: palette.info.tint, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Users size={13} color="var(--color-brand)" />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{u.name}</div>
                          <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{u.email}</div>
                        </div>
                        {/* Il NOME del ruolo dell'organizzazione, non la chiave con l'iniziale maiuscola
                            (revisione totale · F-29): un ruolo creato dall'admin si leggeva l2_support
                            invece di «Supporto L2». */}
                        <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{roleLabel(u.role)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Modal>
          )
        })()}

        {/* Members */}
        <SectionCard title={`${t('pages.teams.members')} (${team.members.length})`} defaultOpen>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <Button variant="secondary" onClick={() => { setMemberSearch(''); setShowMemberModal(true) }}>+ {t('pages.teamDetail.addMember')}</Button>
          </div>
          {team.members.length === 0 ? (
            <EmptyState icon={<Users size={24} color="var(--color-slate-light)" />} title={t('pages.teams.noMembers')} />
          ) : (
            <SimpleTable<Member>
              columns={[
                { key: 'name',  label: t('pages.users.name'),  render: (v) => <span style={{ fontWeight: 500 }}>{String(v)}</span> },
                { key: 'email', label: t('pages.users.email'), render: (v) => <span style={{ color: 'var(--color-slate)' }}>{String(v)}</span> },
                // F-29: il nome del ruolo dell'organizzazione, non la chiave tecnica.
                { key: 'role',  label: t('pages.users.role'),  render: (v) => <span style={{ color: 'var(--color-slate)' }}>{roleLabel(String(v))}</span> },
                { key: 'id',    label: '', width: '48px', render: (_v, m) => (
                  <button
                    type="button"
                    disabled={savingMember}
                    onClick={(e) => { e.stopPropagation(); void setTeamMember({ variables: { teamId: team.id, userId: m.id, member: false } }) }}
                    title={t('pages.teamDetail.removeMember', { name: m.name })}
                    aria-label={t('pages.teamDetail.removeMember', { name: m.name })}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', borderRadius: 4 }}
                  >
                    <X size={12} color={colors.danger} />
                  </button>
                ) },
              ]}
              rows={team.members}
            />
          )}
        </SectionCard>

        {showMemberModal && (() => {
          const memberIds = new Set(team.members.map((m) => m.id))
          const q = memberSearch.trim().toLowerCase()
          const candidates = (usersData?.users ?? [])
            .filter((u) => !memberIds.has(u.id))
            .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
          return (
            <Modal open onClose={() => setShowMemberModal(false)} title={t('pages.teamDetail.addMemberTitle', { team: team.name })} width={440}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', marginBottom: 12 }}>
                <Search size={14} color="var(--color-slate-light)" />
                <input
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management del dialogo di ricerca aperto dall'utente (Modal)
                  autoFocus
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder={t('pages.teamDetail.searchUser')}
                  aria-label={t('pages.teamDetail.searchUser')}
                  style={{ border: 'none', outline: 'none', flex: 1, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}
                />
              </div>
              <div style={{ overflowY: 'auto', maxHeight: 'calc(70vh - 160px)' }}>
                {!usersData ? (
                  <div style={{ padding: 20, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', textAlign: 'center' }}>{t('common.loading')}</div>
                ) : candidates.length === 0 ? (
                  <div style={{ padding: 20, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', textAlign: 'center' }}>{t('pages.teamDetail.noUserToAdd')}</div>
                ) : candidates.map((u) => (
                  <button
                    type="button"
                    key={u.id}
                    disabled={savingMember}
                    onClick={() => void setTeamMember({ variables: { teamId: team.id, userId: u.id, member: true } })}
                    className="hover-bg"
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '10px 4px', cursor: 'pointer', borderBottom: `1px solid ${palette.neutral.borderLight}`, ['--hover-bg' as string]: palette.info.light }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{u.name}</div>
                      <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{u.email}</div>
                    </div>
                    {/* Il NOME del ruolo dell'organizzazione, non la chiave con l'iniziale maiuscola
                        (revisione totale · F-29): un ruolo creato dall'admin si leggeva l2_support
                        invece di «Supporto L2». */}
                    <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{roleLabel(u.role)}</span>
                  </button>
                ))}
              </div>
            </Modal>
          )
        })()}

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
