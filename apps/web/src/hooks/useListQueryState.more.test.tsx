/**
 * A LIST'S STATE IN THE ADDRESS: what a hand-edited or old link can carry.
 *
 * A sort with a direction that is neither `asc` nor `desc` is ignored (the
 * list keeps its default order) instead of being sent to the server; a filter
 * that is valid JSON but not a filter group is flagged as unreadable (F-17),
 * so the page can say so instead of silently showing everything.
 */
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useListQueryState } from './useListQueryState'

const state = (route: string) => renderHook(() => useListQueryState({ persistInQuery: true, defaultSortField: 'createdAt', defaultSortDir: 'desc' }), {
  wrapper: ({ children }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>,
}).result.current

describe('useListQueryState — what a link can carry', () => {
  it('a sort with an unknown direction is ignored: the default order stays', () => {
    const s = state('/list?sort=name:sideways')
    expect(s.variables).toMatchObject({ sortField: 'createdAt', sortDirection: 'desc' })
  })

  it('a filter that is JSON but not a group is flagged unreadable, and not applied', () => {
    const s = state(`/list?filters=${encodeURIComponent(JSON.stringify({ field: 'name' }))}`)
    expect(s.filtersInvalid).toBe(true)
    expect(s.filterGroup).toBeNull()
    expect(s.variables.filters).toBeNull()
  })
})
