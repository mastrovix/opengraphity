import { useState, useEffect, useRef } from 'react'
import { formatDateTime } from '@/lib/datetime'
import { colors, palette, alpha, lookupOrError } from '@/lib/tokens'
import { useQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { gql } from '@apollo/client'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { ScrollText } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { Pagination } from '@/components/ui/Pagination'
import { QueryError } from '@/components/QueryError'
import { Pill } from '@/components/ui/Pill'

const GET_LOGS = gql`
  query GetLogs($limit: Int, $offset: Int, $filters: String, $sortField: String, $sortDirection: String) {
    logs(limit: $limit, offset: $offset, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total truncated windowSize
      entries {
        id timestamp level module message data
      }
    }
  }
`

const LEVEL_STYLES: Record<string, { backgroundColor: string; color: string }> = {
  trace:   { backgroundColor: colors.slateBg, color: 'var(--color-slate-light)' },
  debug:   { backgroundColor: colors.slateBg, color: 'var(--color-slate-light)' },
  info:    { backgroundColor: alpha.brand13, color: colors.brand },
  warn:    { backgroundColor: palette.orange.bg, color: 'var(--color-trigger-timer)' },
  error:   { backgroundColor: 'var(--color-danger-bg)', color: 'var(--color-trigger-sla-breach)' },
  fatal:   { backgroundColor: 'var(--color-danger-bg)', color: 'var(--color-trigger-sla-breach)' },
}

const PAGE_SIZE = 50

interface LogEntry {
  id: string
  timestamp: string
  level: string
  module: string | null
  message: string
  data: string | null
}

/**
 * Expanded-row payload. `data` is free text from the API: a non-JSON value
 * must show up as the raw line with a visible badge, not crash the render
 * (an exception here would replace the whole app with the ErrorBoundary — E-07).
 */
/**
 * I primi campi di `data` in una riga sola: «method=POST url=/ status=200».
 * Serve a distinguere due righe con lo stesso messaggio, non a sostituire il
 * dettaglio — quello si apre espandendo.
 */
function riassuntoDati(data: string | null): string {
  if (!data) return ''
  let parsed: unknown
  try { parsed = JSON.parse(data) } catch { return '' }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
  const voci = Object.entries(parsed as Record<string, unknown>)
    .filter(([, v]) => v !== null && typeof v !== 'object')
    .slice(0, 3)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
  return voci.length > 0 ? voci.join(' · ') : ''
}

function LogDataView({ data, notJsonLabel }: { data: string; notJsonLabel: string }) {
  let pretty: string | null = null
  try { pretty = JSON.stringify(JSON.parse(data), null, 2) } catch { pretty = null }
  const preStyle: React.CSSProperties = {
    margin:          0,
    padding:         12,
    backgroundColor: colors.slateBg,
    color:           'var(--color-slate-dark)',
    borderRadius:    6,
    fontSize:        11,
    overflowX:       'auto',
    whiteSpace:      'pre-wrap',
    wordBreak:       'break-all',
    border:          `1px solid ${colors.border}`,
  }
  if (pretty !== null) return <pre style={preStyle}>{pretty}</pre>
  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        <Pill bg={palette.orange.bg} color="var(--color-trigger-timer)" radius={4} style={{ fontSize: 11 }}>{notJsonLabel}</Pill>
      </div>
      <pre style={preStyle}>{data}</pre>
    </div>
  )
}

function LevelBadge({ level }: { level: string }) {
  const style = lookupOrError(LEVEL_STYLES, level, 'LEVEL_STYLES', { backgroundColor: 'var(--color-danger-bg)', color: 'var(--color-trigger-sla-breach)' })
  return (
    <Pill bg={style.backgroundColor} color={style.color} radius={4} style={{ fontSize: 11, minWidth: 46, textAlign: 'center' }}>
      {level.toUpperCase()}
    </Pill>
  )
}

/**
 * Le intestazioni della tabella passano da i18n (revisione totale · i 29
 * warning del guardiano).
 *
 * Erano quattro stringhe INGLESI scritte qui — «Timestamp», «Level»,
 * «Module», «Message» — in un elenco a livello di modulo, dove `t` non
 * arriva: un cliente italiano leggeva quattro intestazioni in inglese in
 * mezzo a una pagina tradotta. Le chiavi `pages.logs.timestamp`, `.level` e
 * `.message` esistevano, tradotte, da sempre: erano fra le chiavi «definite e
 * mai usate» che il guardiano non riusciva più a segnalare (H-23). La colonna
 * `module` non aveva nessuna chiave: si chiamava `source` fino a marzo, e la
 * sua vecchia etichetta era rimasta indietro.
 *
 * Resta una funzione di `t` invece di un elenco costante: le intestazioni
 * cambiano con la lingua di chi guarda.
 */
function logColumns(t: TFunction): ColumnDef<LogEntry>[] {
  return [
    {
      key: 'timestamp',
      label: t('pages.logs.timestamp'),
      width: '160px',
      sortable: true,
      render: (_val, row) => (
        <span style={{ color: 'var(--color-slate-light)', whiteSpace: 'nowrap' }}>
          {/* La lingua di chi guarda, come in tutta l'app (revisione totale ·
              F-12): il locale era `it-IT` cablato, quindi un utente in inglese
              vedeva le date dei log in formato italiano e diverse da ogni altra
              pagina. `formatDateTime` passa da `currentLocale()`. */}
          {formatDateTime(row.timestamp)}
        </span>
      ),
    },
    {
      key: 'level',
      label: t('pages.logs.level'),
      width: '90px',
      sortable: true,
      render: (_val, row) => <LevelBadge level={row.level} />,
    },
    {
      key: 'module',
      label: t('pages.logs.module'),
      width: '120px',
      sortable: true,
      render: (_val, row) => <span style={{ color: 'var(--color-slate-light)' }}>{row.module ?? '—'}</span>,
    },
    {
      key: 'message',
      label: t('pages.logs.message'),
      sortable: true,
      /*
       * IL MESSAGGIO PIÙ UN RIASSUNTO DEI SUOI DATI (20 set 2026, dal giro
       * nel browser): la pagina mostrava 132 righe tutte uguali — «HTTP
       * request» — mentre metodo, percorso ed esito erano lì, nel campo
       * `data`, visibili solo espandendo la riga. Una pagina di log dove
       * ogni riga dice la stessa cosa non si legge: il riassunto la rende
       * scorribile, e il dettaglio resta un clic sotto.
       */
      render: (_val, row) => (
        <span style={{ color: 'var(--color-slate-dark)' }}>
          {row.message}
          {riassuntoDati(row.data) && (
            <span style={{ color: 'var(--color-slate-light)', marginLeft: 8 }}>{riassuntoDati(row.data)}</span>
          )}
        </span>
      ),
    },
  ]
}


export function LogsPage() {
  const { t } = useTranslation()
  const LOG_COLUMNS = logColumns(t)

  const LOGS_FILTER_FIELDS: FieldConfig[] = [
    { key: 'message',   label: t('pages.logs.filterMessage'), type: 'text' },
    /**
     * I livelli e i moduli restano in INGLESE: sono i valori che il logger
     * scrive nel record (`level: 'error'`, `module: 'frontend'`), non una
     * descrizione — e la colonna «Livello» li mostra grezzi in maiuscolo
     * (`LevelBadge`), quindi tradurre qui vorrebbe dire filtrare per
     * «Errore» e leggere «ERROR» nella riga accanto. Regola delle parole
     * tecniche: si traduce ciò che descrive, resta inglese ciò che nomina.
     */
    { key: 'level',     label: t('pages.logs.filterLevel'),   type: 'enum', options: [
      { value: 'trace', label: 'Trace' },
      { value: 'debug', label: 'Debug' },
      { value: 'info',  label: 'Info'  },
      { value: 'warn',  label: 'Warn'  },
      { value: 'error', label: 'Error' },
      { value: 'fatal', label: 'Fatal' },
    ]},
    { key: 'module',    label: t('pages.logs.filterModule'),  type: 'enum', options: [
      { value: 'http',         label: 'HTTP' },
      { value: 'graphql',      label: 'GraphQL' },
      { value: 'auth',         label: 'Auth' },
      { value: 'workflow',     label: 'Workflow' },
      { value: 'notification', label: 'Notification' },
      { value: 'frontend',     label: 'Frontend' },
    ]},
    { key: 'timestamp', label: t('pages.logs.filterDate'),    type: 'date' },
  ]
  const [offset,      setOffset]      = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [expandedId,  setExpandedId]  = useState<string | null>(null)
  const [sortField,   setSortField]   = useState<string | null>(null)
  const [sortDir,     setSortDir]     = useState<'asc' | 'desc'>('desc')

  // `error` va letto: un filtro rifiutato lasciava la pagina vuota senza dire
  // niente (revisione totale · F-11).
  const { data, loading, error, refetch } = useQuery<{ logs: { entries: LogEntry[]; total: number; truncated: boolean; windowSize: number } }>(GET_LOGS, {
    variables: {
      limit:   PAGE_SIZE,
      offset,
      filters:       filterGroup ? JSON.stringify(filterGroup) : null,
      sortField:     sortField ?? 'timestamp',
      sortDirection: sortDir,
    },
    fetchPolicy: 'network-only',
  })

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => { void refetch() }, 10_000)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [autoRefresh, refetch])

  const entries: LogEntry[] = data?.logs.entries ?? []
  const total:   number     = data?.logs.total   ?? 0
  /* La lista è una FINESTRA sulle righe più recenti: quando l'archivio è più
     grande, i filtri cercano dentro la finestra e non in tutto. Dirlo è la
     differenza fra «non c'è» e «non l'ho guardato». */
  const truncated  = data?.logs.truncated  ?? false
  const windowSize = data?.logs.windowSize ?? 0
  const totalPages  = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<ScrollText size={22} color="var(--color-icon-accent)" />}>
          {t('pages.logs.title')}
        </PageTitle>
        <p style={{ color: 'var(--color-slate-dark)', fontSize: 'var(--font-size-body)', margin: '4px 0 0' }}>
          {loading ? '—' : total > 0 ? t('pages.logs.count', { count: total }) : t('common.noResults')}
        </p>
        {!loading && truncated && (
          <p style={{ color: 'var(--color-slate-dark)', fontSize: 'var(--font-size-caption)', margin: '4px 0 0' }}>
            {t('pages.logs.window', { count: windowSize })}
          </p>
        )}
      </div>

      {/* Advanced Filters + controls */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <FilterBuilder
            fields={LOGS_FILTER_FIELDS}
            onApply={(group) => { setFilterGroup(group); setOffset(0) }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 2 }}>
          <button type="button"
            onClick={() => void refetch()}
            style={{
              height: 32, padding: '0 14px', borderRadius: 6,
              border: '1px solid var(--border)', background: colors.white,
              fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', cursor: 'pointer',
            }}
          >
            {t('pages.logs.refresh')}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            {t('pages.logs.autoRefresh')}
          </label>
        </div>
      </div>

      {error && <QueryError message={error.message} onRetry={() => void refetch()} />}

      {/* Table */}
      <SortableFilterTable<LogEntry>
        columns={LOG_COLUMNS}
        data={entries}
        loading={loading}
        sortField={sortField}
        sortDir={sortDir}
        onSort={(field, dir) => { setSortField(field); setSortDir(dir); setOffset(0) }}
        expandedRowId={expandedId}
        onRowClick={(entry) => {
          if (entry.data && entry.data !== '{}') {
            setExpandedId(prev => prev === entry.id ? null : entry.id)
          }
        }}
        renderExpandedRow={(entry) => entry.data
          ? <LogDataView data={entry.data} notJsonLabel={t('pages.logs.notJson')} />
          : null}
      />

      {/* Pagination */}
      <Pagination currentPage={currentPage} totalPages={totalPages} onPrev={() => setOffset(o => o - PAGE_SIZE)} onNext={() => setOffset(o => o + PAGE_SIZE)} />
    </PageContainer>
  )
}
