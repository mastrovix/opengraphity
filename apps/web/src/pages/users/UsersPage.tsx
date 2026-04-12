import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { User, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { gql } from '@apollo/client'
import { PageTitle } from '@/components/PageTitle'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { EmptyState } from '@/components/EmptyState'
import { GET_USERS, GET_TEAMS } from '@/graphql/queries'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { Pagination } from '@/components/ui/Pagination'
import { inputS, selectS, labelS, btnPrimary, btnSecondary } from '@/pages/settings/shared/designerStyles'

// ── TeamSearchInput — stable component outside render to avoid focus loss ────

// ── GraphQL ──────────────────────────────────────────────────────────────────

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

const PAGE_SIZE = 50

export function UsersPage() {
  const { t } = useTranslation()

  const FILTER_FIELDS: FieldConfig[] = [
    { key: 'name',      label: t('pages.users.name'),      type: 'text' },
    { key: 'email',     label: t('pages.users.email'),     type: 'text' },
    { key: 'role',      label: t('pages.users.role'),      type: 'enum', options: [
      { value: 'admin',    label: 'Admin'    },
      { value: 'operator', label: 'Operator' },
      { value: 'viewer',   label: 'Viewer'   },
    ]},
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
  const [page, setPage] = useState(0)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState({ username: '', email: '', firstName: '', lastName: '', password: '', role: 'operator', teamIds: [] as string[] })
  const [teamSearch, setTeamSearch] = useState('')

  const { data, loading, refetch } = useQuery<{ users: UserRow[] }>(GET_USERS, {
    variables: { sortField, sortDirection: sortDir },
    fetchPolicy: 'cache-and-network',
  })

  function handleSort(field: string, direction: 'asc' | 'desc') {
    setSortField(field)
    setSortDir(direction)
    setPage(0)
  }
  const { data: teamsData } = useQuery<{ teams: { id: string; name: string; description: string | null; type: string | null }[] }>(GET_TEAMS)
  const teams = teamsData?.teams ?? []
  const [createUserMut, { loading: creating }] = useMutation(CREATE_USER, {
    onCompleted: () => { toast.success('Utente creato'); setModalOpen(false); setForm({ username: '', email: '', firstName: '', lastName: '', password: '', role: 'operator', teamIds: [] }); refetch() },
    onError: (err) => toast.error(err.message),
  })

  const allUsers   = data?.users ?? []
  const filtered   = filterGroup ? allUsers : allUsers
  const total      = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageItems  = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<User size={22} color="#38bdf8" />}>
            {t('pages.users.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.users.count', { count: total })}
          </p>
        </div>
        <button
          onClick={() => { setModalOpen(true); setTeamSearch(''); setForm({ username: '', email: '', firstName: '', lastName: '', password: '', role: 'operator', teamIds: [] }) }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#fff', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
        >
          {t('pages.users.newUser')}
        </button>
      </div>

      <FilterBuilder
        fields={FILTER_FIELDS}
        onApply={(group) => { setFilterGroup(group); setPage(0) }}
      />

      <SortableFilterTable
        columns={COLUMNS}
        data={pageItems}
        loading={loading}
        onSort={handleSort}
        sortField={sortField}
        sortDir={sortDir}
        emptyComponent={
          <EmptyState
            icon={<User size={32} color="var(--color-slate-light)" />}
            title={t('pages.users.noResults')}
            description={t('pages.users.noResultsDesc')}
          />
        }
        onRowClick={(row) => navigate(`/users/${row.id}`)}
      />

      <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
      {/* Create User Modal */}
      {modalOpen && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
             onClick={() => setModalOpen(false)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 440, boxShadow: '0 8px 30px rgba(0,0,0,.18)' }}
               onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>Nuovo utente</span>
              <X size={18} style={{ cursor: 'pointer', color: 'var(--color-slate)' }} onClick={() => setModalOpen(false)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div><label style={labelS}>Username <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span></label><input style={inputS} value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} placeholder="mario.rossi" /></div>
              <div><label style={labelS}>Email <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span></label><input style={inputS} type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="mario@acme.com" /></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div><label style={labelS}>Nome <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span></label><input style={inputS} value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} placeholder="Mario" /></div>
                <div><label style={labelS}>Cognome <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span></label><input style={inputS} value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} placeholder="Rossi" /></div>
              </div>
              <div><label style={labelS}>Password <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span></label><input style={inputS} type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="Min. 8 caratteri" /></div>
              <div><label style={labelS}>Ruolo <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span></label>
                <select style={selectS} value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                  <option value="admin">Admin</option>
                  <option value="operator">Operator</option>
                  <option value="viewer">Viewer</option>
                  <option value="end_user">End User</option>
                </select>
              </div>
              {/* Team — search + chips */}
              <div>
                <label style={labelS}>Team</label>
                {/* Selected team chips */}
                {(() => {
                  const uniqueIds = [...new Set(form.teamIds)]
                  if (uniqueIds.length === 0) return null
                  return (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                      {uniqueIds.map(tid => {
                        const t = teams.find(x => x.id === tid)
                        if (!t) return null
                        return (
                          <span key={tid} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px 3px 10px', borderRadius: 6, background: '#f0fdf4', border: '1px solid #86efac', color: '#15803d', fontSize: 'var(--font-size-body)' }}>
                            {t.name}{t.type ? ` (${t.type})` : ''}
                            <button type="button" onClick={() => setForm(prev => ({ ...prev, teamIds: prev.teamIds.filter(id => id !== tid) }))}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#15803d', padding: 0, lineHeight: 1, display: 'flex', alignItems: 'center', opacity: 0.7 }}>
                              <X size={12} />
                            </button>
                          </span>
                        )
                      })}
                    </div>
                  )
                })()}
                {/* Search input */}
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 'var(--font-size-card-title)', pointerEvents: 'none', color: 'var(--color-slate-light)' }}>🔍</span>
                  <input
                    type="text"
                    value={teamSearch}
                    onChange={e => setTeamSearch(e.target.value)}
                    placeholder="Digita per cercare team..."
                    style={{ ...inputS, paddingLeft: 36 }}
                  />
                  {teamSearch.length >= 1 && (() => {
                    const available = teams.filter(t =>
                      !form.teamIds.includes(t.id) &&
                      t.name.toLowerCase().includes(teamSearch.toLowerCase())
                    )
                    if (available.length === 0) return null
                    return (
                      <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', maxHeight: 200, overflowY: 'auto', zIndex: 20 }}>
                        {available.map(t => (
                          <div
                            key={t.id}
                            onMouseDown={() => { setForm(prev => ({ ...prev, teamIds: [...new Set([...prev.teamIds, t.id])] })); setTeamSearch('') }}
                            style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid #f3f4f6' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f8fafc' }}
                            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
                          >
                            <Users size={14} color="var(--color-slate-light)" />
                            <div style={{ flex: 1 }}>
                              <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{t.name}</span>
                              {t.type && <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginLeft: 6 }}>({t.type})</span>}
                              {t.description && <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 1 }}>{t.description}</div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  })()}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <button style={btnSecondary} onClick={() => setModalOpen(false)}>Annulla</button>
                {(() => {
                  const canCreate = !creating && form.username.trim() && form.email.trim() && form.firstName.trim() && form.lastName.trim() && form.password.trim() && form.role
                  return (
                    <button
                      style={{ ...btnPrimary, opacity: canCreate ? 1 : 0.5, cursor: canCreate ? 'pointer' : 'not-allowed' }}
                      disabled={!canCreate}
                      onClick={() => createUserMut({ variables: { input: { name: `${form.firstName} ${form.lastName}`.trim(), email: form.email, password: form.password, role: form.role, teamIds: form.teamIds } } })}
                    >
                      {creating ? 'Creazione…' : 'Crea utente'}
                    </button>
                  )
                })()}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </PageContainer>
  )
}
