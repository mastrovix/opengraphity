import { Button } from '@/components/Button'
import { useState, useEffect, useId } from 'react'
import { useQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Server } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { StatusBadge } from '@/components/StatusBadge'
import { EnvBadge } from '@/components/Badges'
import { EmptyState } from '@/components/EmptyState'
import { QueryError } from '@/components/QueryError'
import { Select } from '@/components/ui/FormControls'
import { GET_ALL_CIS } from '@/graphql/queries'
import { FilterBuilder, type FilterGroup, type FilterRule, type FieldConfig } from '@/components/FilterBuilder'
import { CIHealthBadge } from '@/pages/events/eventShared'
import { CI_HEALTHS, type CIHealth } from '@/types/events'
import { Pagination } from '@/components/ui/Pagination'
import { formatDate } from '@/lib/datetime'
import { toEnumOptions, useCIBaseEnums } from '@/lib/ciEnums'
import { useCILabels, CI_STATUS_VOCABULARY, CI_ENVIRONMENT_VOCABULARY } from '@/hooks/useCILabels'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useMetamodel } from '@/contexts/MetamodelContext'

interface CI {
  id:          string
  name:        string
  type:        string
  status:      string
  environment: string
  createdAt:   string
  /** Salute dal monitoraggio (Event Management): null = mai toccato da un allarme. */
  health:      CIHealth | null
}

/**
 * Filtro sulla salute letto dall'URL (`?health=none` dalla pagina Salute CI,
 * riquadro "Senza monitoraggio"; `?health=down|degraded|operational` dai
 * link per stato). Id fisso: la regola è ricostruibile e confrontabile.
 */
export function healthRuleFromParam(value: string | null): FilterRule | null {
  if (!value) return null
  if (value === 'none') return { id: 'url-health', field: 'health', operator: 'is_empty', value: null, logic: 'AND' }
  if ((CI_HEALTHS as readonly string[]).includes(value)) return { id: 'url-health', field: 'health', operator: 'equals', value, logic: 'AND' }
  // Valore scritto a mano nell'URL: si ignora (non è un errore dell'app), come per gli altri parametri.
  return null
}


const PAGE_SIZE = 50

export function CMDBPage() {
  const { t } = useTranslation()
  const baseEnums = useCIBaseEnums()
  // F-23: etichette dei tipi e degli ambienti dal metamodello e dal Dizionario.
  const ciLabels = useCILabels()
  const { labelOf } = useDomainVocabularies()
  const { ciTypes } = useMetamodel()
  const idTipo = useId()

  const columns: ColumnDef<CI>[] = [
    { key: 'name', label: t('pages.cmdb.name'), sortable: true },
    {
      key:      'type',
      label:    t('pages.cmdb.type'),
      width:    '160px',
      sortable: true,
      // L'ETICHETTA del tipo, non il nome tecnico «umanizzato» (revisione
      // totale · F-23): un tipo `sap_hana_db` con etichetta «SAP HANA»
      // diventava «Sap hana db».
      render:   (v) => (
        <span style={{ color: "var(--color-slate)" }}>
          {ciLabels.typeLabel(String(v))}
        </span>
      ),
    },
    {
      key:      'status',
      label:    t('pages.cmdb.status'),
      width:    '130px',
      sortable: true,
      render:   (v) => <StatusBadge value={String(v)} />,
    },
    {
      key:      'environment',
      label:    t('pages.cmdb.environment'),
      width:    '140px',
      sortable: true,
      render:   (v) => <EnvBadge environment={v as string | null} />,
    },
    {
      key:      'health',
      label:    t('pages.cmdb.health'),
      width:    '110px',
      // Ordinabile per GRAVITÀ (20 set 2026, dal giro nel browser): era
      // l'unica colonna senza ordinamento, ed è quella per cui si apre la
      // CMDB. L'ordine è down → degraded → operational → non monitorati
      // (`CI_HEALTH_ORDER_EXPR` nell'API), non alfabetico.
      sortable: true,
      render:   (v) => (v ? <CIHealthBadge health={v as CIHealth} compact /> : <span style={{ color: 'var(--color-text-disabled)' }}>—</span>),
    },
    {
      key:      'createdAt',
      label:    t('pages.cmdb.createdAt'),
      width:    '120px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: "var(--color-slate-light)" }}>
          {formatDate(String(v))}
        </span>
      ),
    },
  ]

  // Status/environment dal tipo base del metamodello (unica sorgente, F-23)
  const FILTER_FIELDS: FieldConfig[] = [
    { key: 'name',        label: t('pages.cmdb.name'),        type: 'text' },
    // D29: the Dictionary label, or the value humanized by the one shared rule.
    { key: 'status',      label: t('pages.cmdb.status'),      type: 'enum', options: toEnumOptions(baseEnums.statuses, (v) => labelOf(CI_STATUS_VOCABULARY, v)) },
    { key: 'environment', label: t('pages.cmdb.environment'), type: 'enum', options: toEnumOptions(baseEnums.environments, (v) => labelOf(CI_ENVIRONMENT_VOCABULARY, v)) },
    { key: 'createdAt',   label: t('pages.cmdb.createdAt'),   type: 'date' },
    { key: 'health',      label: t('pages.cmdb.health'),      type: 'enum', options: CI_HEALTHS.map((h) => ({ value: h, label: t(`events.health.${h}`) })) },
  ]
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const typeFromUrl = searchParams.get('type')
  const healthRule = healthRuleFromParam(searchParams.get('health'))

  // F-23: il titolo è l'etichetta del tipo scelta dal cliente.
  const pageTitle = typeFromUrl ? ciLabels.typeLabel(typeFromUrl) : t('sidebar.cmdb')

  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(healthRule ? { rules: [healthRule] } : null)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  useEffect(() => {
    setPage(0)
  }, [typeFromUrl])

  const handleSort = (field: string, dir: 'asc' | 'desc') => {
    setSortField(field); setSortDir(dir); setPage(0)
  }

  // `error` va letto: senza, un filtro rifiutato dall'API lasciava la pagina a
  // «nessun CI» e l'utente credeva che il filtro non avesse risultati
  // (revisione totale · F-11).
  const { data, loading, error, refetch } = useQuery<{
    allCIs: { items: CI[]; total: number }
  }>(GET_ALL_CIS, {
    variables: {
      limit:         PAGE_SIZE,
      offset:        page * PAGE_SIZE,
      type:          typeFromUrl || undefined,
      filters:       filterGroup ? JSON.stringify(filterGroup) : null,
      sortField,
      sortDirection: sortDir,
    },
    fetchPolicy: 'cache-and-network',
  })

  const items = data?.allCIs?.items ?? []
  const total = data?.allCIs?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<Server size={22} color="var(--color-icon-accent)" />}>
            {pageTitle}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.cmdb.count', { count: total })}
          </p>
        </div>
        {/* La creazione richiede un tipo CI (form dinamica per tipo): con un
            tipo in URL si va alla sua lista, altrimenti nessun bottone morto. */}
        {typeFromUrl && (
          <Button variant="primary"
            onClick={() => navigate(`/ci/${typeFromUrl}`)}
          >
            {t('common.create')}
          </Button>
        )}
      </div>

      {baseEnums.error && <QueryError message={`${t('pages.cmdb.baseEnumsUnavailable')}: ${baseEnums.error}`} />}
      {error && <QueryError message={error.message} onRetry={() => void refetch()} />}

      {/*
        * SCEGLIERE IL TIPO (20 set 2026, dal giro nel browser): la CMDB ha la
        * colonna «Tipo» e la si può ordinare, ma non c'era modo di dire
        * «mostrami solo i Server» — la domanda più ovvia che si fa a una
        * CMDB. Sta qui e non fra i filtri avanzati perché il tipo di un CI è
        * la sua ETICHETTA nel grafo, non una proprietà: il filtro avanzato
        * avrebbe cercato `n.type`, che non esiste, e non avrebbe trovato mai
        * niente in silenzio. La strada che funziona c'è già ed è il tipo
        * nell'indirizzo, la stessa che usa il menu della CMDB.
        */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <label htmlFor={idTipo} style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{t('pages.cmdb.type')}</label>
        <Select
          id={idTipo}
          value={typeFromUrl ?? ''}
          onChange={(e) => { navigate(e.target.value ? `/cmdb?type=${e.target.value}` : '/cmdb') }}
          style={{ width: 220 }}
        >
          <option value="">{t('pages.cmdb.allTypes')}</option>
          {ciTypes.filter((ct) => ct.active && ct.name !== '__base__').map((ct) => (
            <option key={ct.name} value={ct.name}>{ciLabels.typeLabel(ct.name)}</option>
          ))}
        </Select>
      </div>

      <FilterBuilder
        fields={FILTER_FIELDS}
        initialRules={healthRule ? [healthRule] : undefined}
        onApply={(group) => { setFilterGroup(group); setPage(0) }}
      />

      <SortableFilterTable<CI>
        columns={columns}
        data={items}
        loading={loading}
        emptyComponent={<EmptyState icon={<Server size={32} />} title={t('pages.cmdb.noResults')} description={t('pages.cmdb.noResultsDesc')} />}
        onSort={handleSort}
        sortField={sortField}
        sortDir={sortDir}
        onRowClick={(row) => navigate(`/ci/${row.type}/${row.id}`)}
      />

      <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
    </PageContainer>
  )
}
