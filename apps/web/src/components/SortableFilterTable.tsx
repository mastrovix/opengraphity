import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { SkeletonLine } from '@/components/SkeletonLoader'
import { colors, palette } from '@/lib/tokens'
import { keyActivate } from '@/lib/a11y'

export interface ColumnDef<T> {
  key:      keyof T
  label:    string
  /**
   * Every column sorts (26 Sep 2026, the owner: «le colonne dovrebbero essere
   * sempre tutte ordinabili»). `false` only for a column that holds nothing
   * but buttons (edit, delete): `__tests__/sortableColumns.test.ts` keeps the list.
   */
  sortable?: boolean
  /**
   * What the column sorts on, when its raw value is not it: a label shown in
   * place of a code, a name inside an object, a count of a list. Client-side
   * sorting only: a server-sorted table sends the column's key.
   */
  sortValue?: (row: T) => unknown
  width?:   string
  render?:  (value: unknown, row: T) => React.ReactNode
  /**
   * La SCALA della colonna, dal valore piu grave al meno grave (revisione
   * totale · G-EVT-7). Quando c'e, l'ordinamento la segue invece di confrontare
   * il testo: «severita crescente» dava critical, info, warning.
   * Va dichiarata colonna per colonna, mai indovinata dal nome: «resolved» e
   * uno stato degli eventi ma anche uno stato dei ticket, e le due scale non
   * hanno lo stesso ordine.
   */
  rank?:    readonly string[]
  /**
   * `end`: the column stays in view at the right edge while the table scrolls
   * sideways inside its container (D36, tour of 23 Sep 2026: on the alarms
   * console the table was 1284px wide in a 1057px container and the actions
   * were out of view). Only the LAST column can be sticky: a single column
   * pinned at `right: 0` needs no offset to guess.
   */
  sticky?:  'end'
}

const getRawValue = (row: object, key: string): unknown => (row as Record<string, unknown>)[key]

/**
 * The key of the column pinned at the right edge, or null. A sticky column
 * that is not the last one is a mistake of the caller: it is said, and the
 * table stays a plain table instead of pinning the wrong column.
 */
function stickyEndKey<T>(columns: ColumnDef<T>[]): string | null {
  const last = columns.at(-1)
  const misplaced = columns.slice(0, -1).filter((c) => c.sticky === 'end')
  if (misplaced.length > 0) {
    console.error(`[SortableFilterTable] only the last column can be sticky: ${misplaced.map((c) => String(c.key)).join(', ')}`)
  }
  return last?.sticky === 'end' ? String(last.key) : null
}

/** Pinned at the right edge, opaque so that what scrolls underneath does not show through. */
const STICKY_END_CELL: React.CSSProperties = {
  position:        'sticky',
  right:           0,
  zIndex:          1,
  backgroundColor: colors.white,
  boxShadow:       'inset 1px 0 0 var(--color-border)',
}

/**
 * Valore su cui si ordina: per un oggetto con `name` (CI, sorgente, squadra) è
 * il nome, non `[object Object]`; per una lista, quanti elementi ha.
 */
function getSortValue(row: object, key: string): unknown {
  const v = getRawValue(row, key)
  if (Array.isArray(v)) return v.length
  if (v && typeof v === 'object' && 'name' in v) return (v as { name: string }).name
  return v
}

function rankOf(value: unknown, scale?: readonly string[]): number | null {
  if (!scale) return null
  const i = scale.indexOf(String(value))
  return i === -1 ? null : i
}

/**
 * L'ordinamento lato client della tabella, esportato perché una pagina che
 * tiene l'ordinamento nell'URL (modalità «controllata») deve ordinare le righe
 * con la STESSA regola con cui le ordinerebbe la tabella: null in fondo,
 * confronto testuale con i numeri in ordine numerico, o la `rank` della
 * colonna quando quella colonna e una scala. Non muta `rows`.
 */
export function sortRowsBy<T extends object>(
  rows: T[], key: string, dir: 'asc' | 'desc', rank?: readonly string[], sortValue?: (row: T) => unknown,
): T[] {
  const valueOf = (row: T) => (sortValue ? sortValue(row) : getSortValue(row, key))
  return [...rows].sort((a, b) => {
    const av = valueOf(a)
    const bv = valueOf(b)
    if (av == null) return 1
    if (bv == null) return -1
    const ar = rankOf(av, rank)
    const br = rankOf(bv, rank)
    // Un valore fuori scala (aggiunto a mano, arrivato da un import) va in
    // fondo invece di mescolarsi: si vede che non è della scala.
    const cmp = ar !== null || br !== null
      ? (ar ?? Number.MAX_SAFE_INTEGER) - (br ?? Number.MAX_SAFE_INTEGER)
      : String(av).localeCompare(String(bv), undefined, { numeric: true })
    return dir === 'asc' ? cmp : -cmp
  })
}

interface Props<T> {
  columns:         ColumnDef<T>[]
  data:            T[]
  onRowClick?:     (row: T) => void
  loading?:        boolean
  emptyMessage?:   string
  emptyComponent?: React.ReactNode
  /** Server-side sort: when provided, sorting is delegated to the caller */
  onSort?:         (field: string, direction: 'asc' | 'desc') => void
  sortField?:      string | null
  sortDir?:        'asc' | 'desc'
  /**
   * Frase che dice DOVE vale l'ordinamento, nel `title` delle intestazioni
   * ordinabili (D·2.8): una lista paginata il cui server non ordina riordina
   * solo la pagina caricata, e una colonna «ordinata» che non lo è su tutto il
   * risultato inganna. Omesso = nessuna precisazione (l'ordinamento è del server).
   */
  sortHint?:       string
  label?:          string  // aria-label per la tabella
  /** If provided, renders an expanded row below the row whose id matches expandedRowId */
  expandedRowId?:  string | null
  renderExpandedRow?: (row: T) => React.ReactNode | null
  /** Row selection: adds a leading checkbox column. Rows must have `id: string`. */
  selectable?:     boolean
  selectedIds?:    Set<string>
  onToggleRow?:    (id: string) => void
  /** Called with the ids of the currently rendered rows (page-level select-all). */
  onToggleAll?:    (ids: string[]) => void
  /**
   * Righe cliccabili raggiungibili da tastiera (tabIndex=0, Enter/Spazio).
   * Passare `false` quando ogni riga contiene già un `<Link>` alla stessa
   * destinazione di `onRowClick`: una <tr> focalizzabile non annuncia di
   * essere un link e raddoppia le tappe di tabulazione; il focus va al Link.
   */
  focusableRows?:  boolean
}

const thStyle: React.CSSProperties = {
  // Tinta del turchese (20 %) invece del grigio freddo: l'intestazione della
  // tabella appartiene alla stessa famiglia di quella delle sezioni (32 %), un
  // gradino sotto. NON scendere sotto: l'8 % su bianco dà (235, 245, 251), a
  // occhio identico al grigio di prima (241, 245, 249) — cambiava il token,
  // non il colore.
  background:    'var(--color-brand-a20)',
  borderBottom:  `2px solid ${colors.border}`,
  padding:       '8px 12px 6px',
  textAlign:     'left',
  whiteSpace:    'nowrap',
  userSelect:    'none',
  boxSizing:     'border-box',
}

export function SortableFilterTable<T extends object>({
  columns,
  data,
  onRowClick,
  loading = false,
  emptyMessage,
  emptyComponent,
  onSort,
  sortField: controlledSortField,
  sortDir: controlledSortDir,
  sortHint,
  label,
  expandedRowId,
  renderExpandedRow,
  selectable = false,
  selectedIds,
  onToggleRow,
  onToggleAll,
  focusableRows = true,
}: Props<T>) {
  const { t } = useTranslation()
  const resolvedEmptyMessage = emptyMessage ?? t('common.noResults')

  // Uncontrolled (client-side) sort state — only used when onSort is not provided
  const [localSortKey, setLocalSortKey] = useState<keyof T | null>(null)
  const [localSortDir, setLocalSortDir] = useState<'asc' | 'desc'>('asc')

  const isControlled = onSort != null
  const activeSortKey = isControlled ? controlledSortField ?? null : localSortKey ? String(localSortKey) : null
  const activeSortDir = isControlled ? (controlledSortDir ?? 'asc') : localSortDir

  const handleSort = (key: keyof T) => {
    const keyStr = String(key)
    if (isControlled) {
      const newDir = activeSortKey === keyStr && activeSortDir === 'asc' ? 'desc' : 'asc'
      onSort(keyStr, newDir)
    } else {
      if (localSortKey === key) {
        setLocalSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      } else {
        setLocalSortKey(key)
        setLocalSortDir('asc')
      }
    }
  }

  const getRawVal = (row: T, key: keyof T): unknown => getRawValue(row, String(key))

  // Only sort client-side when in uncontrolled mode
  const sorted = isControlled || localSortKey == null
    ? data
    : sortRowsBy(
        data, String(localSortKey), localSortDir,
        columns.find((c) => c.key === localSortKey)?.rank,
        columns.find((c) => c.key === localSortKey)?.sortValue,
      )

  const rowIds = selectable
    ? sorted.map((row, i) => String((row as Record<string, unknown>)['id'] ?? i))
    : []
  const selectedOnPage = rowIds.filter((id) => selectedIds?.has(id)).length
  const allSelected  = rowIds.length > 0 && selectedOnPage === rowIds.length
  const someSelected = selectedOnPage > 0 && !allSelected

  const checkboxStyle: React.CSSProperties = {
    accentColor: 'var(--color-brand)',
    width:       15,
    height:      15,
    margin:      0,
    display:     'block',
    cursor:      'pointer',
  }

  const totalCols = columns.length + (selectable ? 1 : 0)
  const stickyKey = stickyEndKey(columns)
  const stickyCell = (key: keyof T): React.CSSProperties => (String(key) === stickyKey ? STICKY_END_CELL : {})

  return (
    <div className="og-table-card og-scroll-x">
      <table role="table" aria-label={label} style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
        <colgroup>
          {selectable && <col style={{ width: '40px' }} />}
          {columns.map((col) => (
            <col key={String(col.key)} style={{ width: col.width }} />
          ))}
        </colgroup>

        <thead>
          <tr>
            {selectable && (
              <th scope="col" style={{ ...thStyle, padding: '8px 0 6px 12px' }}>
                <input
                  type="checkbox"
                  aria-label={t('bulk.selectAll')}
                  style={checkboxStyle}
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected }}
                  onChange={() => onToggleAll?.(rowIds)}
                />
              </th>
            )}
            {columns.map((col) => {
              const isActive = activeSortKey === String(col.key)
              return (
                <th
                  key={String(col.key)}
                  scope="col"
                  aria-sort={col.sortable !== false
                    ? (activeSortKey === String(col.key)
                        ? activeSortDir === 'asc' ? 'ascending' : 'descending'
                        : 'none')
                    : undefined}
                  // The tint of the header comes from index.css; the sticky one needs an opaque variant there too.
                  className={String(col.key) === stickyKey ? 'sft-sticky-end' : undefined}
                  style={{ ...thStyle, ...stickyCell(col.key) }}
                >
                  {/* Sortable headers are real buttons (keyboard + screen reader); static ones stay plain text (E-14). */}
                  {col.sortable !== false ? (
                    <button
                      type="button"
                      onClick={() => handleSort(col.key)}
                      title={sortHint}
                      style={{
                        // `font` PRIMA delle dichiarazioni specifiche: è una
                        // scorciatoia e azzera quel che viene prima di lei —
                        // messa in fondo cancellava corpo e peso, e
                        // l'intestazione ordinabile restava più smorta di
                        // quella fissa.
                        font:          'inherit',
                        display:       'flex',
                        alignItems:    'center',
                        gap:           4,
                        fontSize:      11,
                        fontWeight:    600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        color:         isActive ? colors.brand : colors.slateDark,
                        cursor:        'pointer',
                        background:    'none',
                        border:        'none',
                        padding:       0,
                      }}
                    >
                      {col.label}
                      <span style={{ opacity: isActive ? 1 : 0.3, color: isActive ? colors.brand : colors.slateDark, display: 'flex' }}>
                        {isActive && activeSortDir === 'asc' ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
                      </span>
                    </button>
                  ) : (
                    <div
                      style={{
                        display:       'flex',
                        alignItems:    'center',
                        gap:           4,
                        fontSize:      11,
                        fontWeight:    600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        color:         colors.slateDark,
                      }}
                    >
                      {col.label}
                    </div>
                  )}
                </th>
              )
            })}
          </tr>
        </thead>

        <tbody>
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                {selectable && <td style={{ padding: '12px 0 12px 12px', borderBottom: `1px solid ${palette.neutral.borderLight}` }} />}
                {columns.map((col, ci) => (
                  <td key={String(col.key)} style={{ padding: '12px', borderBottom: `1px solid ${palette.neutral.borderLight}`, ...stickyCell(col.key) }}>
                    <SkeletonLine width={ci === 0 ? '80%' : ci % 2 === 0 ? '60%' : '70%'} />
                  </td>
                ))}
              </tr>
            ))
          ) : sorted.length === 0 ? (
            <tr>
              <td colSpan={totalCols}>
                {emptyComponent ?? (
                  <div style={{ textAlign: 'center', color: colors.slateLight, padding: '40px 20px', fontSize: 'var(--font-size-body)' }}>
                    {resolvedEmptyMessage}
                  </div>
                )}
              </td>
            </tr>
          ) : (
            sorted.map((row, i) => {
              const rowId = String((row as Record<string, unknown>)['id'] ?? i)
              const isExpanded = expandedRowId != null && rowId === expandedRowId && renderExpandedRow != null
              const expandedContent = isExpanded ? renderExpandedRow(row) : null
              return (
                <React.Fragment key={rowId}>
                  <tr
                    /*
                      Un clic su un CONTROLLO dentro la riga (pulsante, link,
                      interruttore, tendina) e del controllo, non della riga:
                      senza questo, spegnere una policy o premere «Elimina»
                      apriva anche il dettaglio. Qui una volta sola, invece di
                      un `stopPropagation` da ricordarsi in ogni pagina.
                    */
                    onClick={(e) => {
                      if (!onRowClick) return
                      const controllo = (e.target as HTMLElement).closest('button, a, input, select, textarea, label, [role="switch"]')
                      if (controllo && e.currentTarget.contains(controllo)) return
                      onRowClick(row)
                    }}
                    // Clickable rows are reachable and activatable from the keyboard (E-14),
                    // unless the caller says the row already carries a Link (`focusableRows`).
                    tabIndex={onRowClick && focusableRows ? 0 : undefined}
                    onKeyDown={onRowClick ? keyActivate(() => onRowClick(row)) : undefined}
                    /*
                      La striscia turchese al passaggio del mouse NON e un
                      bordo della riga. Lo era (`border-left: 8px transparent`),
                      e con `border-collapse: collapse` la tabella riservava
                      meta di quel bordo — 4px — a sinistra di OGNI riga,
                      testata compresa: la testata non ha il bordo, quindi i
                      4px restavano bianchi prima della tinta. Ora e un'ombra
                      interna della prima cella (`.sft-row`, index.css), che
                      nel calcolo della tabella non occupa spazio.
                    */
                    className={onRowClick ? 'sft-row row-opens' : 'sft-row'}
                    style={{
                      borderBottom:    expandedContent ? 'none' : `1px solid ${palette.neutral.borderLight}`,
                      cursor:          onRowClick ? 'pointer' : 'default',
                      backgroundColor: colors.white,
                    }}
                  >
                    {selectable && (
                      <td
                        className="sft-td"
                        style={{ padding: '11px 0 11px 12px', verticalAlign: 'middle' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          aria-label={t('bulk.selectRow')}
                          style={checkboxStyle}
                          checked={selectedIds?.has(rowId) ?? false}
                          onChange={() => onToggleRow?.(rowId)}
                        />
                      </td>
                    )}
                    {columns.map((col) => (
                      <td
                        key={String(col.key)}
                        className="sft-td"
                        style={{ padding: '11px 12px', verticalAlign: 'middle', ...stickyCell(col.key) }}
                      >
                        {col.render
                          ? col.render(getRawVal(row, col.key), row)
                          : String(getRawVal(row, col.key) ?? '')
                        }
                      </td>
                    ))}
                  </tr>
                  {expandedContent && (
                    <tr style={{ backgroundColor: colors.white }}>
                      <td colSpan={totalCols} style={{ padding: 0 }}>
                        {expandedContent}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
