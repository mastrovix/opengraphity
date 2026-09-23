/**
 * A CHOICE AMONG HUNDREDS, WITH A SEARCH BOX (D10 / D21 / D34, tour of 23 Sep 2026).
 *
 * The choices that grew with the tenant were plain `<select>`s: the incident
 * «Team» listed all 501 teams, the change «Change owner» all 3,001 people, the
 * CI owner and support groups 200 and 300 teams, cut to the width of the box
 * («OWN_Controlling Platform Own»). A select cannot be searched, and scrolling
 * five hundred names to find one is not a choice.
 *
 * This is the one picker for that: a combobox that filters as one types,
 * shows full names (they wrap, they are never cut), says how many more there
 * are when the list is capped, and says it when the choices could not be
 * loaded — an empty list would look like «there is nothing to choose».
 *
 * Which candidates to offer is NOT decided here: `TeamPicker` and `UserPicker`
 * (components/pickers) filter by team type or permission and pass the list.
 *
 * Keyboard: arrows move, Enter chooses, Escape closes. The options take the
 * mouse on `mousedown`, so the box does not lose focus before the choice.
 */
import { useId, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { alpha, colors, palette } from '@/lib/tokens'
import { controlStyle } from '@/components/ui/FormControls'

export interface PickerOption {
  id:      string
  label:   string
  /** A second line (an email, a type): tells two equal names apart. */
  detail?: string | null
}

export interface SearchPickerProps {
  /** Accessible name of the box; with `inputId`, a `<label htmlFor>` outside can give it too. */
  label:        string
  inputId?:     string
  options:      readonly PickerOption[]
  /** The current choice. It may be outside `options`: it is shown anyway. */
  value:        PickerOption | null
  onChange:     (option: PickerOption | null) => void
  placeholder?: string
  /** A first choice that empties the value («— not assigned —»); without it the value cannot be emptied here. */
  clearLabel?:  string
  disabled?:    boolean
  loading?:     boolean
  /** The choices could not be loaded: said in the list, not shown as an empty list. */
  error?:       string | null
  /** Under the box: which candidates these are, and a way to widen them. */
  hint?:        ReactNode
  /** A required choice that is missing: the box says it with its border. */
  invalid?:     boolean
  /** How many matches the list shows (default 50): the rest is reached by typing. */
  maxResults?:  number
  /** Pinpoint overrides for the box (a page whose inputs are taller). */
  style?:       CSSProperties
  /**
   * What the user types, for a parent that searches on the SERVER (the
   * people pickers): `options` are then already the matches. Told again with
   * `''` when the list closes.
   */
  onQueryChange?: (query: string) => void
}

/** Case-insensitive search on the label and the second line; at most `max` shown. */
export function matchOptions(options: readonly PickerOption[], query: string, max: number): { shown: PickerOption[]; more: number } {
  const q = query.trim().toLocaleLowerCase()
  const hits = q === ''
    ? [...options]
    : options.filter((o) => o.label.toLocaleLowerCase().includes(q) || (o.detail ?? '').toLocaleLowerCase().includes(q))
  return { shown: hits.slice(0, max), more: Math.max(0, hits.length - max) }
}

/** The rows of the open list: the «empty the value» choice first, when there is one. */
type Row = { kind: 'clear'; id: string } | { kind: 'option'; id: string; option: PickerOption }

function listRows(shown: readonly PickerOption[], clearLabel: string | undefined, baseId: string): Row[] {
  const rows: Row[] = clearLabel ? [{ kind: 'clear', id: `${baseId}-clear` }] : []
  return [...rows, ...shown.map((o, i) => ({ kind: 'option' as const, id: `${baseId}-opt-${String(i)}`, option: o }))]
}

const listStyle: CSSProperties = {
  position: 'absolute', left: 0, top: '100%', marginTop: 4, zIndex: 30,
  width: '100%', minWidth: 280, maxHeight: 280, overflowY: 'auto', boxSizing: 'border-box',
  background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8,
  boxShadow: `0 4px 12px ${alpha.black10}`, margin: 0, padding: 0, listStyle: 'none',
}

const rowStyle = (active: boolean): CSSProperties => ({
  padding: '7px 12px', cursor: 'pointer', fontSize: 'var(--font-size-body)',
  // Full names: they wrap, they are never cut.
  whiteSpace: 'normal', overflowWrap: 'anywhere',
  background: active ? palette.info.light : 'transparent',
  borderBottom: `1px solid ${palette.neutral.borderLight}`,
})

const noteStyle: CSSProperties = { padding: '8px 12px', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }

function useKeyboard(rows: Row[], open: boolean, setOpen: (o: boolean) => void, choose: (r: Row) => void, close: () => void) {
  const [active, setActive] = useState(-1)
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, rows.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); return }
    if (e.key === 'Escape') { if (open) { e.preventDefault(); close() } return }
    if (e.key === 'Enter' && open) {
      // Enter inside a form must not submit it while the list is open.
      e.preventDefault()
      const row = rows[active]
      if (row) choose(row)
    }
  }
  return { active, setActive, onKeyDown }
}

export function SearchPicker({
  label, inputId, options, value, onChange, placeholder, clearLabel, disabled = false,
  loading = false, error = null, hint, invalid = false, maxResults = 50, style, onQueryChange,
}: SearchPickerProps) {
  const { t } = useTranslation()
  const baseId = useId()
  const listId = `${baseId}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { shown, more } = useMemo(() => matchOptions(options, query, maxResults), [options, query, maxResults])
  const rows = useMemo(() => listRows(shown, clearLabel, baseId), [shown, clearLabel, baseId])
  const search = (q: string) => { setQuery(q); onQueryChange?.(q) }
  const close = () => { setOpen(false); search('') }
  const choose = (row: Row) => { onChange(row.kind === 'clear' ? null : row.option); close() }
  const { active, setActive, onKeyDown } = useKeyboard(rows, open, setOpen, choose, close)
  const activeId = open ? rows[active]?.id : undefined

  return (
    <div style={{ position: 'relative' }}>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        autoComplete="off"
        // While open the box holds the search; closed, it shows the choice in full.
        value={open ? query : (value?.label ?? '')}
        placeholder={open ? (value?.label ?? placeholder ?? t('pickers.searchPlaceholder')) : (placeholder ?? t('pickers.searchPlaceholder'))}
        title={value?.label}
        onChange={(e) => { search(e.target.value); setOpen(true); setActive(-1) }}
        onFocus={() => { setOpen(true); setActive(-1) }}
        // After a choice the box keeps the focus: a click must reopen the list.
        onClick={() => { if (!open) { setOpen(true); setActive(-1) } }}
        onBlur={close}
        onKeyDown={onKeyDown}
        style={{ ...controlStyle, ...(invalid ? { borderColor: palette.warning.border } : {}), ...style }}
      />
      {open && !disabled && (
        <ul id={listId} role="listbox" aria-label={label} style={listStyle}>
          {loading && <li role="presentation" style={noteStyle}>{t('common.loading')}</li>}
          {error !== null && <li role="presentation" style={{ ...noteStyle, color: 'var(--color-danger)' }}>{t('pickers.loadFailed', { error })}</li>}
          {rows.map((row, i) => (
            <li
              key={row.id}
              id={row.id}
              role="option"
              tabIndex={-1}
              aria-selected={row.kind === 'option' && row.option.id === value?.id}
              onMouseDown={(e) => { e.preventDefault(); choose(row) }}
              onMouseEnter={() => setActive(i)}
              style={rowStyle(i === active)}
            >
              {row.kind === 'clear' ? <span style={{ color: 'var(--color-slate)' }}>{clearLabel}</span> : (
                <>
                  <span style={{ fontWeight: row.option.id === value?.id ? 600 : 500, color: 'var(--color-slate-dark)' }}>{row.option.label}</span>
                  {row.option.detail && <span style={{ display: 'block', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>{row.option.detail}</span>}
                </>
              )}
            </li>
          ))}
          {!loading && error === null && shown.length === 0 && (
            <li role="presentation" style={noteStyle}>{query.trim() ? t('pickers.noMatch', { query: query.trim() }) : t('pickers.noChoices')}</li>
          )}
          {more > 0 && <li role="presentation" style={noteStyle}>{t('pickers.more', { count: more })}</li>}
        </ul>
      )}
      {hint && <div style={{ marginTop: 4, fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>{hint}</div>}
    </div>
  )
}
