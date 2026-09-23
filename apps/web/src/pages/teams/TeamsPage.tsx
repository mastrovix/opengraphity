import { useState } from 'react'
import { InvalidFilterNotice } from '@/components/InvalidFilterNotice'
import { useQuery, useMutation } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { UsersRound, Plus } from 'lucide-react'
import { ListPageHeader } from '@/components/ListPageHeader'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { Input, Textarea, FieldLabel, Select } from '@/components/ui/FormControls'
import { CREATE_TEAM } from '@/graphql/mutations'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { EmptyState } from '@/components/EmptyState'
import { GET_TEAMS } from '@/graphql/queries'
import { FilterBuilder, type FieldConfig } from '@/components/FilterBuilder'
import { Pagination } from '@/components/ui/Pagination'
import { vocabularyValueStyle } from '@/lib/domainStyle'
import { Pill } from '@/components/ui/Pill'
import { QueryError } from '@/components/QueryError'
import { ExportCsvButton } from '@/components/ExportCsvButton'
import { exportToCsv } from '@/lib/csvExport'
import { useListQueryState } from '@/hooks/useListQueryState'
import { formatDate } from '@/lib/datetime'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { TEAM_TYPE_VOCABULARY } from '@/lib/teamVocabularies'
import { TEAM_SOURCINGS, teamSourcingKey, type TeamSourcing } from '@/lib/teamSourcing'
import { showError } from '@/lib/showError'
import { reloadQueries } from '@/lib/reloadQueries'

interface Team {
  id:          string
  name:        string
  description: string | null
  type:        string | null
  sourcing:    string | null
  createdAt:   string
}

function TypeBadge({ type, label }: { type: string | null; label?: string | null }) {
  // Il tipo di team è un VOCABOLARIO del cliente: lo stile viene da lui
  // (`vocabularyValueStyle`), non da una mappa di due nomi. Con `lookupStyle`
  // qualunque valore diverso da `owner`/`support` — per esempio il `vendor`
  // che l'ondata «team_type configurabile» rende possibile — riceveva lo
  // stile d'errore rosso e un `console.error` per riga (revisione totale ·
  // F-9).
  const { valuesOf, colorOf } = useDomainVocabularies()
  if (!type) return <span style={{ color: 'var(--color-slate-light)' }}>—</span>
  const s = vocabularyValueStyle(TEAM_TYPE_VOCABULARY, type, valuesOf(TEAM_TYPE_VOCABULARY), colorOf(TEAM_TYPE_VOCABULARY, type))
  return (
    <Pill bg={s.bg} color={s.color} radius={4} style={{ fontSize: 'inherit', textTransform: 'capitalize' }}>
      {label ?? type}
    </Pill>
  )
}

export function TeamsPage() {
  const { t } = useTranslation()
  // Il tipo di team e un VOCABOLARIO del cliente (Dizionario → Team Type):
  // qui non c'e nessuna lista di valori, ne per il filtro ne per la tendina.
  const { entriesOf, labelOf } = useDomainVocabularies()
  const tipiTeam = entriesOf(TEAM_TYPE_VOCABULARY) ?? []

  const FILTER_FIELDS: FieldConfig[] = [
    { key: 'name',      label: t('pages.teams.name'),      type: 'text' },
    { key: 'type',      label: t('pages.teams.type'),      type: 'enum',
      options: tipiTeam.map((v) => ({ value: v.value, label: v.label ?? v.value })) },
    { key: 'sourcing',  label: t('pages.teams.sourcing.label'), type: 'enum',
      options: TEAM_SOURCINGS.map((v) => ({ value: v, label: t(teamSourcingKey(v)) })) },
    { key: 'createdAt', label: t('pages.teams.createdAt'), type: 'date' },
  ]

  const COLUMNS: ColumnDef<Team>[] = [
    { key: 'name',        label: t('pages.teams.name'),        sortable: true },
    { key: 'description', label: t('pages.teams.description'), sortable: false },
    {
      key:    'type',
      label:  t('pages.teams.type'),
      width:  '120px',
      sortable: true,
      render: (v) => <TypeBadge type={v as string | null} label={v ? labelOf(TEAM_TYPE_VOCABULARY, v as string) : null} />,
    },
    {
      key:    'sourcing',
      label:  t('pages.teams.sourcing.label'),
      width:  '150px',
      sortable: true,
      render: (v) => v
        ? t(teamSourcingKey(v as string))
        : <span style={{ color: 'var(--color-slate-light)' }}>{t('pages.teams.sourcing.notSet')}</span>,
    },
    {
      key:    'createdAt',
      label:  t('pages.teams.createdAt'),
      width:  '120px',
      sortable: true,
      render: (v) => formatDate(v as string),
    },
  ]
  const navigate = useNavigate()
  // Sort / filters / page live in the URL: reload and shared links keep the view.
  const list = useListQueryState({ pageSize: 50, persistInQuery: true })

  const { data, loading, error, refetch } = useQuery<{ teams: Team[] }>(GET_TEAMS, {
    variables: list.variables,
    fetchPolicy: 'cache-and-network',
  })

  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState<{ name: string; description: string; type: string; sourcing: TeamSourcing | '' }>({ name: '', description: '', type: '', sourcing: '' })
  const [createTeam, { loading: creating }] = useMutation(CREATE_TEAM, {
    // La diagnostica elenca i team senza interno/esterno: dopo una scrittura
    // va riletta, altrimenti l'avviso in cima continua a contare il team appena sistemato.
    refetchQueries: ['GetConfigurationIssues'],
    onCompleted: () => { setCreateOpen(false); setForm({ name: '', description: '', type: '', sourcing: '' }); toast.success(t('toast.team.created')); reloadQueries(refetch) },
    onError: (e) => showError(e),
  })
  const submitTeam = (e: React.FormEvent) => {
    e.preventDefault()
    void createTeam({ variables: { input: { name: form.name.trim(), description: form.description.trim() || null, type: form.type, sourcing: form.sourcing } } })
  }

  const teams = data?.teams ?? []
  const { pageItems, totalPages, total } = list.paginate(teams)

  return (
    <PageContainer>
      {/* F-17: un filtro dell'URL illeggibile si dice, non si ignora. */}
      <InvalidFilterNotice show={list.filtersInvalid} />
      <ListPageHeader
        icon={<UsersRound size={22} color="var(--color-icon-accent)" />}
        title={t('pages.teams.title')}
        subtitle={
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.teams.count', { count: total })}
          </p>
        }
        actions={
          <Button icon={<Plus size={15} aria-hidden="true" />} onClick={() => setCreateOpen(true)} style={{ fontSize: 14 }}>
            {t('pages.teams.new')}
          </Button>
        }
      />

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('pages.teams.new')}
        as="form"
        onSubmit={submitTeam}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={creating || form.name.trim().length === 0 || form.sourcing === '' || form.type === ''}>{creating ? t('common.creating') : t('common.create')}</Button>
          </>
        }
      >
        <div style={{ marginBottom: 14 }}>
          <FieldLabel>{t('pages.teams.name')} *</FieldLabel>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management del dialogo aperto dall'utente (Modal)
            autoFocus
            placeholder={t('pages.teams.namePlaceholder')}
          />
        </div>
        {/*
          Interno o esterno: OBBLIGATORIO, e senza una scelta preselezionata —
          «Crea» resta spento finche non si sceglie. Preselezionare «Interno»
          sarebbe decidere al posto dell'admin proprio l'informazione che
          questo campo esiste per raccogliere.
        */}
        <fieldset style={{ border: 'none', padding: 0, margin: '0 0 14px' }}>
          <legend style={{ padding: 0 }}><FieldLabel>{t('pages.teams.sourcing.label')} *</FieldLabel></legend>
          <div style={{ display: 'flex', gap: 16 }}>
            {TEAM_SOURCINGS.map((v) => (
              <label key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', cursor: 'pointer' }}>
                <input type="radio" name="team-sourcing" value={v} required
                  checked={form.sourcing === v}
                  onChange={() => setForm({ ...form, sourcing: v })} />
                {t(teamSourcingKey(v))}
              </label>
            ))}
          </div>
          <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
            {t('pages.teams.sourcing.hint')}
          </p>
        </fieldset>
        <div style={{ marginBottom: 14 }}>
          {/* Obbligatorio, e senza un valore preselezionato: come Sourcing. */}
          <FieldLabel>{t('pages.teams.type')} *</FieldLabel>
          <Select value={form.type} required onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="" disabled>{t('pages.teams.chooseType')}</option>
            {tipiTeam.map((v) => (
              <option key={v.value} value={v.value}>{v.label ?? v.value}</option>
            ))}
          </Select>
          {tipiTeam.length === 0 && (
            <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
              {t('pages.teams.noTypeVocabulary')}
            </p>
          )}
        </div>
        <div>
          <FieldLabel>{t('pages.teams.description')}</FieldLabel>
          <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
        </div>
      </Modal>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <FilterBuilder
            fields={FILTER_FIELDS}
            onApply={list.setFilterGroup}
          />
        </div>
        <ExportCsvButton
          onExport={async () => { exportToCsv('teams', COLUMNS, teams) }}
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
                icon={<UsersRound size={32} color="var(--color-slate-light)" />}
                title={t('pages.teams.noResults')}
                description={t('pages.teams.noResultsDesc')}
              />
            }
            onRowClick={(row) => navigate(`/teams/${row.id}`)}
          />

          <Pagination currentPage={list.page + 1} totalPages={totalPages} onPrev={list.prevPage} onNext={list.nextPage} />
        </>
      )}
    </PageContainer>
  )
}
