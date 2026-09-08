/**
 * List page state (E-10): sort + advanced filters + client-side page, with the
 * `variables` object the list queries expect (`sortField`, `sortDirection`,
 * `filters` as JSON string) and the `handleSort` callback `SortableFilterTable`
 * calls. Replaces the `sortField/sortDir/filterGroup/handleSort` quadruple
 * that was copy-pasted in 18 pages.
 *
 *   const list = useListQueryState({ pageSize: 50 })
 *   const { data } = useQuery(GET_X, { variables: list.variables })
 *   <FilterBuilder onApply={list.setFilterGroup} />
 *   <SortableFilterTable onSort={list.handleSort} sortField={list.sortField} sortDir={list.sortDir} … />
 *   const { pageItems, totalPages } = list.paginate(rows)
 *   <Pagination currentPage={list.page + 1} totalPages={totalPages} onPrev={list.prevPage} onNext={list.nextPage} />
 *
 * `persistInQuery: true` mirrors sort/page/filters into the URL query string
 * (`?sort=name:asc&page=2&filters=<json>`) so a reload / shared link restores
 * the same view. Corrupt `filters` in the URL is ignored with a console
 * warning (a shared link must never crash the page).
 */
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { FilterGroup } from '@/components/FilterBuilder'

export type SortDir = 'asc' | 'desc'

export interface ListQueryStateOptions {
  defaultSortField?: string | null
  defaultSortDir?:   SortDir
  /** Client-side page size (default 50). */
  pageSize?:         number
  /** Mirror sort / page / filters in the URL query string. */
  persistInQuery?:   boolean
}

export interface ListQueryVariables {
  sortField:     string | null
  sortDirection: SortDir
  filters:       string | null
}

export interface ListQueryState {
  sortField:      string | null
  sortDir:        SortDir
  filterGroup:    FilterGroup | null
  page:           number
  pageSize:       number
  /** Query variables for the `(filters, sortField, sortDirection)` list resolvers. */
  variables:      ListQueryVariables
  handleSort:     (field: string, dir: SortDir) => void
  setFilterGroup: (group: FilterGroup | null) => void
  setPage:        (page: number) => void
  nextPage:       () => void
  prevPage:       () => void
  /** Client-side pagination of an already-filtered list. */
  paginate:       <T>(items: readonly T[]) => { pageItems: T[]; totalPages: number; total: number }
}

const SORT_KEY = 'sort', PAGE_KEY = 'page', FILTERS_KEY = 'filters'

function parseSort(raw: string | null): { field: string; dir: SortDir } | null {
  if (!raw) return null
  const idx = raw.lastIndexOf(':')
  if (idx <= 0) return null
  const dir = raw.slice(idx + 1)
  if (dir !== 'asc' && dir !== 'desc') return null
  return { field: raw.slice(0, idx), dir }
}

function parseFilters(raw: string | null): FilterGroup | null {
  if (!raw) return null
  try { return JSON.parse(raw) as FilterGroup }
  catch (e) {
    console.warn('[useListQueryState] parametro "filters" non valido nella URL, ignorato', e)
    return null
  }
}

export function useListQueryState(options: ListQueryStateOptions = {}): ListQueryState {
  const { defaultSortField = null, defaultSortDir = 'asc', pageSize = 50, persistInQuery = false } = options
  const [searchParams, setSearchParams] = useSearchParams()

  // Local state is the source of truth when not persisting; with
  // `persistInQuery` the URL is, and the local state is only the initial seed.
  const initialSort = persistInQuery ? parseSort(searchParams.get(SORT_KEY)) : null
  const [localSort, setLocalSort] = useState<{ field: string | null; dir: SortDir }>({
    field: initialSort?.field ?? defaultSortField,
    dir:   initialSort?.dir ?? defaultSortDir,
  })
  const [localFilters, setLocalFilters] = useState<FilterGroup | null>(
    () => persistInQuery ? parseFilters(searchParams.get(FILTERS_KEY)) : null,
  )
  const [localPage, setLocalPage] = useState<number>(() => {
    if (!persistInQuery) return 0
    const n = Number(searchParams.get(PAGE_KEY) ?? '1')
    return Number.isFinite(n) && n >= 1 ? n - 1 : 0
  })

  const urlSort    = persistInQuery ? parseSort(searchParams.get(SORT_KEY)) : null
  const sortField  = persistInQuery ? (urlSort?.field ?? defaultSortField) : localSort.field
  const sortDir    = persistInQuery ? (urlSort?.dir ?? defaultSortDir) : localSort.dir
  const filterGroup = useMemo(
    () => persistInQuery ? parseFilters(searchParams.get(FILTERS_KEY)) : localFilters,
    [persistInQuery, searchParams, localFilters],
  )
  const page = persistInQuery
    ? Math.max(0, (Number(searchParams.get(PAGE_KEY) ?? '1') || 1) - 1)
    : localPage

  const write = useCallback((patch: Record<string, string | null>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [k, val] of Object.entries(patch)) {
        if (val === null) next.delete(k)
        else next.set(k, val)
      }
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setPage = useCallback((p: number) => {
    const safe = Math.max(0, p)
    if (persistInQuery) write({ [PAGE_KEY]: safe === 0 ? null : String(safe + 1) })
    else setLocalPage(safe)
  }, [persistInQuery, write])

  const handleSort = useCallback((field: string, dir: SortDir) => {
    if (persistInQuery) write({ [SORT_KEY]: `${field}:${dir}`, [PAGE_KEY]: null })
    else { setLocalSort({ field, dir }); setLocalPage(0) }
  }, [persistInQuery, write])

  const setFilterGroup = useCallback((group: FilterGroup | null) => {
    if (persistInQuery) write({ [FILTERS_KEY]: group ? JSON.stringify(group) : null, [PAGE_KEY]: null })
    else { setLocalFilters(group); setLocalPage(0) }
  }, [persistInQuery, write])

  const variables = useMemo<ListQueryVariables>(() => ({
    sortField,
    sortDirection: sortDir,
    filters: filterGroup ? JSON.stringify(filterGroup) : null,
  }), [sortField, sortDir, filterGroup])

  const paginate = useCallback(<T,>(items: readonly T[]) => {
    const total = items.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const safePage = Math.min(page, totalPages - 1)
    return { pageItems: items.slice(safePage * pageSize, (safePage + 1) * pageSize), totalPages, total }
  }, [page, pageSize])

  return {
    sortField, sortDir, filterGroup, page, pageSize, variables,
    handleSort, setFilterGroup, setPage,
    nextPage: () => setPage(page + 1),
    prevPage: () => setPage(page - 1),
    paginate,
  }
}
