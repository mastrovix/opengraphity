import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { User, Users, X } from 'lucide-react'
import { gql } from '@apollo/client'
import { ListPageHeader } from '@/components/ListPageHeader'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { EmptyState } from '@/components/EmptyState'
import { GET_USERS, GET_TEAMS } from '@/graphql/queries'
import { FilterBuilder, type FieldConfig } from '@/components/FilterBuilder'
import { Pagination } from '@/components/ui/Pagination'
import { Input, Select } from '@/components/ui/FormControls'
import { labelS } from '@/components/ui/styles'
import { RoleBadge } from '@/components/ui/badges'
import { QueryError } from '@/components/QueryError'
import { ExportCsvButton } from '@/components/ExportCsvButton'
import { exportToCsv } from '@/lib/csvExport'
import { applyFilterGroup } from '@/lib/filterGroup'
import { useMutationWithToast } from '@/hooks/useMutationWithToast'
import { useListQueryState } from '@/hooks/useListQueryState'
import { ALL_ROLES } from '@/hooks/useMe'
import { colors, palette, alpha } from '@/lib/tokens'

// ── GraphQL ──────────────────────────────────────────────────────────────────

// `CreateUserInput` (schema-user-team.ts): email, name, password, role, teamIds —
// there is no username field, so the form does not ask for one (E-02).
const CREATE_USER = gql`
  mutation CreateUser($input: CreateUserInput!) {
    createUser(input: $input) { id name email role }
  }
`

interface UserRow {
  id:        string
  name:      string
  email:     string
  role:      string
  createdAt: string | null
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin', operator: 'Operator', viewer: 'Viewer', end_user: 'End User',
}

const EMPTY_FORM = { email: '', firstName: '', lastName: '', password: '', role: 'operator', teamIds: [] as string[] }

const REQUIRED = <span aria-hidden="true" style={{ color: 'var(--color-danger)' }}>*</span>

export function UsersPage() {
  const { t } = useTranslation()

  const FILTER_FIELDS: FieldConfig[] = [
    { key: 'name',      label: t('pages.users.name'),      type: 'text' },
    { key: 'email',     label: t('pages.users.email'),     type: 'text' },
    { key: 'role',      label: t('pages.users.role'),      type: 'enum',
      options: ALL_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] ?? r })) },
    { key: 'createdAt', label: t('pages.users.createdAt'), type: 'date' },
  ]

  const COLUMNS: ColumnDef<UserRow>[] = [
    { key: 'name',  label: t('pages.users.name'),  sortable: true },
    { key: 'email', label: t('pages.users.email'), sortable: true },
    {
      key:    'role',
      label:  t('pages.users.role'),
      width:  '120px',
      sortable: true,
      render: (v) => <RoleBadge role={v as string} />,
    },
    {
      key:     'createdAt',
      label:   t('pages.users.createdAt'),
      width:   '120px',
      sortable: true,
      render:  (v) => v ? new Date(v as string).toLocaleDateString() : '—',
    },
  ]
  const navigate = useNavigate()
  // Sort / filters / page live in the URL: reload and shared links keep the view.
  const list = useListQueryState({ pageSize: 50, persistInQuery: true })
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [teamSearch, setTeamSearch] = useState('')

  // `users(sortField, sortDirection)` has no `filters` argument (see below).
  const { data, loading, error, refetch } = useQuery<{ users: UserRow[] }>(GET_USERS, {
    variables: { sortField: list.sortField, sortDirection: list.sortDir },
    fetchPolicy: 'cache-and-network',
  })

  const { data: teamsData } = useQuery<{ teams: { id: string; name: string; description: string | null; type: string | null }[] }>(GET_TEAMS)
  const teams = teamsData?.teams ?? []
  const [createUserMut, { loading: creating }] = useMutationWithToast(CREATE_USER, {
    successMessage: 'Utente creato',
    onSuccess:      () => { setModalOpen(false); setForm(EMPTY_FORM) },
    refetch,
  })

  // `users(sortField, sortDirection)` has no `filters` argument: the advanced
  // filters are applied here, on the full list, with the same semantics as
  // the API's filter builder — so the table AND the CSV export see them (E-02).
  const allUsers   = data?.users ?? []
  const filtered   = applyFilterGroup(allUsers, list.filterGroup)
  const { pageItems, totalPages, total } = list.paginate(filtered)

  const canCreate = !creating && form.email.trim() && form.firstName.trim() && form.lastName.trim() && form.password.trim() && form.role

  return (
    <PageContainer>
      <ListPageHeader
        icon={<User size={22} color="var(--color-icon-accent)" />}
        title={t('pages.users.title')}
        subtitle={
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.users.count', { count: total })}
          </p>
        }
        actions={
          <Button onClick={() => { setModalOpen(true); setTeamSearch(''); setForm(EMPTY_FORM) }}>
            {t('pages.users.newUser')}
          </Button>
        }
      />

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <FilterBuilder
            fields={FILTER_FIELDS}
            onApply={list.setFilterGroup}
          />
        </div>
        <ExportCsvButton
          onExport={async () => { exportToCsv('users', COLUMNS, filtered) }}
        />
      </div>

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <>
          <SortableFilterTable
            columns={COLUMNS}
            data={pageItems}
            loading={loading}
            onSort={list.handleSort}
            sortField={list.sortField}
            sortDir={list.sortDir}
            emptyComponent={
              <EmptyState
                icon={<User size={32} color="var(--color-slate-light)" />}
                title={t('pages.users.noResults')}
                description={t('pages.users.noResultsDesc')}
              />
            }
            onRowClick={(row) => navigate(`/users/${row.id}`)}
          />

          <Pagination currentPage={list.page + 1} totalPages={totalPages} onPrev={list.prevPage} onNext={list.nextPage} />
        </>
      )}
      {/* Create User Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={t('pages.users.newUserTitle')}
        width={440}
        closeOnOverlay={false}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>{t('common.cancel')}</Button>
            <Button
              disabled={!canCreate}
              onClick={() => void createUserMut({ variables: { input: { name: `${form.firstName} ${form.lastName}`.trim(), email: form.email, password: form.password, role: form.role, teamIds: form.teamIds } } })}
            >
              {creating ? t('pages.users.creating') : t('pages.users.create')}
            </Button>
          </>
        }
      >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div><label style={labelS}>{t('pages.users.email')} {REQUIRED}</label><Input type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="mario@acme.com" /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><label style={labelS}>{t('pages.users.firstName')} {REQUIRED}</label><Input required value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} placeholder="Mario" /></div>
              <div><label style={labelS}>{t('pages.users.lastName')} {REQUIRED}</label><Input required value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} placeholder="Rossi" /></div>
            </div>
            <div><label style={labelS}>{t('pages.users.password')} {REQUIRED}</label><Input type="password" required value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder={t('pages.users.passwordHint')} /></div>
            <div><label style={labelS}>{t('pages.users.role')} {REQUIRED}</label>
              <Select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>)}
              </Select>
            </div>
            {/* Team — search + chips */}
            <div>
              <label style={labelS}>{t('pages.users.teams')}</label>
              {/* Selected team chips */}
              {(() => {
                const uniqueIds = [...new Set(form.teamIds)]
                if (uniqueIds.length === 0) return null
                return (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    {uniqueIds.map(tid => {
                      const team = teams.find(x => x.id === tid)
                      if (!team) return null
                      return (
                        <span key={tid} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px 3px 10px', borderRadius: 6, background: 'var(--color-success-bg)', border: `1px solid ${palette.success.border}`, color: palette.success.text, fontSize: 'var(--font-size-body)' }}>
                          {team.name}{team.type ? ` (${team.type})` : ''}
                          <button type="button" aria-label={t('pages.users.removeTeam', { name: team.name })} onClick={() => setForm(prev => ({ ...prev, teamIds: prev.teamIds.filter(id => id !== tid) }))}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: palette.success.text, padding: 0, lineHeight: 1, display: 'flex', alignItems: 'center', opacity: 0.7 }}>
                            <X size={12} aria-hidden="true" />
                          </button>
                        </span>
                      )
                    })}
                  </div>
                )
              })()}
              {/* Search input */}
              <div style={{ position: 'relative' }}>
                <Input
                  type="search"
                  value={teamSearch}
                  onChange={e => setTeamSearch(e.target.value)}
                  placeholder={t('pages.users.searchTeams')}
                  aria-label={t('pages.users.searchTeams')}
                />
                {teamSearch.length >= 1 && (() => {
                  const available = teams.filter(team =>
                    !form.teamIds.includes(team.id) &&
                    team.name.toLowerCase().includes(teamSearch.toLowerCase())
                  )
                  if (available.length === 0) return null
                  return (
                    <div role="listbox" style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, background: colors.white, border: '1px solid var(--border)', borderRadius: 8, boxShadow: `0 4px 12px ${alpha.black10}`, maxHeight: 200, overflowY: 'auto', zIndex: 20 }}>
                      {available.map(team => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          key={team.id}
                          onMouseDown={() => { setForm(prev => ({ ...prev, teamIds: [...new Set([...prev.teamIds, team.id])] })); setTeamSearch('') }}
                          className="hover-bg"
                          style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--color-border-light)' }}
                        >
                          <Users size={14} aria-hidden="true" color="var(--color-slate-light)" />
                          <div style={{ flex: 1 }}>
                            <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{team.name}</span>
                            {team.type && <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginLeft: 6 }}>({team.type})</span>}
                            {team.description && <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 1 }}>{team.description}</div>}
                          </div>
                        </button>
                      ))}
                    </div>
                  )
                })()}
              </div>
            </div>
          </div>
      </Modal>
    </PageContainer>
  )
}
