import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useListQueryState, type ListQueryStateOptions } from './useListQueryState'
import { LocationSpy } from '@/test/utils'
import type { FilterGroup } from '@/components/FilterBuilder'

const GROUP: FilterGroup = { rules: [{ id: 'r1', field: 'name', operator: 'contains', value: 'a', logic: 'AND' }] }

function renderState(options: ListQueryStateOptions = {}, route = '/list') {
  return renderHook(() => useListQueryState(options), {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[route]}>{children}<LocationSpy /></MemoryRouter>,
  })
}
const location = () => screen.getByTestId('location').textContent

describe('useListQueryState — stato locale', () => {
  it('default: nessun sort, asc, pagina 0, pageSize 50, variables coerenti', () => {
    const { result } = renderState()
    expect(result.current).toMatchObject({ sortField: null, sortDir: 'asc', filterGroup: null, page: 0, pageSize: 50 })
    expect(result.current.variables).toEqual({ sortField: null, sortDirection: 'asc', filters: null })
  })

  it('rispetta defaultSortField / defaultSortDir / pageSize', () => {
    const { result } = renderState({ defaultSortField: 'createdAt', defaultSortDir: 'desc', pageSize: 10 })
    expect(result.current.variables).toEqual({ sortField: 'createdAt', sortDirection: 'desc', filters: null })
    expect(result.current.pageSize).toBe(10)
  })

  it('handleSort aggiorna sort e riporta alla pagina 0', () => {
    const { result } = renderState({ pageSize: 1 })
    act(() => result.current.setPage(3))
    expect(result.current.page).toBe(3)
    act(() => result.current.handleSort('name', 'desc'))
    expect(result.current.sortField).toBe('name')
    expect(result.current.sortDir).toBe('desc')
    expect(result.current.page).toBe(0)
    expect(result.current.variables).toEqual({ sortField: 'name', sortDirection: 'desc', filters: null })
  })

  it('setFilterGroup serializza il gruppo nelle variables e resetta la pagina', () => {
    const { result } = renderState()
    act(() => result.current.setPage(2))
    act(() => result.current.setFilterGroup(GROUP))
    expect(result.current.page).toBe(0)
    expect(result.current.filterGroup).toEqual(GROUP)
    expect(result.current.variables.filters).toBe(JSON.stringify(GROUP))
    act(() => result.current.setFilterGroup(null))
    expect(result.current.variables.filters).toBeNull()
  })

  it('nextPage/prevPage: mai sotto zero', () => {
    const { result } = renderState()
    act(() => result.current.prevPage())
    expect(result.current.page).toBe(0)
    act(() => result.current.nextPage())
    act(() => result.current.nextPage())
    expect(result.current.page).toBe(2)
    act(() => result.current.prevPage())
    expect(result.current.page).toBe(1)
  })

  it('paginate affetta la lista e clampa la pagina fuori range', () => {
    const { result } = renderState({ pageSize: 2 })
    const items = ['a', 'b', 'c', 'd', 'e']
    expect(result.current.paginate(items)).toEqual({ pageItems: ['a', 'b'], totalPages: 3, total: 5 })
    act(() => result.current.setPage(2))
    expect(result.current.paginate(items).pageItems).toEqual(['e'])
    act(() => result.current.setPage(99))
    expect(result.current.paginate(items).pageItems).toEqual(['e'])   // ultima pagina
    expect(result.current.paginate([])).toEqual({ pageItems: [], totalPages: 1, total: 0 })
  })

  it('senza persistInQuery la URL non cambia', () => {
    const { result } = renderState()
    act(() => result.current.handleSort('name', 'asc'))
    act(() => result.current.setPage(1))
    expect(location()).toBe('/list')
  })
})

describe('useListQueryState — persistInQuery', () => {
  it('legge sort/page/filters dalla URL iniziale', () => {
    const route = `/list?sort=email:desc&page=3&filters=${encodeURIComponent(JSON.stringify(GROUP))}`
    const { result } = renderState({ persistInQuery: true }, route)
    expect(result.current.sortField).toBe('email')
    expect(result.current.sortDir).toBe('desc')
    expect(result.current.page).toBe(2)          // URL 1-based → stato 0-based
    expect(result.current.filterGroup).toEqual(GROUP)
    expect(result.current.variables.filters).toBe(JSON.stringify(GROUP))
  })

  it('sort malformato in URL → default; filters corrotto → warn e ignorato (la pagina non crolla)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderState({ persistInQuery: true, defaultSortField: 'name' }, '/list?sort=nodir&page=abc&filters={broken')
    expect(result.current.sortField).toBe('name')
    expect(result.current.sortDir).toBe('asc')
    expect(result.current.page).toBe(0)
    expect(result.current.filterGroup).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('parametro "filters" non valido'), expect.anything())
  })

  it('handleSort scrive ?sort= e rimuove page; setPage scrive page 1-based (pagina 0 → nessun parametro)', () => {
    const { result } = renderState({ persistInQuery: true }, '/list?page=4')
    act(() => result.current.handleSort('name', 'desc'))
    expect(location()).toBe('/list?sort=name%3Adesc')
    expect(result.current.page).toBe(0)
    act(() => result.current.setPage(2))
    expect(location()).toBe('/list?sort=name%3Adesc&page=3')
    act(() => result.current.setPage(0))
    expect(location()).toBe('/list?sort=name%3Adesc')
  })

  it('setFilterGroup scrive/rimuove ?filters= e resetta la pagina', () => {
    const { result } = renderState({ persistInQuery: true }, '/list?page=2')
    act(() => result.current.setFilterGroup(GROUP))
    expect(location()).toBe(`/list?filters=${encodeURIComponent(JSON.stringify(GROUP)).replace(/%20/g, '+')}`)
    expect(result.current.filterGroup).toEqual(GROUP)
    act(() => result.current.setFilterGroup(null))
    expect(location()).toBe('/list')
  })
})
